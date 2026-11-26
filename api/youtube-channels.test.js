import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { MAX_YOUTUBE_CHANNELS, matchChannel, pickYouTubeChannel } from "./connections/_youtube-channels.js";

// The in-memory store must be chosen before the server module creates its store.
process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
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

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function tokenFor(userId, resource = `${baseUrl}/mcp`) {
  const sessionId = `s-${Math.random()}`;
  const google = { sessionId, refreshToken: "r", accessToken: "main-access", expiryDate: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId };
  const session = testSupport.saveSession(sessionId, google);
  return testSupport.mintAccessToken({ protocol: "http", get: () => new URL(baseUrl).host }, { sessionId, resource, scope: session.scope, google: session });
}

async function rpc(token, path, method, params, upstream) {
  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) || !upstream ? realFetch(url, init) : upstream(String(url), init);
  try {
    const response = await realFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    return (await response.json()).result;
  } finally { globalThis.fetch = realFetch; }
}
const callTool = (token, name, args = {}, upstream, path = "/mcp") => rpc(token, path, "tools/call", { name, arguments: args }, upstream);

// A connected channel: its sign-in's access token is "<key>-access".
const channel = (key, title) => ({ label: title, summary: "10 subscribers", oauth: { accessToken: `${key}-access`, refreshToken: `${key}-refresh`, expiresAt: Date.now() + 3_600_000 }, meta: { channelId: `UC_${key}`, title } });

// YouTube as seen by each channel's token: analytics totals name the token, video C belongs to channel B.
const bearer = init => String(init?.headers?.Authorization || init?.headers?.authorization || "").replace("Bearer ", "");
const youtube = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === "youtubeanalytics.googleapis.com") return json({ columnHeaders: [{ name: "views" }], rows: [[bearer(init) === "b-access" ? 222 : 111]] });
  if (u.pathname.endsWith("/videos") && (init.method || "GET") === "GET") return json({ items: [{ id: u.searchParams.get("id"), snippet: { channelId: "UC_b", title: "Old", description: "Keep" } }] });
  if (u.pathname.endsWith("/videos") && init.method === "PUT") return json({ ...JSON.parse(init.body), updatedWith: bearer(init) });
  if (u.pathname.endsWith("/search")) return json({ pageInfo: { totalResults: 0 }, items: [] });
  throw new Error(`unexpected ${init.method || "GET"} ${url}`);
};

test("a channel is picked by name, ID, profile, the only one connected, or the video's owner", async () => {
  const channels = [
    { id: "youtube:a", channelId: "UC_a", title: "Get Carports TV" },
    { id: "youtube:b", channelId: "UC_b", title: "Carports Shorts" }
  ];
  assert.equal(matchChannel(channels, "uc_b"), channels[1]);
  assert.equal(matchChannel(channels, "get carports tv"), channels[0]);
  assert.equal(matchChannel(channels, "shorts"), channels[1], "a fragment matching one channel");
  assert.equal(matchChannel(channels, "carports"), null, "a fragment matching both is not a guess");

  assert.equal((await pickYouTubeChannel({ channels: [] })).error, "not_connected");
  assert.equal((await pickYouTubeChannel({ channels: channels.slice(0, 1) })).channel, channels[0]);
  assert.equal((await pickYouTubeChannel({ channels, wanted: "Carports Shorts" })).channel, channels[1]);
  assert.equal((await pickYouTubeChannel({ channels, wanted: "nope" })).error, "unknown_channel");
  assert.equal((await pickYouTubeChannel({ channels, anyChannel: true })).channel, channels[0]);
  assert.equal((await pickYouTubeChannel({ channels, ownerOf: async () => "UC_b" })).channel, channels[1]);
  const ask = await pickYouTubeChannel({ channels, ownerOf: async () => "UC_other" });
  assert.equal(ask.error, "choose_channel");
  assert.deepEqual(ask.channels.map(c => c.channel), ["Get Carports TV", "Carports Shorts"]);

  assert.equal((await pickYouTubeChannel({ channels, pinned: "youtube:b" })).channel, channels[1]);
  assert.equal((await pickYouTubeChannel({ channels, pinned: "youtube:b", wanted: "Get Carports TV" })).error, "other_channel");
  assert.equal((await pickYouTubeChannel({ channels, pinned: "youtube:gone" })).error, "profile_channel_missing");
  assert.equal(MAX_YOUTUBE_CHANNELS, 5);
});

