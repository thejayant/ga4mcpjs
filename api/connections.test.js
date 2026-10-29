import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { bingDate } from "./connections/providers.js";
import { createConnectionStore, memoryStore } from "./connections/store.js";
import { createAccountRouter, resourceKeys } from "./connections/routing.js";

// The in-memory store must be chosen before the server module creates its store.
process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
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

test("YouTube connects by Google sign-in, names the channel, reports, and refreshes its token", async () => {
  const token = tokenFor("user-yt");
  const t = new URL((await callTool(token, "manage_connections")).structuredContent.manageUrl).searchParams.get("t");
  const page = await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text();
  assert.match(page, /Connect with Google/);

  const start = await realFetch(`${baseUrl}/connections/youtube/start?t=${encodeURIComponent(t)}`, { redirect: "manual" });
  const consent = new URL(start.headers.get("location"));
  assert.equal(consent.origin + consent.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.match(consent.searchParams.get("scope"), /yt-analytics\.readonly/);
  assert.equal(consent.searchParams.get("redirect_uri"), `${baseUrl}/connections/oauth/callback`);
  assert.equal(consent.searchParams.get("access_type"), "offline");
  const state = consent.searchParams.get("state");

  // Google returns a code; the server swaps it for tokens and asks YouTube which channel was shared.
  const google = async (url, init) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const form = new URLSearchParams(init.body);
      return new Response(JSON.stringify(form.get("grant_type") === "authorization_code"
        ? { access_token: "yt-access-1", refresh_token: "yt-refresh", expires_in: 3600 }
        : { access_token: "yt-access-2", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("/youtube/v3/channels")) return new Response(JSON.stringify({ items: [{ id: "UC1", snippet: { title: "Get Carports TV" }, statistics: { subscriberCount: "1520" } }] }), { status: 200 });
    if (url.includes("/youtube/v3/videos")) return new Response(JSON.stringify({ items: [{ id: "vid1", snippet: { title: "Carport install timelapse", publishedAt: "2026-09-02T10:00:00Z" } }] }), { status: 200 });
    if (url.startsWith("https://youtubeanalytics.googleapis.com/v2/reports")) {
      const params = new URL(url).searchParams;
      if (params.get("dimensions") === "video") return new Response(JSON.stringify({ columnHeaders: [{ name: "video" }, { name: "views" }], rows: [["vid1", 900]] }), { status: 200 });
      if (params.get("dimensions") === "day") return new Response(JSON.stringify({ columnHeaders: [{ name: "day" }, { name: "views" }], rows: [["2026-10-01", 40], ["2026-10-02", 55]] }), { status: 200 });
      return new Response(JSON.stringify({ columnHeaders: [{ name: "views" }, { name: "subscribersGained" }], rows: [[1234, 18]] }), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) ? realFetch(url, init) : google(String(url), init);
  const callback = await realFetch(`${baseUrl}/connections/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  globalThis.fetch = realFetch;
  assert.equal(callback.status, 303);
  assert.match(callback.headers.get("location"), /connected=youtube/);
  assert.match(await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text(), /Connected · Get Carports TV · 1,520 subscribers/);

  const report = (await callTool(token, "youtube_channel_report", { startDate: "2026-10-01", endDate: "2026-10-02" }, google)).structuredContent;
  assert.equal(report.channel, "Get Carports TV");
  assert.equal(report.totals.views, 1234);
  assert.deepEqual(report.daily.map(row => row.views), [40, 55]);
  const top = (await callTool(token, "youtube_top_videos", {}, google)).structuredContent;
  assert.equal(top.videos[0].title, "Carport install timelapse");
  assert.equal(top.videos[0].url, "https://www.youtube.com/watch?v=vid1");

  // An expired access token is refreshed with the stored refresh token.
  let refreshed = false;
  const expiring = async (url, init) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) { refreshed = true; assert.equal(new URLSearchParams(init.body).get("refresh_token"), "yt-refresh"); }
    if (url.startsWith("https://youtubeanalytics.googleapis.com/")) assert.equal(init.headers.Authorization, refreshed ? "Bearer yt-access-2" : "Bearer yt-access-1");
    return google(url, init);
  };
  // Make the stored token look expired by connecting again with a 0-second token.
  const zero = async (url, init) => url.startsWith("https://oauth2.googleapis.com/token") ? new Response(JSON.stringify({ access_token: "yt-access-1", refresh_token: "yt-refresh", expires_in: 0 }), { status: 200 }) : google(url, init);
  const restart = new URL((await realFetch(`${baseUrl}/connections/youtube/start?t=${encodeURIComponent(t)}`, { redirect: "manual" })).headers.get("location")).searchParams.get("state");
  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) ? realFetch(url, init) : zero(String(url), init);
  await realFetch(`${baseUrl}/connections/oauth/callback?code=abc&state=${encodeURIComponent(restart)}`, { redirect: "manual" });
  globalThis.fetch = realFetch;
  await callTool(token, "youtube_channel_report", {}, expiring);
  assert.equal(refreshed, true, "the expired token was refreshed");
});

test("a cancelled or forged YouTube sign-in saves nothing", async () => {
  const token = tokenFor("user-yt2");
  const t = new URL((await callTool(token, "manage_connections")).structuredContent.manageUrl).searchParams.get("t");
  const state = new URL((await realFetch(`${baseUrl}/connections/youtube/start?t=${encodeURIComponent(t)}`, { redirect: "manual" })).headers.get("location")).searchParams.get("state");
  const cancelled = await realFetch(`${baseUrl}/connections/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  assert.match(new URL(cancelled.headers.get("location"), baseUrl).searchParams.get("error"), /access was not granted/);
  assert.equal((await realFetch(`${baseUrl}/connections/oauth/callback?code=x&state=forged`, { redirect: "manual" })).status, 401);
  assert.equal((await callTool(token, "youtube_channel_report")).structuredContent.error, "not_connected");
});

/* ---------------- Extra Google, Meta and CallRail accounts ---------------- */

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const linkFor = async token => new URL((await callTool(token, "manage_connections")).structuredContent.manageUrl).searchParams.get("t");
// Follows a sign-in from the Connections page through the callback with `upstream` answering the platform.
async function signIn(t, provider, upstream) {
  const start = await realFetch(`${baseUrl}/connections/${provider}/start?t=${encodeURIComponent(t)}`, { redirect: "manual" });
  const consent = new URL(start.headers.get("location"));
  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) ? realFetch(url, init) : upstream(String(url), init);
  try {
    const callback = await realFetch(`${baseUrl}/connections/oauth/callback?code=abc&state=${encodeURIComponent(consent.searchParams.get("state"))}`, { redirect: "manual" });
    return { consent, location: callback.headers.get("location") };
  } finally { globalThis.fetch = realFetch; }
}

test("the router keys requests by the IDs they name and keeps the main sign-in when nothing else matches", async () => {
  assert.deepEqual(resourceKeys("google", { propertyId: "properties/123", siteUrl: "https://www.Example.com/" }), ["ga4:123", "gsc:example.com"]);
  assert.deepEqual(resourceKeys("google", { gbpLocation: "accounts/55/locations/9" }), ["gbp:55"]);
  assert.deepEqual(resourceKeys("meta", { adAccountId: "act_42" }), ["ad:42"]);
  assert.deepEqual(resourceKeys("callrail", { callrailAccountId: "ACC1:COM2" }), ["cr:ACC1"]);

  const store = createConnectionStore({ seal: testSupport.encryptJson, open: testSupport.decryptJson, backend: memoryStore() });
  let listed = 0, failing = true;
  const router = createAccountRouter({
    store, labels: { main: () => "Main" },
    listers: { google: async ({ accessToken }) => { listed++; if (accessToken === "extra" && failing) throw new Error("down"); return accessToken === "main" ? ["ga4:1"] : ["ga4:2"]; } },
    credentialsFor: async () => ({ accessToken: "extra" })
  });
  const choose = args => router.choose({ userId: "u", family: "google", args, primary: { accessToken: "main" } });
  assert.equal(await choose({ propertyId: "2" }), null, "no extra accounts: the main sign-in, nothing listed");
  assert.equal(listed, 0);
  await store.save("u", "google_account:x", { label: "agency@example.com", oauth: {} });
  assert.equal(await choose({ propertyId: "2" }), null, "an account that failed to list is skipped");
  failing = false;
  assert.equal((await choose({ propertyId: "2" })).label, "agency@example.com", "a failed listing is not cached");
  assert.equal(await choose({ propertyId: "1" }), null, "the main sign-in keeps what it can see");
  const before = listed;
  await choose({ propertyId: "2" });
  assert.equal(listed, before, "listings are cached");
  assert.equal((await router.choose({ userId: "u", family: "google", args: { propertyId: "1" }, account: "AGENCY@example.com", primary: { accessToken: "main" } })).label, "agency@example.com", "an explicit account wins");
  await assert.rejects(router.choose({ userId: "u", family: "google", account: "nobody", primary: { accessToken: "main" } }), /No connected google account called "nobody"/);
});

test("extra Google accounts: each GA4 property is read with the login that can see it", async () => {
  const token = tokenFor("user-google-multi");
  const t = await linkFor(token);
  assert.match(await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text(), /Add a Google account/);
  const added = await signIn(t, "google_account", async (url, init) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "g2-access", refresh_token: "g2-refresh", expires_in: 3600 });
    if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) { assert.equal(init.headers.Authorization, "Bearer g2-access"); return json({ sub: "222", email: "agency@example.com" }); }
    throw new Error(`unexpected ${url}`);
  });
  assert.match(added.consent.searchParams.get("scope"), /analytics\.readonly/, "the same Google permissions as the main sign-in");
  assert.match(added.consent.searchParams.get("prompt"), /select_account/);
  assert.match(added.location, /connected=google_account/);
  // A second sign-in with the same Google account replaces it rather than adding a duplicate.
  await signIn(t, "google_account", async url => url.includes("token") ? json({ access_token: "g2-access", refresh_token: "g2-refresh", expires_in: 3600 }) : json({ sub: "222", email: "agency@example.com" }));
  const page = await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text();
  assert.equal(page.match(/agency@example\.com/g).length, 1);

  const used = [];
  const google = async (url, init) => {
    const bearer = init?.headers?.Authorization;
    if (url.startsWith("https://analyticsadmin.googleapis.com/v1beta/accountSummaries")) {
      return json({ accountSummaries: [{ propertySummaries: [{ property: bearer === "Bearer a" ? "properties/111" : "properties/999" }] }] });
    }
    const report = /properties\/(\d+):runReport/.exec(url);
    if (report) { used.push(`${report[1]} ${bearer}`); return json({ rows: [], rowCount: 0 }); }
    return json({ error: { message: "no access" } }, 403);
  };
  const run = args => callTool(token, "run_ga4_report", { dateRanges: [{ startDate: "2026-10-01", endDate: "2026-10-02" }], metrics: [{ name: "sessions" }], ...args }, google);
  await run({ propertyId: "999" });
  await run({ propertyId: "111" });
  await run({ propertyId: "111", account: "agency@example.com" });
  assert.deepEqual(used, ["999 Bearer g2-access", "111 Bearer a", "111 Bearer g2-access"]);
});

