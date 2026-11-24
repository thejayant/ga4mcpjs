import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { maskStreamKey } from "./connections/_youtube-live-tools.js";

// The in-memory store must be chosen before the server module creates its store.
process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
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
  await store.save("live-user", "youtube:a", { label: "Gaming Live", oauth: { accessToken: "a-access", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }, meta: { channelId: "UC_a", title: "Gaming Live" } });
});
after(async () => { globalThis.fetch = realFetch; await new Promise(resolve => server.close(resolve)); });

const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });
const STREAM_KEY = "abcd-efgh-ijkl-mnop-qrst";
const CHANNEL = "UC" + "x".repeat(22);

function tokenFor(userId) {
  const sessionId = `s-${Math.random()}`;
  const google = { sessionId, refreshToken: "r", accessToken: "main-access", expiryDate: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId };
  const session = testSupport.saveSession(sessionId, google);
  return testSupport.mintAccessToken({ protocol: "http", get: () => new URL(baseUrl).host }, { sessionId, resource: `${baseUrl}/mcp`, scope: session.scope, google: session });
}
const token = () => tokenFor("live-user");

// A fake YouTube Live API. `state.active` is how many livestreams are live; every call is recorded.
function fakeYouTube(state = {}) {
  const calls = [];
  const broadcast = (id, lifeCycleStatus = "live", extra = {}) => ({ id, snippet: { title: `Stream ${id}`, liveChatId: `chat-${id}` }, status: { lifeCycleStatus }, contentDetails: { boundStreamId: "stream-1" }, ...extra });
  const handler = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname.replace("/youtube/v3/", ""), params: Object.fromEntries(u.searchParams), body });
    const path = u.pathname.replace("/youtube/v3/", "");
    if (path === "liveBroadcasts" && u.searchParams.get("broadcastStatus") === "active") return json({ items: Array.from({ length: state.active ?? 1 }, (_, i) => broadcast(`live${String(i).padStart(7, "0")}`)) });
    if (path === "liveBroadcasts") {
      const id = u.searchParams.get("id");
      if (id === "unboundxxxx") return json({ items: [broadcast(id, "ready", { contentDetails: {} })] });
      if (id === "upcomingxxx") return json({ items: [broadcast(id, "ready")] });
      return json({ items: [broadcast(id)] });
    }
    if (path === "liveStreams") return json({ items: [{ id: "stream-1", snippet: { title: "OBS" }, cdn: { ingestionType: "rtmp", resolution: "1080p", frameRate: "60fps", ingestionInfo: { streamName: STREAM_KEY, ingestionAddress: "rtmp://a.rtmp.youtube.com/live2", rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2" } }, status: { streamStatus: "active", healthStatus: { status: "bad", lastUpdateTimeSeconds: "1800000000", configurationIssues: [{ type: "bitrateLow", severity: "warning", reason: "Check video settings", description: "Bitrate is lower than recommended." }] } }, contentDetails: { isReusable: true } }] });
    if (path === "liveChat/messages" && method === "GET") return json({ items: [
      { id: "m1", snippet: { type: "textMessageEvent", publishedAt: "2026-11-24T10:00:00Z", displayMessage: "hello" }, authorDetails: { channelId: CHANNEL, displayName: "Viewer", isChatModerator: false, isChatOwner: false, isChatSponsor: true, isVerified: false } },
      { id: "m2", snippet: { type: "superChatEvent", publishedAt: "2026-11-24T10:01:00Z", displayMessage: "great stream", superChatDetails: { amountDisplayString: "₹100.00" } }, authorDetails: { channelId: CHANNEL, displayName: "Fan" } }
    ], nextPageToken: "next-1", pollingIntervalMillis: 5000 });
    if (path === "liveChat/messages" && method === "POST") return json({ id: "sent-1", snippet: { displayMessage: body.snippet.textMessageDetails.messageText } });
    if (path === "liveChat/messages" && method === "DELETE") return u.searchParams.get("id") === "gone-000001" ? json({ error: { message: "Message not found." } }, 404) : json(null, 204);
    if (path === "liveChat/bans" && method === "POST") return json({ id: "ban-1", snippet: body.snippet });
    if (path === "liveChat/bans" && method === "DELETE") return json(null, 204);
    if (path === "liveChat/moderators" && method === "GET") return json({ items: [{ id: "mod-1", snippet: { moderatorDetails: { channelId: CHANNEL, displayName: "Helper" } } }] });
    if (path === "liveChat/moderators" && method === "POST") return json({ id: "mod-2", snippet: { moderatorDetails: { channelId: body.snippet.moderatorDetails.channelId, displayName: "New Mod" } } });
    if (path === "liveChat/moderators" && method === "DELETE") return json(null, 204);
    if (path === "liveBroadcasts/cuepoint") return json({ id: "cue-1", ...body });
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { calls, handler };
}

async function callTool(name, args, yt) {
  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) ? realFetch(url, init) : yt.handler(String(url), init);
  try {
    const response = await realFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    });
    return (await response.json()).result;
  } finally { globalThis.fetch = realFetch; }
}

test("stream health reports status, health and issues, and never the full stream key", async () => {
  assert.equal(maskStreamKey(STREAM_KEY), "••••qrst");
  assert.equal(maskStreamKey(undefined), null);
  const yt = fakeYouTube();
  const outcome = await callTool("youtube_stream_health", { broadcastId: "abcdefghijk" }, yt);
  const stream = outcome.structuredContent.streams[0];
  assert.equal(stream.streamStatus, "active");
  assert.equal(stream.health, "bad");
  assert.deepEqual(stream.issues[0], { type: "bitrateLow", severity: "warning", reason: "Check video settings", description: "Bitrate is lower than recommended." });
  assert.equal(stream.ingestionAddress, "rtmps://a.rtmps.youtube.com/live2");
  assert.equal(stream.streamKey, "••••qrst");
  assert.ok(!JSON.stringify(outcome).includes(STREAM_KEY), "the key is not anywhere in the answer");
  assert.equal(yt.calls.find(call => call.path === "liveStreams").params.id, "stream-1", "the stream bound to that livestream");

  const unbound = await callTool("youtube_stream_health", { broadcastId: "unboundxxxx" }, fakeYouTube());
  assert.match(unbound.structuredContent.note, /No stream is bound/);
  const all = fakeYouTube();
  await callTool("youtube_stream_health", {}, all);
  assert.equal(all.calls.find(call => call.path === "liveStreams").params.mine, "true");
});

test("chat reads the one active livestream by default and asks when there are none or several", async () => {
  const yt = fakeYouTube();
  const chat = (await callTool("youtube_live_chat_read", {}, yt)).structuredContent;
  assert.equal(chat.liveChatId, "chat-live0000000");
  assert.deepEqual(chat.messages.map(m => m.messageId), ["m1", "m2"]);
  assert.equal(chat.messages[0].author.member, true);
  assert.equal(chat.messages[1].superChat, "₹100.00");
  assert.equal(chat.nextPageToken, "next-1");
  assert.equal(yt.calls.find(call => call.path === "liveChat/messages").params.maxResults, "200");

  assert.equal((await callTool("youtube_live_chat_read", {}, fakeYouTube({ active: 0 }))).structuredContent.error, "not_live");
  const several = (await callTool("youtube_live_chat_read", {}, fakeYouTube({ active: 2 }))).structuredContent;
  assert.equal(several.error, "choose_broadcast");
  assert.equal(several.broadcasts.length, 2);
  const byId = fakeYouTube();
  await callTool("youtube_live_chat_read", { broadcastId: "abcdefghijk", pageToken: "next-1" }, byId);
  assert.equal(byId.calls.find(call => call.path === "liveChat/messages").params.liveChatId, "chat-abcdefghijk");
});

test("chat messages are sent and deleted; failures are reported per message", async () => {
  const yt = fakeYouTube();
  const sent = (await callTool("youtube_live_chat_send", { broadcastId: "abcdefghijk", message: "Welcome everyone!" }, yt)).structuredContent;
  assert.equal(sent.messageId, "sent-1");
  const post = yt.calls.find(call => call.method === "POST");
  assert.deepEqual(post.body, { snippet: { liveChatId: "chat-abcdefghijk", type: "textMessageEvent", textMessageDetails: { messageText: "Welcome everyone!" } } });
  assert.equal(post.params.part, "snippet");

  const removed = await callTool("youtube_live_chat_delete", { messageIds: ["msg-000001", "gone-000001"] }, fakeYouTube());
  assert.deepEqual(removed.structuredContent.deleted, ["msg-000001"]);
  assert.equal(removed.structuredContent.failed[0].messageId, "gone-000001");
  assert.equal((await callTool("youtube_live_chat_send", { message: "x".repeat(201) }, fakeYouTube())).isError, true, "over 200 characters");
});

test("bans: a timeout or permanent ban returns its banId, which lifts it", async () => {
  const yt = fakeYouTube();
  const timeout = (await callTool("youtube_live_chat_ban", { action: "ban", channelId: CHANNEL, durationSeconds: 300 }, yt)).structuredContent;
  assert.equal(timeout.banId, "ban-1");
  assert.equal(timeout.type, "temporary");
  assert.deepEqual(yt.calls.find(call => call.path === "liveChat/bans").body.snippet, { liveChatId: "chat-live0000000", type: "temporary", banDurationSeconds: 300, bannedUserDetails: { channelId: CHANNEL } });

  const permanent = fakeYouTube();
  assert.equal((await callTool("youtube_live_chat_ban", { action: "ban", broadcastId: "abcdefghijk", channelId: CHANNEL }, permanent)).structuredContent.type, "permanent");
  assert.ok(!("banDurationSeconds" in permanent.calls.find(call => call.path === "liveChat/bans").body.snippet));

  const lift = fakeYouTube();
  assert.equal((await callTool("youtube_live_chat_ban", { action: "unban", banId: "ban-1" }, lift)).structuredContent.unbanned, true);
  assert.deepEqual(lift.calls.map(call => [call.method, call.params.id]), [["DELETE", "ban-1"]]);
  assert.equal((await callTool("youtube_live_chat_ban", { action: "ban" }, fakeYouTube())).structuredContent.error, "bad_input");
  assert.equal((await callTool("youtube_live_chat_ban", { action: "unban" }, fakeYouTube())).structuredContent.error, "bad_input");
});

test("moderators are listed, added and removed", async () => {
  assert.deepEqual((await callTool("youtube_live_chat_moderators", { action: "list" }, fakeYouTube())).structuredContent.moderators, [{ moderatorId: "mod-1", channelId: CHANNEL, name: "Helper" }]);
  const add = fakeYouTube();
  const added = (await callTool("youtube_live_chat_moderators", { action: "add", channelId: CHANNEL }, add)).structuredContent;
  assert.equal(added.moderatorId, "mod-2");
  assert.deepEqual(add.calls.find(call => call.method === "POST").body, { snippet: { liveChatId: "chat-live0000000", moderatorDetails: { channelId: CHANNEL } } });
  const remove = fakeYouTube();
  assert.equal((await callTool("youtube_live_chat_moderators", { action: "remove", moderatorId: "mod-1" }, remove)).structuredContent.removed, true);
  assert.deepEqual(remove.calls.map(call => [call.method, call.path, call.params.id]), [["DELETE", "liveChat/moderators", "mod-1"]]);
  assert.equal((await callTool("youtube_live_chat_moderators", { action: "add" }, fakeYouTube())).structuredContent.error, "bad_input");
});

test("ad breaks start only on a live livestream, with the right cuepoint", async () => {
  const yt = fakeYouTube();
  const now = (await callTool("youtube_insert_ad_break", { broadcastId: "abcdefghijk" }, yt)).structuredContent;
  assert.equal(now.cuepointId, "cue-1");
  assert.equal(now.durationSecs, 30);
  const cue = yt.calls.find(call => call.path === "liveBroadcasts/cuepoint");
  assert.equal(cue.method, "POST");
  assert.equal(cue.params.id, "abcdefghijk");
  assert.deepEqual(cue.body, { cueType: "cueTypeAd", durationSecs: 30 });

  const timed = fakeYouTube();
  await callTool("youtube_insert_ad_break", { broadcastId: "abcdefghijk", durationSecs: 60, walltime: "2026-11-24T10:30:00Z" }, timed);
  assert.deepEqual(timed.calls.find(call => call.path === "liveBroadcasts/cuepoint").body, { cueType: "cueTypeAd", durationSecs: 60, walltimeMs: Date.parse("2026-11-24T10:30:00Z") });

  const notLive = fakeYouTube();
  const refused = (await callTool("youtube_insert_ad_break", { broadcastId: "upcomingxxx" }, notLive)).structuredContent;
  assert.equal(refused.error, "not_live");
  assert.ok(!notLive.calls.some(call => call.path === "liveBroadcasts/cuepoint"), "nothing is sent unless live");
  assert.equal((await callTool("youtube_insert_ad_break", { broadcastId: "abcdefghijk", walltime: "2026-11-24T10:30:00Z", insertionOffsetTimeMs: 0 }, fakeYouTube())).structuredContent.error, "bad_input");
});