test("with several channels, YouTube tools ask which one, use the one named, and say which answered", async () => {
  await store.save("yt-multi", "youtube:a", channel("a", "Get Carports TV"));
  await store.save("yt-multi", "youtube:b", channel("b", "Carports Shorts"));
  const token = tokenFor("yt-multi");

  const ask = await callTool(token, "youtube_channel_report", {}, youtube);
  assert.equal(ask.isError, true);
  assert.equal(ask.structuredContent.error, "choose_channel");
  assert.equal(ask.structuredContent.channels.length, 2);

  const b = (await callTool(token, "youtube_channel_report", { channel: "Carports Shorts" }, youtube)).structuredContent;
  assert.equal(b.totals.views, 222, "read with channel B's sign-in");
  assert.equal(b.youtubeChannel.channel, "Carports Shorts");
  const a = (await callTool(token, "youtube_channel_report", { channel: "UC_a" }, youtube)).structuredContent;
  assert.equal(a.totals.views, 111);

  // A video names its channel, so an edit goes to the channel that owns it.
  const edit = (await callTool(token, "youtube_update_video", { videoId: "ccccccccccc", title: "New title" }, youtube)).structuredContent;
  assert.equal(edit.youtubeChannel.channel, "Carports Shorts");
  // Public research works with any channel's sign-in.
  assert.equal((await callTool(token, "youtube_search", { query: "carports" }, youtube)).isError, undefined);

  const listed = (await callTool(token, "manage_connections")).structuredContent.youtube;
  assert.deepEqual(listed.channels.map(c => c.channel), ["Get Carports TV", "Carports Shorts"]);
  assert.equal(listed.limit, 5);
  const tools = (await rpc(token, "/mcp", "tools/list", {})).tools;
  assert.ok(tools.find(tool => tool.name === "youtube_channel_report").inputSchema.properties.channel, "YouTube tools take `channel`");
  assert.ok(!tools.find(tool => tool.name === "get_ga4_metadata").inputSchema.properties.channel, "other tools don't");
});

// One sign-in on the Connections page that shares `channelId` (titled `title`).
async function connectChannel(t, channelId, title) {
  const start = await realFetch(`${baseUrl}/connections/youtube/start?t=${encodeURIComponent(t)}`, { redirect: "manual" });
  const consent = new URL(start.headers.get("location"));
  assert.match(consent.searchParams.get("scope"), /email/);
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith(baseUrl)) return realFetch(url, init);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: `${channelId}-access`, refresh_token: `${channelId}-refresh`, expires_in: 3600 });
    if (url.includes("/youtube/v3/channels")) return json({ items: [{ id: channelId, snippet: { title }, statistics: { subscriberCount: "10" } }] });
    if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return json({ sub: "1", email: "owner@example.com" });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const callback = await realFetch(`${baseUrl}/connections/oauth/callback?code=c&state=${encodeURIComponent(consent.searchParams.get("state"))}`, { redirect: "manual" });
    return new URL(callback.headers.get("location"), baseUrl).searchParams;
  } finally { globalThis.fetch = realFetch; }
}
const linkFor = async token => new URL((await callTool(token, "manage_connections", { includeManageUrl: true })).structuredContent.manageUrl).searchParams.get("t");
const youtubeIds = async userId => (await store.list(userId)).filter(id => id === "youtube" || id.startsWith("youtube:"));

