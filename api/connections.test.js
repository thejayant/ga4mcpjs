import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { bingDate } from "./connections/providers.js";
import { createConnectionStore, memoryStore } from "./connections/store.js";

// The in-memory store must be chosen before the server module creates its store.
process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
const { default: app, testSupport } = await import("./index.js");

let server, baseUrl;
const realFetch = globalThis.fetch;
before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = baseUrl;
});
after(async () => { globalThis.fetch = realFetch; await new Promise(resolve => server.close(resolve)); });

// A connection token for a signed-in user; userId null plays a connection made before IDs existed.
function tokenFor(userId) {
  const sessionId = `s-${Math.random()}`;
  const google = { sessionId, refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId };
  const session = testSupport.saveSession(sessionId, google);
  const resource = `${baseUrl}/mcp`;
  return testSupport.mintAccessToken({ protocol: "http", get: () => new URL(baseUrl).host }, { sessionId, resource, scope: session.scope, google: session });
}

// Calls a tool through the MCP endpoint; `upstream` answers any call that leaves this server.
async function callTool(token, name, args = {}, upstream) {
  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) || !upstream ? realFetch(url, init) : upstream(String(url), init);
  try {
    const response = await realFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    });
    return (await response.json()).result;
  } finally { globalThis.fetch = realFetch; }
}

const bingSites = async () => new Response(JSON.stringify({ d: [{ __type: "Site", Url: "https://www.getcarports.com/", IsVerified: true }] }), { status: 200 });

test("connections encrypt their values and list per user", async () => {
  const raw = memoryStore();
  const store = createConnectionStore({ seal: testSupport.encryptJson, open: testSupport.decryptJson, backend: raw });
  await store.save("u1", "bing_webmaster", { credentials: { apiKey: "secret-key-123" } });
  assert.deepEqual(await store.list("u1"), ["bing_webmaster"]);
  assert.equal((await store.get("u1", "bing_webmaster")).credentials.apiKey, "secret-key-123");
  assert.ok(!(await raw.get("conn:u1:bing_webmaster")).includes("secret-key-123"), "stored value is encrypted");
  assert.deepEqual(await store.list("u2"), [], "another user sees nothing");
  await store.remove("u1", "bing_webmaster");
  assert.equal(await store.get("u1", "bing_webmaster"), null);
});

test("Bing WCF dates become plain dates", () => {
  assert.equal(bingDate("/Date(1727827200000-0700)/"), "2024-10-02");
});

test("connections made before user IDs keep working but are asked to reconnect once for new platforms", async () => {
  const result = await callTool(tokenFor(null), "manage_connections");
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "reconnect_required");
});

test("manage_connections gives a private link; the page connects Bing with a checked key and disconnects it", async () => {
  const token = tokenFor("user-a");
  const managed = (await callTool(token, "manage_connections")).structuredContent;
  assert.deepEqual(managed.connected, []);
  assert.ok(managed.available.some(p => p.provider === "clarity"));
  const pageUrl = managed.manageUrl.replace(/^https?:\/\/[^/]+/, baseUrl);
  const t = new URL(pageUrl).searchParams.get("t");

  const page = await realFetch(pageUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Bing Webmaster Tools/);
  assert.equal((await realFetch(`${baseUrl}/connections?t=forged`)).status, 401, "a forged link is refused");

  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) ? realFetch(url, init) : bingSites();
  const connect = await realFetch(`${baseUrl}/connections/bing_webmaster?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "apiKey=key-123" });
  globalThis.fetch = realFetch;
  assert.equal(connect.status, 303);
  assert.match(connect.headers.get("location"), /connected=bing_webmaster/);
  const after = await (await realFetch(pageUrl)).text();
  assert.match(after, /Connected · 1 verified site/);
  assert.ok(!after.includes("key-123"), "the saved key is never shown");

  const sites = await callTool(token, "bing_webmaster_sites", {}, async url => { assert.match(url, /GetUserSites\?apikey=key-123/); return bingSites(); });
  assert.deepEqual(sites.structuredContent.sites, [{ url: "https://www.getcarports.com/", verified: true }]);
  const otherUser = await callTool(tokenFor("user-b"), "bing_webmaster_sites");
  assert.equal(otherUser.structuredContent.error, "not_connected", "connections are per user");
  assert.match(otherUser.structuredContent.connectUrl, /\/connections\?t=/);

  const disconnect = await realFetch(`${baseUrl}/connections/bing_webmaster/disconnect?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual" });
  assert.equal(disconnect.status, 303);
  assert.equal((await callTool(token, "bing_webmaster_sites")).structuredContent.error, "not_connected");
});

test("a rejected Bing key is not saved", async () => {
  const managed = (await callTool(tokenFor("user-c"), "manage_connections")).structuredContent;
  const t = new URL(managed.manageUrl).searchParams.get("t");
  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) ? realFetch(url, init) : Promise.resolve(new Response("{}", { status: 401 }));
  const connect = await realFetch(`${baseUrl}/connections/bing_webmaster?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "apiKey=bad" });
  globalThis.fetch = realFetch;
  assert.equal(new URL(connect.headers.get("location"), baseUrl).searchParams.get("error"), "Bing rejected this API key.");
  assert.deepEqual((await callTool(tokenFor("user-c"), "manage_connections")).structuredContent.connected, [], "nothing saved");
});

test("Clarity answers repeat questions from a one-hour cache to protect its 10-a-day limit", async () => {
  const token = tokenFor("user-d");
  const t = new URL((await callTool(token, "manage_connections")).structuredContent.manageUrl).searchParams.get("t");
  await realFetch(`${baseUrl}/connections/clarity?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=aaa.bbb.ccc" });
  let calls = 0;
  const clarity = async url => { calls++; assert.match(url, /numOfDays=2&dimension1=Device/); return new Response(JSON.stringify([{ metricName: "Traffic", information: [{ totalSessionCount: "120", Device: "Mobile" }] }]), { status: 200 }); };
  const first = await callTool(token, "clarity_insights", { numOfDays: 2, dimensions: ["Device"] }, clarity);
  const second = await callTool(token, "clarity_insights", { numOfDays: 2, dimensions: ["Device"] }, clarity);
  assert.equal(calls, 1);
  assert.equal(first.structuredContent.servedFromCache, false);
  assert.equal(second.structuredContent.servedFromCache, true);
  assert.equal(second.structuredContent.metrics[0].metricName, "Traffic");
  const limited = await callTool(token, "clarity_insights", { numOfDays: 1 }, async () => new Response("Exceeded daily limit", { status: 429 }));
  assert.equal(limited.structuredContent.error, "daily_limit");
});

test("the store is found whatever prefix Vercel's integration used", async () => {
  const { redisConfig } = await import("./connections/store.js");
  assert.deepEqual(redisConfig({ STORAGE_REST_API_URL: "https://a.upstash.io/", STORAGE_REST_API_TOKEN: "t", STORAGE_REST_API_READ_ONLY_TOKEN: "r" }), { url: "https://a.upstash.io", token: "t" });
  assert.deepEqual(redisConfig({ KV_REST_API_URL: "https://b.upstash.io", KV_REST_API_TOKEN: "k" }), { url: "https://b.upstash.io", token: "k" });
  assert.equal(redisConfig({ STORAGE_REST_API_URL: "https://a.upstash.io" }), null, "no token, no store");
});
