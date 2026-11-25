// Tasks (io.modelcontextprotocol/tasks, protocol 2026-07-28) for long-running tool calls, built for
// serverless: there are no background workers, so the client's own polling drives the work. Each
// tasks/get runs the next bounded slice (for example the next ~25 s of a YouTube upload) and stores
// where it got to. A tool opts in by attaching a continuation to its normal result:
//
//   return withContinuation(result(progress), { tool: "youtube_continue_upload", args: { sessionUrl, videoUrl }, statusMessage });
//
// - A client that declared the tasks extension gets a task back, and tasks/get keeps calling the
//   continuation tool until it returns a result without one.
// - Every other client gets the original result unchanged (the continuation is a Symbol, so it is
//   never serialized) and keeps continuing by hand exactly as before.
// Continuation steps must be idempotent: a slice that runs twice must not do the work twice.
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const CONTINUATION = Symbol("taskContinuation");
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const LOCK_SECONDS = 120;
// About 2.5 hours of 25-second slices; a task still working after that is failed rather than polled forever.
const MAX_STEPS = 400;
// Arguments that pick the account or channel: carried from the first call into every step.
const ROUTING_ARGS = ["account", "channel"];

// How long one slice may run. Tools that loop until a deadline (uploads) read it.
const stepContext = new AsyncLocalStorage();
export const stepBudgetMs = () => stepContext.getStore()?.budgetMs;
const STEP_BUDGET_MS = () => Number(process.env.TASK_STEP_BUDGET_MS || 25_000);

export function withContinuation(result, continuation) {
  if (result && typeof result === "object") result[CONTINUATION] = continuation;
  return result;
}
export const continuationOf = result => result?.[CONTINUATION];

export function clientSupportsTasks(ctx) {
  const fromEnvelope = ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_KEY];
  const fromMeta = ctx?.mcpReq?._meta?.[CLIENT_CAPABILITIES_KEY];
  return Boolean((fromEnvelope || fromMeta)?.extensions?.[TASKS_EXTENSION_ID]);
}

const now = () => new Date().toISOString();
const publicTask = record => ({
  taskId: record.taskId,
  status: record.status,
  ...(record.statusMessage ? { statusMessage: record.statusMessage } : {}),
  createdAt: record.createdAt,
  lastUpdatedAt: record.lastUpdatedAt,
  ttlMs: TASK_TTL_MS,
  ...(record.status === "working" ? { pollIntervalMs: POLL_INTERVAL_MS } : {}),
  ...(record.status === "completed" ? { result: record.result } : {}),
  ...(record.status === "failed" ? { error: record.error } : {})
});

// Plain JSON copy of a tool result (drops the Symbol and anything non-serializable).
const plain = result => JSON.parse(JSON.stringify(result));

function invalidParams(message) {
  const error = new Error(message);
  error.code = -32602;
  return error;
}

/**
 * Makes the tools in `taskTools` task-capable on `server` and answers tasks/get and tasks/cancel.
 * Call before any tool is registered. `store` is the connection store (Redis); `userId()` resolves
 * the signed-in user, who alone can see their tasks.
 */
export function enableTasks(server, { store, userId, taskTools }) {
  const handlers = new Map();
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => {
    if (!taskTools.has(name) || typeof handler !== "function") return register(name, config, handler);
    handlers.set(name, handler);
    return register(name, config, async (args, ctx) => {
      if (!clientSupportsTasks(ctx)) return handler(args, ctx);
      const result = await stepContext.run({ budgetMs: STEP_BUDGET_MS() }, () => handler(args, ctx));
      const next = continuationOf(result);
      if (!next) return result;
      const owner = await userId();
      if (!owner) return result;
      const routing = Object.fromEntries(ROUTING_ARGS.filter(key => args?.[key] !== undefined).map(key => [key, args[key]]));
      const record = {
        taskId: crypto.randomUUID(), status: "working", statusMessage: next.statusMessage,
        createdAt: now(), lastUpdatedAt: now(),
        step: { tool: next.tool, args: { ...routing, ...next.args } }, routing
      };
      try {
        await store.saveTask(owner, record.taskId, record, TASK_TTL_MS / 1000);
      } catch {
        return result; // No durable store right now: fall back to the plain result.
      }
      return { resultType: "task", ...publicTask(record) };
    });
  };

  // Runs one slice of a working task, unless another poll holds it.
  async function advance(owner, record, ctx) {
    if (record.status !== "working") return record;
    if (!(await store.lockTask(owner, record.taskId, LOCK_SECONDS))) return record;
    try {
      const handler = handlers.get(record.step.tool);
      let next = { ...record, lastUpdatedAt: now() };
      if ((record.steps || 0) >= MAX_STEPS) {
        next = { ...next, status: "failed", error: { code: -32603, message: `Stopped after ${MAX_STEPS} steps without finishing.` } };
      } else if (!handler) {
        next = { ...next, status: "failed", error: { code: -32603, message: `${record.step.tool} is not available on this connector.` } };
      } else {
        try {
          const result = await stepContext.run({ budgetMs: STEP_BUDGET_MS() }, () => handler(record.step.args, ctx));
          const more = continuationOf(result);
          next = more
            ? { ...next, steps: (record.steps || 0) + 1, statusMessage: more.statusMessage, step: { tool: more.tool, args: { ...record.routing, ...more.args } } }
            : { ...next, status: "completed", statusMessage: result?.isError ? "Finished with an error" : "Done", result: plain(result), step: undefined };
        } catch (error) {
          next = { ...next, status: "failed", error: { code: -32603, message: error?.message || String(error) }, step: undefined };
        }
      }
      const latest = await store.getTask(owner, record.taskId);
      if (latest?.status === "cancelled") return latest; // Cancelled while this slice ran.
      await store.saveTask(owner, record.taskId, next, TASK_TTL_MS / 1000);
      return next;
    } finally {
      await store.unlockTask(owner, record.taskId).catch(() => {});
    }
  }

  async function load(taskId) {
    const owner = await userId();
    const record = owner ? await store.getTask(owner, taskId) : null;
    if (!record) throw invalidParams(`Unknown task: ${taskId}`);
    return { owner, record };
  }

  const taskParams = z.object({ taskId: z.string().min(1).max(128) }).passthrough();
  server.server.setRequestHandler("tasks/get", { params: taskParams }, async (params, ctx) => {
    const { owner, record } = await load(params.taskId);
    return publicTask(await advance(owner, record, ctx));
  });
  server.server.setRequestHandler("tasks/cancel", { params: taskParams }, async params => {
    const { owner, record } = await load(params.taskId);
    if (record.status === "working") await store.saveTask(owner, record.taskId, { ...record, status: "cancelled", statusMessage: "Cancelled", lastUpdatedAt: now(), step: undefined }, TASK_TTL_MS / 1000);
    return {};
  });
  server.server.setRequestHandler("tasks/update", { params: taskParams.extend({ inputResponses: z.record(z.string(), z.unknown()).optional() }) }, async params => {
    await load(params.taskId);
    throw invalidParams("This task does not ask for input.");
  });
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });
}
