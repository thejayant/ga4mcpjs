// YouTube tools that move media: video upload (resumable), video delete, and captions
// (list, download, upload/replace, delete).
//
// Uploads use YouTube's resumable protocol so large files work on a serverless host:
// - From a URL: the server streams the file to YouTube until its time budget runs out, then
//   returns the session so youtube_continue_upload picks up from the exact byte YouTube has.
//   The source must send Content-Length and, to resume, support Range requests.
// - From the user's computer: with no videoUrl the tool only opens the session and returns a
//   ready-to-run curl command; the file never passes through this server.
// Note: projects Google hasn't audited get uploads locked to private (YouTube policy).
import { z } from "zod";
import { youtubeData, youtubeDataWrite, youtubeRetry } from "./providers.js";
import { isPublicHttpsUrl } from "./_youtube-tools.js";

export const YOUTUBE_MEDIA_TOOL_NAMES = [
  "youtube_upload_video", "youtube_continue_upload", "youtube_delete_video",
  "youtube_list_captions", "youtube_download_caption", "youtube_upload_caption", "youtube_delete_caption"
];

const UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";
const SESSION_PREFIX = `${UPLOAD_BASE}/videos?`;
const budgetMs = () => Number(process.env.YOUTUBE_UPLOAD_BUDGET_MS || 50_000);
const MAX_CAPTION_CHARS = 1_000_000;
const watch = id => `https://www.youtube.com/watch?v=${id}`;
const message = (status, body) => body?.error?.message || (typeof body === "string" ? body.slice(0, 200) : "") || `YouTube returned ${status}.`;
const readBody = async response => { const text = await response.text(); try { return text ? JSON.parse(text) : null; } catch { return text; } };

// Only YouTube's own resumable upload endpoint is accepted as a session URL.
export const isUploadSession = value => typeof value === "string" && value.startsWith(SESSION_PREFIX) && /[?&]upload_id=/.test(value);

