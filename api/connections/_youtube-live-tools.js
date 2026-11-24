// YouTube live tools: stream health, live chat (read, send, delete), chat bans and moderators,
// and ad breaks (cuepoints) during a live broadcast. Live Streaming API, same scopes as the other
// YouTube tools (youtube.force-ssl), so no reconnect is needed.
//
// Quota: liveChatMessages.list 5 units, liveChatMessages.insert 20, other reads about 1 and other
// writes about 50 (YouTube Data API, 10,000 units/day by default). Chat is read on request only:
// polling it every few seconds through a stream would use the day's quota.
// Stream keys are secret (anyone with one can stream to the channel), so they are never returned
// in full.
import { z } from "zod";
import { youtubeData, youtubeDataWrite } from "./providers.js";

export const YOUTUBE_LIVE_TOOL_NAMES = [
  "youtube_stream_health", "youtube_live_chat_read", "youtube_live_chat_send", "youtube_live_chat_delete",
  "youtube_live_chat_ban", "youtube_live_chat_moderators", "youtube_insert_ad_break"
];

export const maskStreamKey = key => (key ? `••••${String(key).slice(-4)}` : null);

const broadcastId = z.string().regex(/^[A-Za-z0-9_-]{11}$/).describe("The livestream's video ID, from youtube_list_broadcasts");
const liveChatId = z.string().min(10).max(200).describe("A live chat ID; usually omit it and give broadcastId");
const channelId = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/).describe("A viewer's channel ID (author.channelId from youtube_live_chat_read)");
const chatTarget = {
  broadcastId: broadcastId.optional().describe("The livestream's video ID; default: the channel's one active livestream"),
  liveChatId: liveChatId.optional()
};
const errorMessage = response => response.body?.error?.message || (typeof response.body === "string" ? response.body.slice(0, 200) : "") || `YouTube returned ${response.status}.`;

const healthOf = stream => ({
  streamId: stream.id,
  title: stream.snippet?.title,
  streamStatus: stream.status?.streamStatus,
  health: stream.status?.healthStatus?.status || null,
  lastHealthUpdate: stream.status?.healthStatus?.lastUpdateTimeSeconds ? new Date(Number(stream.status.healthStatus.lastUpdateTimeSeconds) * 1000).toISOString() : null,
  issues: (stream.status?.healthStatus?.configurationIssues || []).map(issue => ({ type: issue.type, severity: issue.severity, reason: issue.reason, description: issue.description })),
  ingestionType: stream.cdn?.ingestionType, resolution: stream.cdn?.resolution, frameRate: stream.cdn?.frameRate,
  ingestionAddress: stream.cdn?.ingestionInfo?.rtmpsIngestionAddress || stream.cdn?.ingestionInfo?.ingestionAddress || null,
  streamKey: maskStreamKey(stream.cdn?.ingestionInfo?.streamName),
  reusable: stream.contentDetails?.isReusable
});

const messageOf = item => ({
  messageId: item.id,
  type: item.snippet?.type,
  publishedAt: item.snippet?.publishedAt,
  text: item.snippet?.displayMessage ?? item.snippet?.textMessageDetails?.messageText ?? null,
  ...(item.snippet?.superChatDetails ? { superChat: item.snippet.superChatDetails.amountDisplayString } : {}),
  ...(item.snippet?.superStickerDetails ? { superSticker: item.snippet.superStickerDetails.amountDisplayString } : {}),
  author: item.authorDetails ? {
    channelId: item.authorDetails.channelId, name: item.authorDetails.displayName,
    owner: Boolean(item.authorDetails.isChatOwner), moderator: Boolean(item.authorDetails.isChatModerator),
    member: Boolean(item.authorDetails.isChatSponsor), verified: Boolean(item.authorDetails.isVerified)
  } : null
});

