// YouTube tools beyond the basics in tools.js: channel settings, video settings and scheduling,
// thumbnails, translations, playlist management, comments, livestreams, per-video analytics and
// public research (search, competitor videos and channels).
//
// Quota (YouTube Data API, 10,000 units/day by default): reads cost 1, writes about 50,
// thumbnails 50, search 100. Analytics API calls do not count against it.
// No tool here uploads or deletes videos.
import { z } from "zod";
import { youtubeData, youtubeDataWrite, youtubeUploadMedia, youtubeAnalytics, youtubeRetry } from "./providers.js";

export const YOUTUBE_EXTRA_TOOL_NAMES = [
  "youtube_get_channel", "youtube_update_channel",
  "youtube_update_video_settings", "youtube_set_thumbnail", "youtube_set_video_translations",
  "youtube_update_playlist", "youtube_list_playlist_items", "youtube_move_in_playlist", "youtube_remove_from_playlist",
  "youtube_list_comments", "youtube_reply_comment", "youtube_moderate_comments",
  "youtube_list_broadcasts", "youtube_video_report",
  "youtube_search", "youtube_public_videos", "youtube_public_channel"
];

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const langCode = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).describe("BCP-47 language, e.g. hi, en, en-GB");
const watch = id => `https://www.youtube.com/watch?v=${id}`;
const errorMessage = response => response.body?.error?.message || (typeof response.body === "string" ? response.body.slice(0, 200) : "") || `YouTube returned ${response.status}.`;

// Keywords on a channel are one space-separated string; multi-word keywords are quoted.
export const joinKeywords = list => list.map(k => k.trim().replace(/"/g, "")).filter(Boolean).map(k => (/\s/.test(k) ? `"${k}"` : k)).join(" ");
export const splitKeywords = text => (String(text || "").match(/"[^"]+"|\S+/g) || []).map(k => k.replace(/^"|"$/g, ""));

// Thumbnails: accept only JPEG or PNG, checked by their first bytes.
export function imageType(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return null;
}

// Image URLs are fetched server-side, so refuse anything that points at a private network.
export function isPublicHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^(\d+\.){3}\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  if (host.includes(":")) return false; // IPv6 literals: not needed for image hosts
  return true;
}

async function downloadImage(imageUrl) {
  let url = imageUrl;
  for (let hop = 0; hop < 4; hop++) {
    if (!isPublicHttpsUrl(url)) return { error: "The image URL must be a public https address." };
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) { url = new URL(response.headers.get("location"), url).toString(); continue; }
    if (!response.ok) return { error: `The image URL returned ${response.status}.` };
    if (Number(response.headers.get("content-length") || 0) > MAX_THUMBNAIL_BYTES) return { error: "The image is larger than YouTube's 2 MB thumbnail limit." };
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes };
  }
  return { error: "The image URL redirected too many times." };
}