// Follows redirects by hand so every hop is re-checked against private hosts.
async function openSource(videoUrl, offset = 0) {
  let url = videoUrl;
  for (let hop = 0; hop < 5; hop++) {
    if (!isPublicHttpsUrl(url)) return { error: "The video URL must be a public https address." };
    const response = await fetch(url, { redirect: "manual", headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) { await response.body?.cancel(); url = new URL(response.headers.get("location"), url).toString(); continue; }
    if (!response.ok) return { error: `The video URL returned ${response.status}.` };
    if (offset && response.status !== 206) { await response.body?.cancel(); return { error: "The video host does not support resuming (Range requests). Re-run youtube_upload_video without videoUrl and upload from your computer with the curl command instead." }; }
    const type = (response.headers.get("content-type") || "").split(";")[0].trim();
    const total = offset ? Number((response.headers.get("content-range") || "").split("/")[1]) : Number(response.headers.get("content-length"));
    return { response, type, total: Number.isFinite(total) && total > 0 ? total : null };
  }
  return { error: "The video URL redirected too many times." };
}

// Asks YouTube how many bytes of a session it has. Done → the finished video resource.
async function sessionState(accessToken, sessionUrl, total) {
  const response = await fetch(sessionUrl, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Length": "0", "Content-Range": `bytes */${total ?? "*"}` }, signal: AbortSignal.timeout(30_000) });
  if (response.status === 200 || response.status === 201) return { done: true, video: await readBody(response) };
  if (response.status === 308) { await response.body?.cancel(); const range = response.headers.get("range"); return { received: range ? Number(range.split("-")[1]) + 1 : 0 }; }
  const body = await readBody(response);
  return { error: response.status === 404 || response.status === 410 ? "This upload session has expired (sessions last about a week). Start a new upload." : message(response.status, body), status: response.status };
}

// Streams the source to YouTube from `offset` until done or the time budget is spent.
async function pushBytes(accessToken, sessionUrl, videoUrl, offset, knownTotal) {
  const source = await openSource(videoUrl, offset);
  if (source.error) return { error: source.error };
  const total = knownTotal || source.total;
  if (!total) { await source.response.body?.cancel(); return { error: "The video URL does not report its size (Content-Length). Upload from your computer with the curl command instead." }; }
  const deadline = AbortSignal.timeout(budgetMs());
  try {
    const response = await fetch(sessionUrl, {
      method: "PUT", body: source.response.body, duplex: "half", signal: deadline,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Length": String(total - offset), "Content-Range": `bytes ${offset}-${total - 1}/${total}` }
    });
    if (response.status === 200 || response.status === 201) return { done: true, video: await readBody(response), total };
    await response.body?.cancel();
  } catch (error) {
    if (!deadline.aborted) return { error: `Upload interrupted: ${error.message}. Run youtube_continue_upload to resume.`, total, resumable: true };
  }
  const state = await sessionState(accessToken, sessionUrl, total);
  return state.done ? { ...state, total } : { ...state, total, paused: true };
}

const finished = (video, requestedPrivacy) => ({
  status: "complete", videoId: video?.id, title: video?.snippet?.title, privacyStatus: video?.status?.privacyStatus, uploadStatus: video?.status?.uploadStatus,
  url: video?.id ? watch(video.id) : undefined, studioUrl: video?.id ? `https://studio.youtube.com/video/${video.id}/edit` : undefined,
  ...(requestedPrivacy && requestedPrivacy !== "private" && video?.status?.privacyStatus === "private"
    ? { note: "YouTube locked this upload to private because the Google Cloud project hasn't passed YouTube's API audit. Change it in Studio, or apply for the audit to lift the lock." } : {}),
  next: "YouTube now processes the video (HD can take a while). Set a thumbnail with youtube_set_thumbnail."
});
const progress = (state, sessionUrl, videoUrl) => ({
  status: "in_progress", uploadedBytes: state.received, totalBytes: state.total,
  percent: state.total ? Math.floor((state.received / state.total) * 100) : null, sessionUrl,
  next: `Call youtube_continue_upload with this sessionUrl${videoUrl ? " and the same videoUrl" : ""} to keep going.`
});

// Captions upload as multipart/related: JSON metadata, then the caption file.
function multipart(metadata, text) {
  const boundary = `cap${Math.random().toString(36).slice(2)}`;
  const body = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${text}\r\n--${boundary}--`, "utf8");
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export function registerYouTubeMediaTools(server, { forUser, reply, result, missingWriteScope, videoId, noAngles, reconnect }) {
  const yt = handler => forUser("youtube", handler);
  const langCode = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/);

  /* ---------------- Upload ---------------- */

  server.registerTool("youtube_upload_video", {
    title: "YouTube Upload Video",
    description: "Upload a new video to the connected channel with its title, description, tags, category, privacy, optional scheduled publish time and made-for-kids setting. With videoUrl (a public https link with a known size, e.g. a direct Dropbox/Drive/S3 link) the server streams it; big files continue with youtube_continue_upload. Without videoUrl it opens an upload session and returns a curl command to upload straight from the user's computer (best for large PS5 recordings). Uses about 100 quota units. Confirm the title, description and privacy with the user before calling.",
    inputSchema: {
      title: z.string().min(1).max(100).refine(noAngles, "Cannot contain < or >"),
      description: z.string().max(5000).refine(noAngles, "Cannot contain < or >").optional(),
      tags: z.array(z.string().min(1).max(100)).max(60).optional(),
      categoryId: z.string().regex(/^\d{1,3}$/).optional().describe("Default 20 (Gaming)"),
      defaultLanguage: langCode.optional(),
      defaultAudioLanguage: langCode.optional(),
      privacyStatus: z.enum(["public", "unlisted", "private"]).optional().describe("Default private"),
      publishAt: z.string().datetime({ offset: true }).optional().describe("Schedule: ISO 8601 time; privacy must be private"),
      selfDeclaredMadeForKids: z.boolean().optional().describe("Default false"),
      containsSyntheticMedia: z.boolean().optional(),
      notifySubscribers: z.boolean().optional().describe("Default true"),
      videoUrl: z.string().url().max(4000).optional().describe("Public https link to the video file; omit to upload from your computer"),
      fileSizeBytes: z.number().int().positive().optional().describe("Optional, for the computer upload")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    const privacy = args.privacyStatus || "private";
    if (args.publishAt && privacy !== "private") return result({ error: "invalid_schedule", error_description: "A scheduled upload (publishAt) must be private until it publishes." }, true);
    if (args.publishAt && Date.parse(args.publishAt) <= Date.now()) return result({ error: "invalid_schedule", error_description: "publishAt must be in the future." }, true);
    let source = null;
    if (args.videoUrl) {
      source = await openSource(args.videoUrl).catch(error => ({ error: `Could not open the video URL: ${error.message}` }));
      if (source.error) return result({ error: "bad_source", error_description: source.error }, true);
      await source.response.body?.cancel(); // probe only; the upload re-opens it
      if (!source.total) return result({ error: "bad_source", error_description: "The video URL does not report its size. Omit videoUrl to upload from your computer instead." }, true);
      if (source.type && !/^(video\/|application\/octet-stream|binary\/octet-stream)/.test(source.type)) return result({ error: "bad_source", error_description: `The URL returned ${source.type}, not a video file. Use a direct download link.` }, true);
    }
    const metadata = {
      snippet: {
        title: args.title, description: args.description || "", categoryId: args.categoryId || "20",
        ...(args.tags ? { tags: args.tags } : {}), ...(args.defaultLanguage ? { defaultLanguage: args.defaultLanguage } : {}),
        ...(args.defaultAudioLanguage ? { defaultAudioLanguage: args.defaultAudioLanguage } : {})
      },
      status: {
        privacyStatus: privacy, selfDeclaredMadeForKids: args.selfDeclaredMadeForKids ?? false,
        ...(args.publishAt ? { publishAt: args.publishAt } : {}), ...(args.containsSyntheticMedia !== undefined ? { containsSyntheticMedia: args.containsSyntheticMedia } : {})
      }
    };
    const size = source?.total || args.fileSizeBytes;
    const start = await youtubeRetry(async () => {
      const response = await fetch(`${UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${args.notifySubscribers === false ? "false" : "true"}`, {
        method: "POST", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/*", ...(size ? { "X-Upload-Content-Length": String(size) } : {}) },
        body: JSON.stringify(metadata)
      });
      return { ok: response.ok, status: response.status, location: response.headers.get("location"), body: response.ok ? null : await readBody(response) };
    });
    if (missingWriteScope(start)) return reconnect(auth);
    if (!start.ok || !start.location) return reply(start.ok ? { ok: false, status: 502, body: "YouTube did not return an upload session." } : start);
    const sessionUrl = start.location;
    if (!args.videoUrl) {
      return result({
        status: "awaiting_file", sessionUrl,
        uploadCommand: `curl -X PUT -H "Content-Type: video/*" -T "PATH/TO/VIDEO.mp4" "${sessionUrl}"`,
        instructions: "Run the command on the computer that has the video (replace PATH/TO/VIDEO.mp4). The link works for about a week and needs no login. If it stops halfway, run youtube_continue_upload with the sessionUrl to see how much arrived.",
        title: args.title, privacyStatus: privacy
      });
    }
    const pushed = await pushBytes(accessToken, sessionUrl, args.videoUrl, 0, size);
    if (pushed.done) return result(finished(pushed.video, privacy));
    if (pushed.error && !pushed.resumable && pushed.received === undefined) return result({ error: "upload_failed", error_description: pushed.error, sessionUrl }, true);
    return result(progress(pushed, sessionUrl, args.videoUrl));
  }));

  server.registerTool("youtube_continue_upload", {
    title: "YouTube Continue Upload",
    description: "Resume or check an upload started by youtube_upload_video. With videoUrl it streams the remaining bytes from where YouTube stopped (repeat until complete). Without videoUrl it only reports progress, e.g. for a curl upload from the user's computer.",
    inputSchema: {
      sessionUrl: z.string().max(4000).refine(isUploadSession, "Must be the sessionUrl returned by youtube_upload_video"),
      videoUrl: z.string().url().max(4000).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, yt(async ({ accessToken, args }) => {
    let total = null;
    if (args.videoUrl) {
      const probe = await openSource(args.videoUrl).catch(error => ({ error: error.message }));
      if (probe.error) return result({ error: "bad_source", error_description: probe.error }, true);
      await probe.response.body?.cancel();
      total = probe.total;
    }
    const state = await sessionState(accessToken, args.sessionUrl, total);
    if (state.error) return result({ error: "session_error", error_description: state.error }, true);
    if (state.done) return result(finished(state.video));
    if (!args.videoUrl) return result({ status: "in_progress", uploadedBytes: state.received, sessionUrl: args.sessionUrl, next: "The file is still arriving, or the upload stopped. Re-run the curl command to finish it." });
    const pushed = await pushBytes(accessToken, args.sessionUrl, args.videoUrl, state.received, total);
    if (pushed.done) return result(finished(pushed.video));
    if (pushed.error && pushed.received === undefined && !pushed.resumable) return result({ error: "upload_failed", error_description: pushed.error, sessionUrl: args.sessionUrl }, true);
    return result(progress(pushed, args.sessionUrl, args.videoUrl));
  }));

  /* ---------------- Delete ---------------- */

  server.registerTool("youtube_delete_video", {
    title: "YouTube Delete Video",
    description: "Permanently delete one of the channel's videos, with its views, comments and watch history. This cannot be undone. Only call after the user has explicitly confirmed deleting this exact video in chat; confirmTitle must match the video's current title exactly. Prefer youtube_update_video_settings with privacyStatus private if hiding is enough.",
    inputSchema: { videoId, confirmTitle: z.string().min(1).max(100).describe("The video's exact current title, as a safety check") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    const current = await youtubeData(accessToken, "videos", { part: "snippet,statistics", id: args.videoId });
    if (!current.ok) return reply(current);
    const item = current.body?.items?.[0];
    if (!item) return result({ error: "not_found", error_description: `No video ${args.videoId} on this channel.` }, true);
    if (item.snippet?.title?.trim() !== args.confirmTitle.trim()) return result({ error: "title_mismatch", error_description: `confirmTitle does not match. The current title is "${item.snippet?.title}". Nothing was deleted.` }, true);
    const response = await youtubeDataWrite(accessToken, "videos", { id: args.videoId }, undefined, "DELETE");
    if (missingWriteScope(response)) return reconnect(auth);
    return reply(response, () => ({ deleted: true, videoId: args.videoId, title: item.snippet?.title, viewsLost: Number(item.statistics?.viewCount || 0) }));
  }));

  /* ---------------- Captions ---------------- */

  server.registerTool("youtube_list_captions", {
    title: "YouTube List Captions",
    description: "Caption and subtitle tracks on one of the channel's videos: track ID, language, name, whether it is YouTube's automatic (ASR) track, draft status and last update.",
    inputSchema: { videoId }, annotations: { readOnlyHint: true }
  }, yt(async ({ accessToken, args }) => reply(
    await youtubeData(accessToken, "captions", { part: "snippet", videoId: args.videoId }),
    body => ({ videoId: args.videoId, tracks: (body.items || []).map(t => ({ captionId: t.id, language: t.snippet?.language, name: t.snippet?.name, automatic: t.snippet?.trackKind === "asr", trackKind: t.snippet?.trackKind, isDraft: t.snippet?.isDraft, status: t.snippet?.status, lastUpdated: t.snippet?.lastUpdated })) })
  )));

  server.registerTool("youtube_download_caption", {
    title: "YouTube Download Caption",
    description: "Download a caption track's text (SRT, VTT or SBV), e.g. to translate it, fix it, or turn a commentary video's transcript into a description, chapters or a blog post. Works on the channel's own videos, including automatic tracks.",
    inputSchema: { captionId: z.string().min(5).max(200), format: z.enum(["srt", "vtt", "sbv"]).optional().describe("Default srt") },
    annotations: { readOnlyHint: true }
  }, yt(async ({ accessToken, args }) => {
    const response = await fetch(`https://www.googleapis.com/youtube/v3/captions/${encodeURIComponent(args.captionId)}?tfmt=${args.format || "srt"}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) { let body = text; try { body = JSON.parse(text); } catch { /* text */ } return reply({ ok: false, status: response.status, body }); }
    return result({ captionId: args.captionId, format: args.format || "srt", truncated: text.length > MAX_CAPTION_CHARS, text: text.slice(0, MAX_CAPTION_CHARS) });
  }));

  server.registerTool("youtube_upload_caption", {
    title: "YouTube Upload Caption",
    description: "Add a caption/subtitle track to a video from SRT, VTT or SBV text, or replace an existing track's file (replaceCaptionId). Use it for translated subtitles or corrected automatic captions. Confirm with the user before calling.",
    inputSchema: {
      videoId,
      language: langCode.describe("Track language, e.g. hi, en"),
      name: z.string().max(150).optional().describe("Track name shown to viewers; empty for the main track"),
      captionText: z.string().min(1).max(MAX_CAPTION_CHARS).describe("Full SRT, VTT or SBV file contents"),
      isDraft: z.boolean().optional().describe("Draft tracks are hidden from viewers"),
      replaceCaptionId: z.string().min(5).max(200).optional().describe("Replace this track's file instead of adding a new track")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, yt(async ({ auth, accessToken, args }) => {
    const metadata = args.replaceCaptionId
      ? { id: args.replaceCaptionId, snippet: { isDraft: args.isDraft ?? false } }
      : { snippet: { videoId: args.videoId, language: args.language, name: args.name ?? "", isDraft: args.isDraft ?? false } };
    const { body, contentType } = multipart(metadata, args.captionText);
    const response = await youtubeRetry(async () => {
      const r = await fetch(`${UPLOAD_BASE}/captions?uploadType=multipart&part=snippet`, { method: args.replaceCaptionId ? "PUT" : "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": contentType }, body, signal: AbortSignal.timeout(60_000) });
      return { ok: r.ok, status: r.status, body: await readBody(r) };
    });
    if (missingWriteScope(response)) return reconnect(auth);
    return reply(response, track => ({ captionId: track?.id, videoId: args.videoId, language: track?.snippet?.language ?? args.language, name: track?.snippet?.name, isDraft: track?.snippet?.isDraft, replaced: Boolean(args.replaceCaptionId) }));
  }));

  server.registerTool("youtube_delete_caption", {
    title: "YouTube Delete Caption",
    description: "Delete a caption track from a video. Confirm with the user before calling.",
    inputSchema: { captionId: z.string().min(5).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }, yt(async ({ auth, accessToken, args }) => {
    const response = await youtubeDataWrite(accessToken, "captions", { id: args.captionId }, undefined, "DELETE");
    if (missingWriteScope(response)) return reconnect(auth);
    return reply(response, () => ({ deleted: true, captionId: args.captionId }));
  }));
}