export function registerYouTubeLiveTools(server, { forUser, reply, result, missingWriteScope, reconnect }) {
  const yt = handler => forUser("youtube", handler);
  // Writes are not retried: a retried chat message, ban or ad break could happen twice.
  const write = async (auth, call, shape) => {
    const response = await call();
    if (missingWriteScope(response)) return reconnect(auth);
    return reply(response, shape);
  };

  // The live chat to act on: the given chat, the given broadcast's chat, or the one active broadcast's.
  async function findChat(accessToken, args) {
    if (args.liveChatId) return { liveChatId: args.liveChatId };
    const response = args.broadcastId
      ? await youtubeData(accessToken, "liveBroadcasts", { part: "snippet,status", id: args.broadcastId })
      : await youtubeData(accessToken, "liveBroadcasts", { part: "snippet,status", broadcastStatus: "active", broadcastType: "all", maxResults: 5 });
    if (!response.ok) return { error: response };
    const items = response.body?.items || [];
    if (!args.broadcastId && items.length !== 1) {
      return { problem: items.length
        ? { error: "choose_broadcast", error_description: "Several livestreams are live. Say which one with broadcastId.", broadcasts: items.map(b => ({ broadcastId: b.id, title: b.snippet?.title })) }
        : { error: "not_live", error_description: "No livestream is live on this channel right now. Give broadcastId for an upcoming or recent one." } };
    }
    const broadcast = items[0];
    if (!broadcast) return { problem: { error: "broadcast_not_found", error_description: "No livestream on this channel has that ID." } };
    if (!broadcast.snippet?.liveChatId) return { problem: { error: "no_live_chat", error_description: `"${broadcast.snippet?.title}" has no live chat (it ended, or chat is turned off).` } };
    return { liveChatId: broadcast.snippet.liveChatId, broadcast: { broadcastId: broadcast.id, title: broadcast.snippet?.title, lifeCycleStatus: broadcast.status?.lifeCycleStatus } };
  }
  // Runs `then` with the chat, or answers with why there isn't one.
  const withChat = async (accessToken, args, then) => {
    const chat = await findChat(accessToken, args);
    if (chat.error) return reply(chat.error);
    if (chat.problem) return result(chat.problem, true);
    return then(chat);
  };

  server.registerTool("youtube_stream_health", {
    title: "YouTube Stream Health",
    description: "Health of the channel's live stream inputs (what OBS or the encoder sends): status (active, ready, inactive, error), health (good, ok, bad, noData), and configuration issues such as low bitrate, wrong resolution or frame rate, missing audio or video, with YouTube's advice. Give broadcastId for the stream bound to one livestream; default: all of the channel's streams. Stream keys are shown masked; the full key is in YouTube Studio.",
    inputSchema: { broadcastId: broadcastId.optional(), maxResults: z.number().int().min(1).max(50).optional().describe("Default 10") },
    annotations: { readOnlyHint: true }
  }, yt(async ({ accessToken, args }) => {
    let params = { part: "id,snippet,cdn,status,contentDetails", mine: "true", maxResults: args.maxResults || 10 };
    let broadcast = null;
    if (args.broadcastId) {
      const found = await youtubeData(accessToken, "liveBroadcasts", { part: "snippet,status,contentDetails", id: args.broadcastId });
      if (!found.ok) return reply(found);
      const item = found.body?.items?.[0];
      if (!item) return result({ error: "broadcast_not_found", error_description: "No livestream on this channel has that ID." }, true);
      broadcast = { broadcastId: item.id, title: item.snippet?.title, lifeCycleStatus: item.status?.lifeCycleStatus };
      const bound = item.contentDetails?.boundStreamId;
      if (!bound) return result({ broadcast, streams: [], note: "No stream is bound to this livestream yet (YouTube Studio binds one when you set it up)." });
      params = { part: "id,snippet,cdn,status,contentDetails", id: bound };
    }
    const response = await youtubeData(accessToken, "liveStreams", params);
    if (!response.ok) return reply(response);
    return result({ ...(broadcast ? { broadcast } : {}), streams: (response.body?.items || []).map(healthOf) });
  }));

  server.registerTool("youtube_live_chat_read", {
    title: "YouTube Live Chat Read",
    description: "Read a livestream's chat: messages with their IDs, type (text, Super Chat, Super Sticker, new member…), time and author (channel ID, name, owner/moderator/member). Default: the channel's one active livestream. Pass nextPageToken back as pageToken to get only newer messages. Costs 5 quota units per call, so read on request rather than repeatedly.",
    inputSchema: { ...chatTarget, pageToken: z.string().max(500).optional(), maxResults: z.number().int().min(200).max(2000).optional().describe("Default 200") },
    annotations: { readOnlyHint: true }
  }, yt(async ({ accessToken, args }) => withChat(accessToken, args, async chat => {
    const response = await youtubeData(accessToken, "liveChat/messages", { liveChatId: chat.liveChatId, part: "id,snippet,authorDetails", maxResults: args.maxResults || 200, pageToken: args.pageToken });
    if (!response.ok) return reply(response);
    const body = response.body || {};
    return result({
      ...(chat.broadcast ? { broadcast: chat.broadcast } : {}), liveChatId: chat.liveChatId,
      messages: (body.items || []).map(messageOf),
      nextPageToken: body.nextPageToken || null, pollingIntervalMillis: body.pollingIntervalMillis ?? null,
      ...(body.offlineAt ? { offlineAt: body.offlineAt } : {})
    });
  })));

  server.registerTool("youtube_live_chat_send", {
    title: "YouTube Live Chat Send",
    description: "Post a message in a livestream's chat as the channel. Confirm the exact text with the user before calling. Default: the channel's one active livestream. Costs 20 quota units.",
    inputSchema: { ...chatTarget, message: z.string().trim().min(1).max(200).describe("Up to 200 characters") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, yt(async ({ auth, accessToken, args }) => withChat(accessToken, args, chat => write(auth,
    () => youtubeDataWrite(accessToken, "liveChat/messages", { part: "snippet" }, { snippet: { liveChatId: chat.liveChatId, type: "textMessageEvent", textMessageDetails: { messageText: args.message } } }, "POST"),
    body => ({ sent: true, messageId: body?.id, text: body?.snippet?.displayMessage ?? args.message, ...(chat.broadcast ? { broadcast: chat.broadcast } : {}) })))));

  server.registerTool("youtube_live_chat_delete", {
    title: "YouTube Live Chat Delete",
    description: "Delete messages from a livestream's chat by message ID (from youtube_live_chat_read). Deleted messages can't be restored: confirm with the user before calling.",
    inputSchema: { messageIds: z.array(z.string().min(5).max(200)).min(1).max(20) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    const deleted = [], failed = [];
    for (const id of args.messageIds) {
      const response = await youtubeDataWrite(accessToken, "liveChat/messages", { id }, undefined, "DELETE");
      if (missingWriteScope(response)) return reconnect(auth);
      if (response.ok) deleted.push(id); else failed.push({ messageId: id, status: response.status, error: errorMessage(response) });
    }
    return result({ deleted, failed }, deleted.length === 0);
  }));

  server.registerTool("youtube_live_chat_ban", {
    title: "YouTube Live Chat Ban",
    description: "Ban a viewer from a livestream's chat, or lift a ban. ban: give the viewer's channelId (author.channelId from youtube_live_chat_read) and durationSeconds for a timeout, or leave it out for a permanent ban; the answer includes banId. unban: give that banId. The chat owner and moderators can't be banned. Confirm with the user before calling.",
    inputSchema: {
      action: z.enum(["ban", "unban"]),
      ...chatTarget,
      channelId: channelId.optional().describe("ban: the viewer's channel ID"),
      durationSeconds: z.number().int().min(10).max(86400).optional().describe("ban: a timeout of this many seconds; omit for a permanent ban"),
      banId: z.string().min(5).max(300).optional().describe("unban: the banId returned when the ban was made")
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, yt(async ({ auth, accessToken, args }) => {
    if (args.action === "unban") {
      if (!args.banId) return result({ error: "bad_input", error_description: "unban needs the banId returned by the ban." }, true);
      return write(auth, () => youtubeDataWrite(accessToken, "liveChat/bans", { id: args.banId }, undefined, "DELETE"), () => ({ unbanned: true, banId: args.banId }));
    }
    if (!args.channelId) return result({ error: "bad_input", error_description: "ban needs the viewer's channelId (author.channelId from youtube_live_chat_read)." }, true);
    const temporary = args.durationSeconds !== undefined;
    return withChat(accessToken, args, chat => write(auth,
      () => youtubeDataWrite(accessToken, "liveChat/bans", { part: "snippet" }, { snippet: { liveChatId: chat.liveChatId, type: temporary ? "temporary" : "permanent", ...(temporary ? { banDurationSeconds: args.durationSeconds } : {}), bannedUserDetails: { channelId: args.channelId } } }, "POST"),
      body => ({ banned: true, banId: body?.id, channelId: args.channelId, type: temporary ? "temporary" : "permanent", ...(temporary ? { durationSeconds: args.durationSeconds } : {}), ...(chat.broadcast ? { broadcast: chat.broadcast } : {}) })));
  }));

  server.registerTool("youtube_live_chat_moderators", {
    title: "YouTube Live Chat Moderators",
    description: "List, add or remove moderators of a livestream's chat. list: the current moderators with their moderatorId. add: give the viewer's channelId. remove: give the moderatorId from list. Only the channel that owns the chat can change moderators. Confirm add and remove with the user before calling.",
    inputSchema: {
      action: z.enum(["list", "add", "remove"]),
      ...chatTarget,
      channelId: channelId.optional().describe("add: the new moderator's channel ID"),
      moderatorId: z.string().min(5).max(300).optional().describe("remove: the moderatorId from list")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    if (args.action === "remove") {
      if (!args.moderatorId) return result({ error: "bad_input", error_description: "remove needs the moderatorId from action list." }, true);
      return write(auth, () => youtubeDataWrite(accessToken, "liveChat/moderators", { id: args.moderatorId }, undefined, "DELETE"), () => ({ removed: true, moderatorId: args.moderatorId }));
    }
    if (args.action === "add" && !args.channelId) return result({ error: "bad_input", error_description: "add needs the new moderator's channelId." }, true);
    return withChat(accessToken, args, async chat => {
      if (args.action === "add") {
        return write(auth,
          () => youtubeDataWrite(accessToken, "liveChat/moderators", { part: "snippet" }, { snippet: { liveChatId: chat.liveChatId, moderatorDetails: { channelId: args.channelId } } }, "POST"),
          body => ({ added: true, moderatorId: body?.id, channelId: args.channelId, name: body?.snippet?.moderatorDetails?.displayName }));
      }
      const moderators = [];
      let pageToken;
      do {
        const page = await youtubeData(accessToken, "liveChat/moderators", { liveChatId: chat.liveChatId, part: "id,snippet", maxResults: 50, pageToken });
        if (!page.ok) return reply(page);
        moderators.push(...(page.body?.items || []).map(item => ({ moderatorId: item.id, channelId: item.snippet?.moderatorDetails?.channelId, name: item.snippet?.moderatorDetails?.displayName })));
        pageToken = page.body?.nextPageToken;
      } while (pageToken && moderators.length < 500);
      return result({ ...(chat.broadcast ? { broadcast: chat.broadcast } : {}), moderators });
    });
  }));

  server.registerTool("youtube_insert_ad_break", {
    title: "YouTube Insert Ad Break",
    description: "Start an ad break (a cuepoint) in a livestream that is live right now. Ads only run if the channel is monetized and eligible for ads on this stream. durationSecs defaults to 30. By default the break starts as soon as possible; walltime (an ISO date-time) schedules it for a wall-clock time instead, and insertionOffsetTimeMs is only for streams with a broadcast delay. Each call starts a new break, so confirm with the user before calling and don't repeat it.",
    inputSchema: {
      broadcastId,
      durationSecs: z.number().int().min(5).max(600).optional().describe("Length of the break in seconds; default 30"),
      walltime: z.string().datetime({ offset: true }).optional().describe("ISO date-time to start the break; omit to start as soon as possible"),
      insertionOffsetTimeMs: z.number().int().min(0).optional().describe("Only for delayed broadcasts: offset from the start of the monitor stream, in ms")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, yt(async ({ auth, accessToken, args }) => {
    if (args.walltime && args.insertionOffsetTimeMs !== undefined) return result({ error: "bad_input", error_description: "Give walltime or insertionOffsetTimeMs, not both." }, true);
    const found = await youtubeData(accessToken, "liveBroadcasts", { part: "snippet,status", id: args.broadcastId });
    if (!found.ok) return reply(found);
    const item = found.body?.items?.[0];
    if (!item) return result({ error: "broadcast_not_found", error_description: "No livestream on this channel has that ID." }, true);
    if (item.status?.lifeCycleStatus !== "live") return result({ error: "not_live", error_description: `"${item.snippet?.title}" is ${item.status?.lifeCycleStatus || "not live"}. Ad breaks can only start while the livestream is live.` }, true);
    const cuepoint = {
      cueType: "cueTypeAd",
      durationSecs: args.durationSecs || 30,
      ...(args.walltime ? { walltimeMs: Date.parse(args.walltime) } : {}),
      ...(args.insertionOffsetTimeMs !== undefined ? { insertionOffsetTimeMs: args.insertionOffsetTimeMs } : {})
    };
    return write(auth,
      () => youtubeDataWrite(accessToken, "liveBroadcasts/cuepoint", { id: args.broadcastId }, cuepoint, "POST"),
      body => ({ adBreak: true, cuepointId: body?.id, broadcastId: args.broadcastId, title: item.snippet?.title, durationSecs: body?.durationSecs ?? cuepoint.durationSecs, ...(args.walltime ? { walltime: args.walltime } : {}) }));
  }));
}
