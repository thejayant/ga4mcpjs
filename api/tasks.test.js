// MCP tasks over the real endpoint: a 2026-07-28 client that declares the tasks extension gets a
// task for a long YouTube upload and drives it to completion by polling tasks/get; older clients
// get the same plain result as before. Wire shapes are checked with the official ext-tasks schemas.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isCreateTaskResultV2, isDetailedTaskV2 } from "@modelcontextprotocol/ext-tasks/core/v2";

process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.TASK_STEP_BUDGET_MS = "40";
process.env.YOUTUBE_UPLOAD_BUDGET_MS = "40";
const { default: app, testSupport } = await import("./index.js");
const store = testSupport.connectionStore;

const realFetch = globalThis.fetch;
let server, baseUrl;
before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = baseUrl;
  for (const user of ["task-user", "other-user"]) {
    await store.save(user, "youtube:a", { label: "Gaming", oauth: { accessToken: "yt-access", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }, meta: { channelId: "UC_a", title: "Gaming" } });
  }
});
after(async () => { globalThis.fetch = realFetch; await new Promise(resolve => server.close(resolve)); });

function tokenFor(userId) {
  const sessionId = `s-${Math.random()}`;
  const google = { sessionId, refreshToken: "r", accessToken: "main", expiryDate: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId };
  const session = testSupport.saveSession(sessionId, google);
  return testSupport.mintAccessToken({ protocol: "http", get: () => new URL(baseUrl).host }, { sessionId, resource: `${baseUrl}/mcp`, scope: session.scope, google: session });
}

// A video host and a YouTube resumable session that takes 1000 bytes per PUT, then stalls until the
// step's time budget aborts it, so a 3000-byte upload needs several slices.
const TOTAL = 3000;
function fakeUpload() {
  const state = { received: 0, puts: 0 };
  const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc";
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith(baseUrl)) return realFetch(url, init);
    if (url.startsWith("https://videos.example.com/")) {
      const range = init.headers?.Range;
      const from = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
      return new Response(new Uint8Array(TOTAL - from), { status: range ? 206 : 200, headers: { "content-type": "video/mp4", "content-length": String(TOTAL - from), ...(range ? { "content-range": `bytes ${from}-${TOTAL - 1}/${TOTAL}` } : {}) } });
    }
    if (url.includes("uploadType=resumable&part=")) return new Response("{}", { status: 200, headers: { location: SESSION } });
    if (url === SESSION) {
      const contentRange = init.headers["Content-Range"];
      if (contentRange.startsWith("bytes */")) {
        if (state.received >= TOTAL) return new Response(JSON.stringify({ id: "vid12345678", snippet: { title: "Clip" }, status: { privacyStatus: "private", uploadStatus: "uploaded" } }), { status: 201 });
        return new Response(null, { status: 308, headers: state.received ? { range: `bytes=0-${state.received - 1}` } : {} });
      }
      state.puts++;
      await init.body?.cancel?.();
      state.received = Math.min(TOTAL, state.received + 1000);
      if (state.received >= TOTAL) return new Response(JSON.stringify({ id: "vid12345678", snippet: { title: "Clip" }, status: { privacyStatus: "private", uploadStatus: "uploaded" } }), { status: 201 });
      await new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    }
    throw new Error(`unexpected ${init.method || "GET"} ${url}`);
  };
  return state;
}