test("up to five channels connect; a sixth is refused, and a connected one can still refresh", async () => {
  const token = tokenFor("yt-limit"), t = await linkFor(token);
  for (let i = 1; i <= 5; i++) assert.equal((await connectChannel(t, `UC_${i}`, `Channel ${i}`)).get("connected"), "youtube");
  assert.equal((await youtubeIds("yt-limit")).length, 5);

  const page = await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text();
  assert.match(page, /5 of 5 channels connected\. Disconnect one to add another/);
  assert.match(page, /Refresh a connected channel/);
  assert.match(page, /<strong>Channel 3<\/strong><span class="acct-meta">10 subscribers · via owner@example\.com/);

  const sixth = await connectChannel(t, "UC_6", "Channel 6");
  assert.match(sixth.get("error"), /up to 5 YouTube channels/);
  assert.equal((await youtubeIds("yt-limit")).length, 5);

  const again = await connectChannel(t, "UC_2", "Channel 2");
  assert.equal(again.get("refreshed"), "1", "an already connected channel refreshes at the limit");
  assert.equal((await youtubeIds("yt-limit")).length, 5);
});

test("a channel connected before several were allowed moves to its own ID, and profiles follow it", async () => {
  await store.save("yt-legacy", "youtube", channel("old", "Get Carports TV"));
  await store.saveProfile("yt-legacy", { slug: "carports-aaaaaa", name: "Carports", accounts: { google: null, meta: null, callrail: null }, accountLabels: { youtube: "Get Carports TV" }, platforms: ["youtube"], youtubeChannel: "youtube", defaults: {}, createdAt: Date.now() });
  const token = tokenFor("yt-legacy"), t = await linkFor(token);

  // Still works as the only channel.
  assert.equal((await callTool(token, "youtube_channel_report", {}, youtube)).structuredContent.totals.views, 111);

  const other = await connectChannel(t, "UC_new", "Second Channel");
  assert.equal(other.get("refreshed"), null);
  assert.deepEqual((await youtubeIds("yt-legacy")).length, 2, "the old channel stays alongside a new one");

  const same = await connectChannel(t, "UC_old", "Get Carports TV");
  assert.equal(same.get("refreshed"), "1");
  const ids = await youtubeIds("yt-legacy");
  assert.ok(!ids.includes("youtube"), "the old record is replaced");
  assert.equal(ids.length, 2);
  const moved = (await store.getProfile("yt-legacy", "carports-aaaaaa")).youtubeChannel;
  assert.ok(moved.startsWith("youtube:") && ids.includes(moved), "the profile now points at the new ID");
});

test("a profile set to one channel uses only that channel on its connector", async () => {
  await store.save("yt-profile", "youtube:a", channel("a", "Get Carports TV"));
  await store.save("yt-profile", "youtube:b", channel("b", "Carports Shorts"));
  await store.saveProfile("yt-profile", { slug: "shorts-bbbbbb", name: "Shorts", accounts: { google: null, meta: null, callrail: null }, accountLabels: { youtube: "Carports Shorts" }, platforms: ["youtube"], youtubeChannel: "youtube:b", defaults: {}, createdAt: Date.now() });
  const token = tokenFor("yt-profile"), path = "/mcp/p/shorts-bbbbbb";

  const tools = (await rpc(token, path, "tools/list", {})).tools;
  assert.ok(!tools.find(tool => tool.name === "youtube_channel_report").inputSchema.properties.channel, "the profile decides the channel");
  const report = (await callTool(token, "youtube_channel_report", {}, youtube, path)).structuredContent;
  assert.equal(report.totals.views, 222);

  // Creating such a profile on the Connections page.
  const t = await linkFor(token);
  const save = await realFetch(`${baseUrl}/connections/profiles/save?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: "Main channel", youtube_channel: "youtube:a" }) });
  assert.match(save.headers.get("location"), /profile_saved/);
  const created = (await store.listProfiles("yt-profile")).find(profile => profile.name === "Main channel");
  assert.equal(created.youtubeChannel, "youtube:a");
  assert.deepEqual(created.platforms, ["youtube"]);
  const bad = await realFetch(`${baseUrl}/connections/profiles/save?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: "X", youtube_channel: "youtube:someone-else" }) });
  assert.match(new URL(bad.headers.get("location"), baseUrl).searchParams.get("error"), /Pick a YouTube channel/);
});
