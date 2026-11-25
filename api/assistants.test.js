import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { assistantFor, isUnscoped, scopedUserId, splitUserId, storeUserId } from "./connections/_assistants.js";

// The in-memory store must be chosen before the server module creates its store.
process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
const { default: app, testSupport } = await import("./index.js");
const store = testSupport.connectionStore;

let server, baseUrl;
const realFetch = globalThis.fetch;
before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = baseUrl;
});
after(async () => { globalThis.fetch = realFetch; await new Promise(resolve => server.close(resolve)); });

const ACCOUNT = "0123456789abcdef0123456789abcdef";
function tokenFor(userId) {
  const sessionId = `s-${Math.random()}`;
  const google = { sessionId, refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId };
  const session = testSupport.saveSession(sessionId, google);
  return testSupport.mintAccessToken({ protocol: "http", get: () => new URL(baseUrl).host }, { sessionId, resource: `${baseUrl}/mcp`, scope: session.scope, google: session });
}
async function manage(userId) {
  const response = await realFetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenFor(userId)}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "manage_connections", arguments: {} } })
  });
  return (await response.json()).result;
}
const bing = { label: "1 verified site", credentials: { apiKey: "k" } };

test("each assistant is named from the redirect address it registered for sign-in", () => {
  assert.equal(assistantFor("https://claude.ai/api/mcp/auth_callback"), "claude");
  assert.equal(assistantFor("https://claude.com/api/mcp/auth_callback"), "claude");
  assert.equal(assistantFor("https://chatgpt.com/connector_platform_oauth_redirect"), "chatgpt");
  assert.equal(assistantFor("https://chat.openai.com/aip/g-123/oauth/callback"), "chatgpt");
  assert.equal(assistantFor("http://127.0.0.1:33418/callback"), "local");
  assert.equal(assistantFor("http://localhost:6274/oauth/callback"), "local");
  assert.equal(assistantFor("cursor://anysphere.cursor-retrieval/oauth/callback"), "cursor");
  assert.equal(assistantFor("https://insiders.vscode.dev/redirect"), "vscode");
  assert.equal(assistantFor(null), "web");
  assert.equal(assistantFor("not a url"), "other");

  assert.equal(scopedUserId(ACCOUNT, "claude"), `${ACCOUNT}-claude`);
  assert.deepEqual(splitUserId(`${ACCOUNT}-chatgpt`), { account: ACCOUNT, assistant: "chatgpt", name: "ChatGPT" });
  assert.equal(splitUserId(ACCOUNT), null);
  assert.equal(storeUserId(ACCOUNT), null, "a sign-in from before the split opens no store");
  assert.equal(storeUserId(`${ACCOUNT}-claude`), `${ACCOUNT}-claude`);
  assert.ok(isUnscoped(ACCOUNT));
});

test("the same Google account in Claude and ChatGPT keeps two separate lists", async () => {
  const account = "1".repeat(32);
  await store.save(`${account}-claude`, "bing_webmaster", bing);
  const claude = (await manage(`${account}-claude`)).structuredContent;
  const chatgpt = (await manage(`${account}-chatgpt`)).structuredContent;
  assert.equal(claude.assistant, "Claude");
  assert.deepEqual(claude.connected.map(c => c.id), ["bing_webmaster"]);
  assert.equal(chatgpt.assistant, "ChatGPT");
  assert.deepEqual(chatgpt.connected, [], "ChatGPT doesn't see what was added in Claude");

  const t = new URL(chatgpt.manageUrl).searchParams.get("t");
  const html = await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text();
  assert.match(html, /Only ChatGPT sees them/);
  assert.match(html, /ChatGPT only/);
  assert.doesNotMatch(html, /1 verified site/);
});

test("a sign-in from before the split is asked to reconnect for connected platforms", async () => {
  const outcome = await manage("2".repeat(32));
  assert.equal(outcome.isError, true);
  assert.equal(outcome.structuredContent.error, "reconnect_required");
});

test("earlier connections are moved to one assistant on request, and only there", async () => {
  const account = "3".repeat(32);
  await store.save(account, "bing_webmaster", bing);
  await store.save(account, "clarity:p1", { label: "Site", credentials: { token: "x" } });
  await store.addSnapshotTarget(account, "clarity:p1");
  await store.saveSnapshot(account, "clarity:p1", "2026-11-20", { metrics: [1] });
  await store.saveProfile(account, { slug: "client-aaaaaa", name: "Client", accounts: { google: "main" }, accountLabels: {}, platforms: [], defaults: {} });

  const chatgpt = (await manage(`${account}-chatgpt`)).structuredContent;
  assert.equal(chatgpt.earlierConnections, 3);
  assert.match(chatgpt.earlierNote, /Move them here/);
  const t = new URL(chatgpt.manageUrl).searchParams.get("t");
  const page = await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text();
  assert.match(page, /Move your earlier connections here\?/);
  assert.match(page, /3 connections from before each assistant kept its own/);

  const move = await realFetch(`${baseUrl}/connections/claim?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual" });
  assert.equal(move.status, 303);
  assert.match(move.headers.get("location"), /moved=3/);
  const after = await (await realFetch(new URL(move.headers.get("location"), baseUrl))).text();
  assert.match(after, /Moved 3 connections to ChatGPT/);
  assert.doesNotMatch(after, /Move your earlier connections here/);

  assert.deepEqual((await store.list(`${account}-chatgpt`)).sort(), ["bing_webmaster", "clarity:p1"]);
  assert.equal((await store.listProfiles(`${account}-chatgpt`)).length, 1);
  assert.deepEqual((await store.getSnapshot(`${account}-chatgpt`, "clarity:p1", "2026-11-20")).metrics, [1], "Clarity history moves too");
  assert.ok((await store.snapshotTargets()).some(target => target.userId === `${account}-chatgpt`));
  assert.deepEqual(await store.list(account), [], "nothing is left to share");
  assert.equal((await manage(`${account}-claude`)).structuredContent.earlierConnections, undefined, "Claude no longer offers them");
  assert.deepEqual((await manage(`${account}-claude`)).structuredContent.connected, []);
});