async function connect(userId, { tasks = true } = {}) {
  const client = new Client({ name: "test", version: "1" }, {
    versionNegotiation: { mode: "auto" },
    capabilities: tasks ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {}
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokenFor(userId)}` } } }));
  return client;
}
// A raw 2026-07-28 request (the SDK client rejects a task result for tools/call, so the wire is used directly).
async function modern(userId, method, params, { tasks = true } = {}) {
  const response = await realFetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens[userId] ||= tokenFor(userId)}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(params.name || params.taskId ? { "Mcp-Name": params.name || params.taskId } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": tasks ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {}
    } } })
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const tokens = {};
const upload = { title: "Clip", videoUrl: "https://videos.example.com/clip.mp4" };

test("a tasks-capable client gets a task and finishes the upload by polling tasks/get", async () => {
  const state = fakeUpload();
  const client = await connect("task-user");
  try {
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    assert.ok(client.getServerCapabilities().extensions?.["io.modelcontextprotocol/tasks"]);
    const created = await modern("task-user", "tools/call", { name: "youtube_upload_video", arguments: upload });
    assert.equal(created.resultType, "task");
    assert.ok(isCreateTaskResultV2(created), "CreateTaskResult matches the tasks extension schema");
    assert.equal(created.status, "working");
    assert.match(created.statusMessage, /Uploaded 33%/);
    let task = created;
    for (let polls = 0; task.status === "working" && polls < 10; polls++) {
      task = await modern("task-user", "tasks/get", { taskId: created.taskId });
      assert.ok(isDetailedTaskV2(task), `tasks/get matches the schema (${task.status})`);
    }
    assert.equal(task.status, "completed");
    assert.equal(task.result.structuredContent.videoId, "vid12345678");
    assert.equal(state.received, TOTAL);
    // Finished tasks answer without doing any more work.
    const again = await modern("task-user", "tasks/get", { taskId: created.taskId });
    assert.equal(again.status, "completed");
  } finally {
    await client.close();
  }
});

test("tasks belong to their user and can be cancelled", async () => {
  fakeUpload();
  const created = await modern("task-user", "tools/call", { name: "youtube_upload_video", arguments: upload });
  await assert.rejects(modern("other-user", "tasks/get", { taskId: created.taskId }), /Unknown task/);
  await modern("task-user", "tasks/cancel", { taskId: created.taskId });
  const task = await modern("task-user", "tasks/get", { taskId: created.taskId });
  assert.equal(task.status, "cancelled");
  assert.ok(isDetailedTaskV2(task));
  await assert.rejects(modern("task-user", "tasks/get", { taskId: "no-such-task" }), /Unknown task/);
});

test("clients without the tasks extension get the same in-progress result as before", async () => {
  fakeUpload();
  const modern = await connect("task-user", { tasks: false });
  try {
    const result = await modern.callTool({ name: "youtube_upload_video", arguments: upload });
    assert.equal(result.structuredContent.status, "in_progress");
    assert.match(result.structuredContent.sessionUrl, /upload_id=abc/);
    assert.match(result.structuredContent.next, /youtube_continue_upload/);
  } finally {
    await modern.close();
  }
  fakeUpload();
  const response = await realFetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenFor("task-user")}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "youtube_upload_video", arguments: upload } })
  });
  const legacy = (await response.json()).result;
  assert.equal(legacy.structuredContent.status, "in_progress");
  assert.equal(legacy.resultType, undefined);
});

test("a GA4 audience export runs as a task until the export is ACTIVE", async () => {
  let gets = 0;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith(baseUrl)) return realFetch(url, init);
    const exportName = "properties/123/audienceExports/9";
    if (url.endsWith("/properties/123/audienceExports") && init.method === "POST") {
      return new Response(JSON.stringify({ name: "properties/123/operations/op-1", response: { "@type": "type.googleapis.com/google.analytics.data.v1beta.AudienceExport", name: exportName, state: "CREATING" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith(`/${exportName}`)) {
      gets++;
      return new Response(JSON.stringify({ name: exportName, state: gets < 2 ? "CREATING" : "ACTIVE", percentageCompleted: gets < 2 ? 50 : 100, rowCount: 42 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected ${init.method || "GET"} ${url}`);
  };
  const created = await modern("task-user", "tools/call", { name: "run_ga4_audience_export", arguments: { propertyId: "123", action: "create", audience: "properties/123/audiences/7" } });
  assert.equal(created.resultType, "task");
  assert.match(created.statusMessage, /starting|building/);
  let task = created;
  for (let polls = 0; task.status === "working" && polls < 5; polls++) task = await modern("task-user", "tasks/get", { taskId: created.taskId });
  assert.equal(task.status, "completed");
  assert.equal(task.result.structuredContent.raw.state, "ACTIVE");
  assert.equal(gets, 2);
});