export function registerYouTubeExtraTools(server, { forUser, reply, result, missingWriteScope, videoId, playlistId, noAngles, period, periodInput, reconnect }) {
  const yt = handler => forUser("youtube", handler);
  const myChannel = async accessToken => {
    const response = await youtubeData(accessToken, "channels", { part: "id,contentDetails", mine: "true" });
    const item = response.ok ? response.body?.items?.[0] : null;
    return item ? { id: item.id, uploads: item.contentDetails?.relatedPlaylists?.uploads } : null;
  };
  // Runs a write; a read-only grant becomes a reconnect message, other errors the platform's.
  // Posting a comment is not retried: a timed-out retry could post it twice.
  const write = async (auth, call, shape, { retry = true } = {}) => {
    const response = retry ? await youtubeRetry(call) : await call();
    if (missingWriteScope(response)) return reconnect(auth);
    return reply(response, shape);
  };
  const playlistItems = async (accessToken, id, limit = 500) => {
    const items = [];
    let pageToken;
    do {
      const page = await youtubeData(accessToken, "playlistItems", { part: "snippet,contentDetails,status", playlistId: id, maxResults: 50, pageToken });
      if (!page.ok) return { error: page };
      items.push(...(page.body.items || []));
      pageToken = page.body.nextPageToken;
    } while (pageToken && items.length < limit);
    return { items };
  };
  const statsFor = async (accessToken, ids, parts = "snippet,statistics,contentDetails") => {
    if (!ids.length) return new Map();
    const response = await youtubeData(accessToken, "videos", { part: parts, id: ids.slice(0, 50).join(",") });
    return new Map((response.ok ? response.body.items || [] : []).map(item => [item.id, item]));
  };
  const publicVideo = item => ({
    videoId: item.id, title: item.snippet?.title, channelTitle: item.snippet?.channelTitle, channelId: item.snippet?.channelId,
    publishedAt: item.snippet?.publishedAt, duration: item.contentDetails?.duration, tags: item.snippet?.tags || [],
    categoryId: item.snippet?.categoryId, defaultLanguage: item.snippet?.defaultLanguage, defaultAudioLanguage: item.snippet?.defaultAudioLanguage,
    views: Number(item.statistics?.viewCount || 0), likes: item.statistics?.likeCount !== undefined ? Number(item.statistics.likeCount) : null,
    comments: item.statistics?.commentCount !== undefined ? Number(item.statistics.commentCount) : null,
    liveBroadcastContent: item.snippet?.liveBroadcastContent, description: (item.snippet?.description || "").slice(0, 600), url: watch(item.id)
  });

  /* ---------------- Channel ---------------- */

  server.registerTool("youtube_get_channel", {
    title: "YouTube Get Channel",
    description: "The connected channel's settings and totals: name, handle, description, keywords, country, default language, trailer, subscribers, total views, video count and uploads playlist.",
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, yt(async ({ accessToken }) => reply(
    await youtubeData(accessToken, "channels", { part: "snippet,statistics,brandingSettings,contentDetails,status", mine: "true" }),
    body => {
      const c = body.items?.[0];
      if (!c) return { error: "no_channel" };
      return {
        channelId: c.id, title: c.snippet?.title, handle: c.snippet?.customUrl, description: c.brandingSettings?.channel?.description ?? c.snippet?.description,
        keywords: splitKeywords(c.brandingSettings?.channel?.keywords), country: c.brandingSettings?.channel?.country || c.snippet?.country,
        defaultLanguage: c.brandingSettings?.channel?.defaultLanguage || c.snippet?.defaultLanguage, trailerVideoId: c.brandingSettings?.channel?.unsubscribedTrailer,
        subscribers: Number(c.statistics?.subscriberCount || 0), views: Number(c.statistics?.viewCount || 0), videoCount: Number(c.statistics?.videoCount || 0),
        uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads, madeForKids: c.status?.madeForKids, publishedAt: c.snippet?.publishedAt,
        url: c.snippet?.customUrl ? `https://www.youtube.com/${c.snippet.customUrl}` : `https://www.youtube.com/channel/${c.id}`
      };
    }
  )));

  server.registerTool("youtube_update_channel", {
    title: "YouTube Update Channel",
    description: "Change the channel's description, keywords, country, default language or trailer (the video shown to non-subscribers). Only the fields given change. Returns before and after. Confirm with the user before calling.",
    inputSchema: {
      description: z.string().max(1000).refine(noAngles, "Cannot contain < or >").optional().describe("Max 1000 characters"),
      keywords: z.array(z.string().min(1).max(100)).max(50).optional().describe("Replaces all channel keywords; about 500 characters total"),
      country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe("2-letter country code, e.g. IN"),
      defaultLanguage: langCode.optional(),
      trailerVideoId: videoId.optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    const changes = ["description", "keywords", "country", "defaultLanguage", "trailerVideoId"].filter(k => args[k] !== undefined);
    if (!changes.length) return result({ error: "nothing_to_change", error_description: "Give at least one field to change." }, true);
    if (args.keywords && joinKeywords(args.keywords).length > 500) return result({ error: "too_long", error_description: "Channel keywords must total 500 characters or fewer." }, true);
    const current = await youtubeData(accessToken, "channels", { part: "brandingSettings", mine: "true" });
    if (!current.ok) return reply(current);
    const c = current.body?.items?.[0];
    if (!c) return result({ error: "no_channel", error_description: "No channel found for this connection." }, true);
    const old = c.brandingSettings?.channel || {};
    const channel = {
      ...old,
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.keywords ? { keywords: joinKeywords(args.keywords) } : {}),
      ...(args.country ? { country: args.country.toUpperCase() } : {}),
      ...(args.defaultLanguage ? { defaultLanguage: args.defaultLanguage } : {}),
      ...(args.trailerVideoId ? { unsubscribedTrailer: args.trailerVideoId } : {})
    };
    const pick = s => ({ description: s.description, keywords: splitKeywords(s.keywords), country: s.country, defaultLanguage: s.defaultLanguage, trailerVideoId: s.unsubscribedTrailer });
    return write(auth, () => youtubeDataWrite(accessToken, "channels", { part: "brandingSettings" }, { id: c.id, brandingSettings: { ...c.brandingSettings, channel } }),
      body => ({ changed: changes, before: pick(old), after: pick(body?.brandingSettings?.channel || channel) }));
  }));

  /* ---------------- Video settings, thumbnails, translations ---------------- */

  server.registerTool("youtube_update_video_settings", {
    title: "YouTube Update Video Settings",
    description: "Change a video's privacy (public, unlisted, private), schedule it to go public at a time (publishAt; the video must be private), set made-for-kids, embedding, public like counts, licence or the altered/synthetic content label. Only the fields given change. Returns before and after. Privacy changes affect who can watch: confirm with the user before calling.",
    inputSchema: {
      videoId,
      privacyStatus: z.enum(["public", "unlisted", "private"]).optional(),
      publishAt: z.string().datetime({ offset: true }).optional().describe("ISO 8601, e.g. 2026-11-25T18:30:00+05:30; video must be private"),
      clearSchedule: z.boolean().optional().describe("true removes an existing publishAt"),
      selfDeclaredMadeForKids: z.boolean().optional(),
      embeddable: z.boolean().optional(),
      publicStatsViewable: z.boolean().optional(),
      license: z.enum(["youtube", "creativeCommon"]).optional(),
      containsSyntheticMedia: z.boolean().optional().describe("Altered or synthetic content disclosure")
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    const keys = ["privacyStatus", "publishAt", "clearSchedule", "selfDeclaredMadeForKids", "embeddable", "publicStatsViewable", "license", "containsSyntheticMedia"];
    const changes = keys.filter(k => args[k] !== undefined);
    if (!changes.length) return result({ error: "nothing_to_change", error_description: "Give at least one setting to change." }, true);
    const current = await youtubeData(accessToken, "videos", { part: "status", id: args.videoId });
    if (!current.ok) return reply(current);
    const old = current.body?.items?.[0]?.status;
    if (!old) return result({ error: "not_found", error_description: `No video ${args.videoId} on this channel.` }, true);
    const privacy = args.privacyStatus ?? old.privacyStatus;
    const publishAt = args.clearSchedule ? undefined : (args.publishAt ?? old.publishAt);
    if (publishAt && privacy !== "private") return result({ error: "invalid_schedule", error_description: "A scheduled video (publishAt) must stay private until it publishes. Set privacyStatus to private, or clearSchedule." }, true);
    if (args.publishAt && Date.parse(args.publishAt) <= Date.now()) return result({ error: "invalid_schedule", error_description: "publishAt must be in the future." }, true);
    // status is replaced as a whole: send the writable fields back.
    const status = {
      privacyStatus: privacy,
      embeddable: args.embeddable ?? old.embeddable,
      license: args.license ?? old.license,
      publicStatsViewable: args.publicStatsViewable ?? old.publicStatsViewable,
      ...((args.selfDeclaredMadeForKids ?? old.selfDeclaredMadeForKids) !== undefined ? { selfDeclaredMadeForKids: args.selfDeclaredMadeForKids ?? old.selfDeclaredMadeForKids } : {}),
      ...((args.containsSyntheticMedia ?? old.containsSyntheticMedia) !== undefined ? { containsSyntheticMedia: args.containsSyntheticMedia ?? old.containsSyntheticMedia } : {}),
      ...(publishAt ? { publishAt } : {})
    };
    const pick = s => ({ privacyStatus: s.privacyStatus, publishAt: s.publishAt || null, madeForKids: s.madeForKids ?? s.selfDeclaredMadeForKids, embeddable: s.embeddable, publicStatsViewable: s.publicStatsViewable, license: s.license, containsSyntheticMedia: s.containsSyntheticMedia });
    return write(auth, () => youtubeDataWrite(accessToken, "videos", { part: "status" }, { id: args.videoId, status }),
      body => ({ videoId: args.videoId, changed: changes, before: pick(old), after: pick(body?.status || status), url: watch(args.videoId) }));
  }));

  server.registerTool("youtube_set_thumbnail", {
    title: "YouTube Set Thumbnail",
    description: "Replace a video's thumbnail with a JPEG or PNG (max 2 MB, ideally 1280×720) from a public https URL or base64 data. The channel must be phone-verified for custom thumbnails. Confirm with the user before calling.",
    inputSchema: {
      videoId,
      imageUrl: z.string().url().max(2000).optional().describe("Public https URL of a JPEG or PNG"),
      imageBase64: z.string().max(3_000_000).optional().describe("JPEG or PNG bytes as base64 (a data: URL prefix is fine)")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    if (!args.imageUrl === !args.imageBase64) return result({ error: "bad_input", error_description: "Give exactly one of imageUrl or imageBase64." }, true);
    let bytes;
    if (args.imageUrl) {
      const download = await downloadImage(args.imageUrl).catch(error => ({ error: `Could not download the image: ${error.message}` }));
      if (download.error) return result({ error: "bad_image", error_description: download.error }, true);
      bytes = download.bytes;
    } else {
      bytes = Buffer.from(args.imageBase64.replace(/^data:[^,]*,/, ""), "base64");
    }
    if (bytes.length > MAX_THUMBNAIL_BYTES) return result({ error: "bad_image", error_description: "The image is larger than YouTube's 2 MB thumbnail limit." }, true);
    const type = imageType(bytes);
    if (!type) return result({ error: "bad_image", error_description: "The thumbnail must be a JPEG or PNG image." }, true);
    const response = await youtubeRetry(() => youtubeUploadMedia(accessToken, "thumbnails/set", { videoId: args.videoId }, bytes, type));
    if (missingWriteScope(response)) return reconnect(auth);
    if (response.status === 403) return result({ error: "thumbnail_not_allowed", error_description: `${errorMessage(response)} Custom thumbnails need a phone-verified channel: https://www.youtube.com/verify` }, true);
    return reply(response, body => ({ videoId: args.videoId, bytes: bytes.length, contentType: type, thumbnails: body?.items?.[0] || null, url: watch(args.videoId) }));
  }));

  server.registerTool("youtube_set_video_translations", {
    title: "YouTube Set Video Translations",
    description: "Add or change translated titles and descriptions for a video, so viewers in other languages see them in their language. Existing translations are kept unless listed in removeLanguages. The video needs a default language (set it here with defaultLanguage if missing). Confirm the text with the user before calling.",
    inputSchema: {
      videoId,
      defaultLanguage: langCode.optional().describe("Language of the main title/description, if not set yet"),
      translations: z.record(langCode, z.object({
        title: z.string().min(1).max(100).refine(noAngles, "Cannot contain < or >"),
        description: z.string().max(5000).refine(noAngles, "Cannot contain < or >").optional()
      })).optional().describe("e.g. { \"hi\": { \"title\": \"…\", \"description\": \"…\" } }"),
      removeLanguages: z.array(langCode).max(50).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    if (!args.translations && !args.removeLanguages && !args.defaultLanguage) return result({ error: "nothing_to_change", error_description: "Give translations, removeLanguages or defaultLanguage." }, true);
    const current = await youtubeData(accessToken, "videos", { part: "snippet,localizations", id: args.videoId });
    if (!current.ok) return reply(current);
    const item = current.body?.items?.[0];
    if (!item) return result({ error: "not_found", error_description: `No video ${args.videoId} on this channel.` }, true);
    const old = item.snippet || {};
    const defaultLanguage = args.defaultLanguage || old.defaultLanguage;
    if (!defaultLanguage) return result({ error: "default_language_required", error_description: "This video has no default language. Pass defaultLanguage (the language of its current title) too." }, true);
    const localizations = { ...(item.localizations || {}) };
    for (const [lang, text] of Object.entries(args.translations || {})) localizations[lang] = { title: text.title, description: text.description ?? localizations[lang]?.description ?? "" };
    for (const lang of args.removeLanguages || []) delete localizations[lang];
    const snippet = {
      title: old.title, description: old.description ?? "", categoryId: old.categoryId, defaultLanguage,
      ...(old.tags ? { tags: old.tags } : {}), ...(old.defaultAudioLanguage ? { defaultAudioLanguage: old.defaultAudioLanguage } : {})
    };
    return write(auth, () => youtubeDataWrite(accessToken, "videos", { part: "snippet,localizations" }, { id: args.videoId, snippet, localizations }),
      body => ({ videoId: args.videoId, defaultLanguage, languages: Object.keys(body?.localizations || localizations), translations: body?.localizations || localizations, url: watch(args.videoId) }));
  }));

  /* ---------------- Playlists ---------------- */

  server.registerTool("youtube_update_playlist", {
    title: "YouTube Update Playlist",
    description: "Rename a playlist or change its description, privacy or language. Only the fields given change. Returns before and after. Confirm with the user before calling.",
    inputSchema: {
      playlistId,
      title: z.string().min(1).max(150).refine(noAngles, "Cannot contain < or >").optional(),
      description: z.string().max(5000).refine(noAngles, "Cannot contain < or >").optional(),
      privacyStatus: z.enum(["public", "unlisted", "private"]).optional(),
      defaultLanguage: langCode.optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    const changes = ["title", "description", "privacyStatus", "defaultLanguage"].filter(k => args[k] !== undefined);
    if (!changes.length) return result({ error: "nothing_to_change", error_description: "Give at least one field to change." }, true);
    const current = await youtubeData(accessToken, "playlists", { part: "snippet,status", id: args.playlistId });
    if (!current.ok) return reply(current);
    const item = current.body?.items?.[0];
    if (!item) return result({ error: "not_found", error_description: `No playlist ${args.playlistId} on this channel.` }, true);
    const old = { ...item.snippet, privacyStatus: item.status?.privacyStatus };
    const snippet = {
      title: args.title ?? old.title, description: args.description ?? old.description ?? "",
      ...((args.defaultLanguage ?? old.defaultLanguage) ? { defaultLanguage: args.defaultLanguage ?? old.defaultLanguage } : {})
    };
    const status = { privacyStatus: args.privacyStatus ?? old.privacyStatus };
    const pick = s => ({ title: s.title, description: s.description, privacyStatus: s.privacyStatus, defaultLanguage: s.defaultLanguage });
    return write(auth, () => youtubeDataWrite(accessToken, "playlists", { part: "snippet,status" }, { id: args.playlistId, snippet, status }),
      body => ({ playlistId: args.playlistId, changed: changes, before: pick(old), after: pick({ ...(body?.snippet || snippet), privacyStatus: body?.status?.privacyStatus || status.privacyStatus }), url: `https://www.youtube.com/playlist?list=${args.playlistId}` }));
  }));

  server.registerTool("youtube_list_playlist_items", {
    title: "YouTube List Playlist Items",
    description: "The videos in a playlist in their current order: position, video ID, title, privacy and the playlist item ID.",
    inputSchema: { playlistId }, annotations: { readOnlyHint: true }
  }, yt(async ({ accessToken, args }) => {
    const { items, error } = await playlistItems(accessToken, args.playlistId);
    if (error) return reply(error);
    return result({ playlistId: args.playlistId, count: items.length, items: items.map(item => ({ position: item.snippet?.position, videoId: item.contentDetails?.videoId, title: item.snippet?.title, privacyStatus: item.status?.privacyStatus, playlistItemId: item.id })) });
  }));

  server.registerTool("youtube_move_in_playlist", {
    title: "YouTube Move In Playlist",
    description: "Move a video to a new position in a playlist (0 = first).",
    inputSchema: { playlistId, videoId, position: z.number().int().min(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    const { items, error } = await playlistItems(accessToken, args.playlistId);
    if (error) return reply(error);
    const item = items.find(i => i.contentDetails?.videoId === args.videoId);
    if (!item) return result({ error: "not_in_playlist", error_description: `Video ${args.videoId} is not in this playlist.` }, true);
    const position = Math.min(args.position, items.length - 1);
    return write(auth, () => youtubeDataWrite(accessToken, "playlistItems", { part: "snippet" }, { id: item.id, snippet: { playlistId: args.playlistId, resourceId: { kind: "youtube#video", videoId: args.videoId }, position } }),
      () => ({ playlistId: args.playlistId, videoId: args.videoId, from: item.snippet?.position, to: position }));
  }));

  server.registerTool("youtube_remove_from_playlist", {
    title: "YouTube Remove From Playlist",
    description: "Take videos out of a playlist. The videos themselves are not deleted. Confirm with the user before calling.",
    inputSchema: { playlistId, videoIds: z.array(videoId).min(1).max(50) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    const { items, error } = await playlistItems(accessToken, args.playlistId);
    if (error) return reply(error);
    const removed = [], notInPlaylist = [], failed = [];
    for (const vid of new Set(args.videoIds)) {
      const matches = items.filter(i => i.contentDetails?.videoId === vid);
      if (!matches.length) { notInPlaylist.push(vid); continue; }
      for (const item of matches) {
        const response = await youtubeRetry(() => youtubeDataWrite(accessToken, "playlistItems", { id: item.id }, undefined, "DELETE"));
        if (missingWriteScope(response)) return reconnect(auth);
        if (response.ok) removed.push(vid); else failed.push({ videoId: vid, status: response.status, error: errorMessage(response) });
      }
    }
    return result({ playlistId: args.playlistId, removed: [...new Set(removed)], notInPlaylist, failed }, !removed.length && failed.length > 0);
  }));

  /* ---------------- Comments ---------------- */

  server.registerTool("youtube_list_comments", {
    title: "YouTube List Comments",
    description: "Comment threads on one video, or across the whole connected channel if no videoId is given: author, text, likes, date, reply count, whether the channel has replied, and IDs for replying or moderating. moderationStatus heldForReview or likelySpam shows comments waiting in the channel's review queue. Also works on any public video (videoId) for research.",
    inputSchema: {
      videoId: videoId.optional(),
      order: z.enum(["time", "relevance"]).optional().describe("Default time (newest first)"),
      searchTerms: z.string().max(100).optional(),
      moderationStatus: z.enum(["published", "heldForReview", "likelySpam"]).optional().describe("Default published"),
      maxResults: z.number().int().min(1).max(100).optional().describe("Default 20")
    },
    annotations: { readOnlyHint: true }
  }, yt(async ({ accessToken, args }) => {
    const mine = await myChannel(accessToken);
    const params = { part: "snippet,replies", order: args.order || "time", searchTerms: args.searchTerms, moderationStatus: args.moderationStatus, maxResults: args.maxResults || 20, textFormat: "plainText" };
    if (args.videoId) params.videoId = args.videoId;
    else if (mine) params.allThreadsRelatedToChannelId = mine.id;
    else return result({ error: "no_channel", error_description: "No channel found for this connection." }, true);
    return reply(await youtubeData(accessToken, "commentThreads", params), body => ({
      scope: args.videoId ? { videoId: args.videoId } : { channel: mine?.id },
      threads: (body.items || []).map(thread => {
        const top = thread.snippet?.topLevelComment;
        const replies = (thread.replies?.comments || []).map(c => ({ commentId: c.id, author: c.snippet?.authorDisplayName, isChannel: c.snippet?.authorChannelId?.value === mine?.id, text: c.snippet?.textDisplay, likes: c.snippet?.likeCount, publishedAt: c.snippet?.publishedAt }));
        return {
          threadId: thread.id, commentId: top?.id, videoId: thread.snippet?.videoId, author: top?.snippet?.authorDisplayName,
          isChannel: top?.snippet?.authorChannelId?.value === mine?.id, text: top?.snippet?.textDisplay, likes: top?.snippet?.likeCount,
          publishedAt: top?.snippet?.publishedAt, replyCount: thread.snippet?.totalReplyCount, canReply: thread.snippet?.canReply,
          channelReplied: replies.some(r => r.isChannel), replies
        };
      })
    }));
  }));

  server.registerTool("youtube_reply_comment", {
    title: "YouTube Reply To Comment",
    description: "Post a public reply, as the channel, to a top-level comment (commentId from youtube_list_comments). Show the user the exact reply and get their OK before calling.",
    inputSchema: { commentId: z.string().min(5).max(100), text: z.string().min(1).max(10000) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, yt(async ({ auth, accessToken, args }) => write(auth,
    () => youtubeDataWrite(accessToken, "comments", { part: "snippet" }, { snippet: { parentId: args.commentId, textOriginal: args.text } }, "POST"),
    body => ({ replyId: body?.id, parentId: args.commentId, text: body?.snippet?.textDisplay ?? args.text }),
    { retry: false }
  )));

  server.registerTool("youtube_moderate_comments", {
    title: "YouTube Moderate Comments",
    description: "Approve (published), hold for review, or reject (hide) comments on the channel's videos; rejecting can also ban the author from commenting. Confirm with the user before calling.",
    inputSchema: {
      commentIds: z.array(z.string().min(5).max(100)).min(1).max(50),
      moderationStatus: z.enum(["published", "heldForReview", "rejected"]),
      banAuthor: z.boolean().optional().describe("Only with rejected")
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    if (args.banAuthor && args.moderationStatus !== "rejected") return result({ error: "bad_input", error_description: "banAuthor only works with moderationStatus rejected." }, true);
    return write(auth,
      () => youtubeDataWrite(accessToken, "comments/setModerationStatus", { id: args.commentIds.join(","), moderationStatus: args.moderationStatus, banAuthor: args.banAuthor ? "true" : undefined }, undefined, "POST"),
      () => ({ commentIds: args.commentIds, moderationStatus: args.moderationStatus, banAuthor: Boolean(args.banAuthor) }));
  }));

  /* ---------------- Livestreams ---------------- */

  server.registerTool("youtube_list_broadcasts", {
    title: "YouTube List Livestreams",
    description: "The channel's livestreams (including PS5 and mobile streams): title, status, scheduled and actual start/end, live concurrent viewers while active, views, likes and comments.",
    inputSchema: {
      broadcastStatus: z.enum(["all", "upcoming", "active", "completed"]).optional().describe("Default all"),
      maxResults: z.number().int().min(1).max(50).optional().describe("Default 20")
    },
    annotations: { readOnlyHint: true }
  }, yt(async ({ accessToken, args }) => {
    const response = await youtubeData(accessToken, "liveBroadcasts", { part: "snippet,status,contentDetails", broadcastStatus: args.broadcastStatus || "all", broadcastType: "all", maxResults: args.maxResults || 20 });
    if (!response.ok) return reply(response);
    const items = response.body.items || [];
    const stats = await statsFor(accessToken, items.map(b => b.id), "liveStreamingDetails,statistics");
    return result({
      broadcasts: items.map(b => {
        const v = stats.get(b.id);
        return {
          videoId: b.id, title: b.snippet?.title, lifeCycleStatus: b.status?.lifeCycleStatus, privacyStatus: b.status?.privacyStatus,
          scheduledStart: b.snippet?.scheduledStartTime, actualStart: b.snippet?.actualStartTime || v?.liveStreamingDetails?.actualStartTime,
          actualEnd: b.snippet?.actualEndTime || v?.liveStreamingDetails?.actualEndTime,
          concurrentViewers: v?.liveStreamingDetails?.concurrentViewers !== undefined ? Number(v.liveStreamingDetails.concurrentViewers) : null,
          views: v?.statistics ? Number(v.statistics.viewCount || 0) : null, likes: v?.statistics?.likeCount !== undefined ? Number(v.statistics.likeCount) : null,
          comments: v?.statistics?.commentCount !== undefined ? Number(v.statistics.commentCount) : null,
          dvr: b.contentDetails?.enableDvr, url: watch(b.id)
        };
      })
    });
  }));

  /* ---------------- Per-video analytics ---------------- */

  server.registerTool("youtube_video_report", {
    title: "YouTube Video Report",
    description: "Everything about one video's performance in a period: totals (views, watch time, average view duration and percentage, likes, comments, shares, subscribers), live vs on-demand views, traffic sources, top YouTube search terms, and the audience retention curve (share of viewers still watching at each point, plus retention compared with similar videos). Default: last 28 days ending yesterday.",
    inputSchema: { videoId, ...periodInput }, annotations: { readOnlyHint: true }
  }, yt(async ({ accessToken, args }) => {
    const { startDate, endDate } = period(args);
    const filters = `video==${args.videoId}`;
    const base = { startDate, endDate, filters };
    const [totals, live, sources, terms, retention] = await Promise.all([
      youtubeAnalytics(accessToken, { ...base, metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained" }),
      youtubeAnalytics(accessToken, { ...base, metrics: "views,estimatedMinutesWatched", dimensions: "liveOrOnDemand" }),
      youtubeAnalytics(accessToken, { ...base, metrics: "views,estimatedMinutesWatched", dimensions: "insightTrafficSourceType", sort: "-views" }),
      youtubeAnalytics(accessToken, { ...base, filters: `${filters};insightTrafficSourceType==YT_SEARCH`, metrics: "views", dimensions: "insightTrafficSourceDetail", sort: "-views", maxResults: 15 }),
      youtubeAnalytics(accessToken, { ...base, metrics: "audienceWatchRatio,relativeRetentionPerformance", dimensions: "elapsedVideoTimeRatio" })
    ]);
    if (!totals.ok) return reply(totals);
    // The retention curve has 100 points; every 10th is enough to read it.
    const curve = retention.ok ? retention.body.rows.filter((_, i, all) => i % 10 === 0 || i === all.length - 1) : [];
    const rows = r => (r.ok ? r.body.rows : { error: r.status });
    return result({
      videoId: args.videoId, startDate, endDate, url: watch(args.videoId),
      totals: totals.body.rows[0] || {}, liveVsOnDemand: rows(live), trafficSources: rows(sources), searchTerms: rows(terms),
      retention: retention.ok ? curve : { error: retention.status, note: "Retention needs enough views in the period." }
    });
  }));

  /* ---------------- Public research ---------------- */

  server.registerTool("youtube_search", {
    title: "YouTube Search",
    description: "Search all of YouTube like a viewer would, for keyword and competitor research: videos with views, likes, comments, duration, tags and channel; or channels and playlists. Costs 100 of the 10,000 daily quota units per call, so search deliberately.",
    inputSchema: {
      query: z.string().min(1).max(200),
      type: z.enum(["video", "channel", "playlist"]).optional().describe("Default video"),
      order: z.enum(["relevance", "viewCount", "date", "rating"]).optional().describe("Default relevance"),
      regionCode: z.string().regex(/^[A-Za-z]{2}$/).optional().describe("e.g. IN, US"),
      relevanceLanguage: z.string().max(10).optional().describe("e.g. hi, en"),
      publishedAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
      videoDuration: z.enum(["any", "short", "medium", "long"]).optional().describe("short <4 min, medium 4–20, long >20"),
      eventType: z.enum(["live", "upcoming", "completed"]).optional().describe("Livestreams only (videos)"),
      maxResults: z.number().int().min(1).max(25).optional().describe("Default 10")
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, yt(async ({ accessToken, args }) => {
    const type = args.type || "video";
    const response = await youtubeData(accessToken, "search", {
      part: "snippet", q: args.query, type, order: args.order || "relevance", regionCode: args.regionCode?.toUpperCase(), relevanceLanguage: args.relevanceLanguage,
      publishedAfter: args.publishedAfter ? `${args.publishedAfter}T00:00:00Z` : undefined, maxResults: args.maxResults || 10,
      ...(type === "video" ? { videoDuration: args.videoDuration, eventType: args.eventType } : {})
    });
    if (!response.ok) return reply(response);
    const items = response.body.items || [];
    if (type !== "video") return result({ query: args.query, type, totalResults: response.body.pageInfo?.totalResults, results: items.map(i => ({ id: i.id?.channelId || i.id?.playlistId, title: i.snippet?.title, channelTitle: i.snippet?.channelTitle, description: i.snippet?.description, publishedAt: i.snippet?.publishedAt })) });
    const stats = await statsFor(accessToken, items.map(i => i.id?.videoId).filter(Boolean));
    return result({ query: args.query, type, totalResults: response.body.pageInfo?.totalResults, results: items.map(i => stats.get(i.id?.videoId)).filter(Boolean).map(publicVideo) });
  }));

  server.registerTool("youtube_public_videos", {
    title: "YouTube Public Videos",
    description: "Public details of any YouTube videos by ID (yours or competitors'): title, channel, tags, category, languages, views, likes, comments, duration, publish date and the start of the description.",
    inputSchema: { videoIds: z.array(videoId).min(1).max(50) }, annotations: { readOnlyHint: true, openWorldHint: true }
  }, yt(async ({ accessToken, args }) => {
    const stats = await statsFor(accessToken, [...new Set(args.videoIds)]);
    return result({ videos: args.videoIds.map(id => stats.get(id)).filter(Boolean).map(publicVideo), notFound: args.videoIds.filter(id => !stats.has(id)) });
  }));

  server.registerTool("youtube_public_channel", {
    title: "YouTube Public Channel",
    description: "Any public channel by @handle or channel ID: subscribers, total views, video count, description, keywords, country, and its latest uploads with views, tags and duration, plus the average views of those uploads. Use it to study competitors.",
    inputSchema: {
      handle: z.string().regex(/^@?[A-Za-z0-9._-]{3,100}$/).optional().describe("e.g. @mythpat"),
      channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/).optional(),
      latestVideos: z.number().int().min(0).max(25).optional().describe("Default 10")
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, yt(async ({ accessToken, args }) => {
    if (!args.handle === !args.channelId) return result({ error: "bad_input", error_description: "Give exactly one of handle or channelId." }, true);
    const response = await youtubeData(accessToken, "channels", { part: "snippet,statistics,brandingSettings,contentDetails", ...(args.channelId ? { id: args.channelId } : { forHandle: args.handle.startsWith("@") ? args.handle : `@${args.handle}` }) });
    if (!response.ok) return reply(response);
    const c = response.body?.items?.[0];
    if (!c) return result({ error: "not_found", error_description: "No channel found with that handle or ID." }, true);
    const n = args.latestVideos ?? 10;
    let latest = [];
    if (n > 0 && c.contentDetails?.relatedPlaylists?.uploads) {
      const page = await youtubeData(accessToken, "playlistItems", { part: "contentDetails", playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: n });
      const ids = page.ok ? (page.body.items || []).map(i => i.contentDetails?.videoId).filter(Boolean) : [];
      const stats = await statsFor(accessToken, ids);
      latest = ids.map(id => stats.get(id)).filter(Boolean).map(publicVideo);
    }
    return result({
      channelId: c.id, title: c.snippet?.title, handle: c.snippet?.customUrl, country: c.snippet?.country, publishedAt: c.snippet?.publishedAt,
      subscribers: c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount || 0), views: Number(c.statistics?.viewCount || 0), videoCount: Number(c.statistics?.videoCount || 0),
      description: (c.snippet?.description || "").slice(0, 1000), keywords: splitKeywords(c.brandingSettings?.channel?.keywords),
      latestVideos: latest, averageViewsLatest: latest.length ? Math.round(latest.reduce((sum, v) => sum + v.views, 0) / latest.length) : null,
      url: c.snippet?.customUrl ? `https://www.youtube.com/${c.snippet.customUrl}` : `https://www.youtube.com/channel/${c.id}`
    });
  }));
}