test("extra CallRail keys: each account's calls use its own key; tools appear without a main key", async () => {
  const token = tokenFor("user-callrail-multi");
  const t = await linkFor(token);
  const callrail = async (url, init) => {
    const key = /token="([^"]+)"/.exec(init.headers.Authorization)[1];
    if (url.includes("/a.json")) return key === "bad" ? json({ error: "Unauthorized" }, 401) : json({ accounts: [{ id: key === "key-1" ? "ACC1" : "ACC2", name: key === "key-1" ? "Agency One" : "Agency Two" }] });
    const companies = /\/a\/(ACC\d)\/companies\.json/.exec(url);
    if (companies) return json({ companies: [{ id: "COM1", name: `${companies[1]} via ${key}` }] });
    throw new Error(`unexpected ${url}`);
  };
  const add = async apiToken => {
    globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) ? realFetch(url, init) : callrail(String(url), init);
    try { return (await realFetch(`${baseUrl}/connections/callrail_key?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `apiToken=${apiToken}` })).headers.get("location"); }
    finally { globalThis.fetch = realFetch; }
  };
  assert.match(await add("bad"), /error=CallRail\+rejected/);
  assert.match(await add("key-1"), /connected=callrail_key/);
  assert.match(await add("key-2"), /connected=callrail_key/);
  const page = await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text();
  assert.match(page, /Agency One/);
  assert.match(page, /Agency Two/);
  assert.ok(!page.includes("key-1"), "keys are never shown");

  const companies = async accountId => (await callTool(token, "list_callrail_companies", { accountId }, callrail)).structuredContent;
  assert.match(JSON.stringify(await companies("ACC2")), /ACC2 via key-2/);
  assert.match(JSON.stringify(await companies("ACC1")), /ACC1 via key-1/);

  const managed = (await callTool(token, "manage_connections")).structuredContent;
  const second = managed.connected.find(c => c.label === "Agency Two");
  assert.ok(managed.available.some(p => p.provider === "callrail_key"), "more keys can always be added");
  await realFetch(`${baseUrl}/connections/${encodeURIComponent(second.id)}/disconnect?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual" });
  const remaining = (await callTool(token, "manage_connections")).structuredContent.connected.map(c => c.label);
  assert.deepEqual(remaining, ["Agency One"]);
});

test("extra Meta logins: a long-lived token stands in when the main sign-in has no Meta", async () => {
  process.env.META_APP_ID = "meta-app";
  process.env.META_APP_SECRET = "meta-secret";
  try {
    const token = tokenFor("user-meta-multi");
    const t = await linkFor(token);
    const meta = async url => {
      const params = new URL(url).searchParams;
      if (url.includes("/oauth/access_token")) return json(params.get("grant_type") === "fb_exchange_token" ? { access_token: "meta-long", expires_in: 5_184_000 } : { access_token: "meta-short" });
      if (url.includes("/me?")) return json({ id: "m1", name: "Agency Meta" });
      if (url.includes("/me/adaccounts")) { assert.equal(params.get("access_token"), "meta-long"); return json({ data: [{ id: "act_42", account_id: "42", name: "Carports Ads" }] }); }
      if (url.includes("/me/accounts")) return json({ data: [] });
      throw new Error(`unexpected ${url}`);
    };
    const added = await signIn(t, "meta_account", meta);
    assert.equal(added.consent.origin, "https://www.facebook.com");
    assert.match(added.location, /connected=meta_account/);
    assert.match(await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text(), /Agency Meta/);
    const accounts = (await callTool(token, "list_meta_ad_accounts", {}, meta)).structuredContent;
    assert.match(JSON.stringify(accounts), /Carports Ads/);
  } finally {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  }
});
