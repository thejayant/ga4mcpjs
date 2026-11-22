// MCP tools for connected platforms. Every tool identifies the user from the verified MCP
// token (an anonymous ID), loads that user's encrypted connection, and calls the platform.
// Connections made before user IDs existed get a clear "reconnect once" message.
import { z } from "zod";
import { PROVIDERS, publicConnection, bingCall, clarityInsights, CLARITY_DIMENSIONS, youtubeData, youtubeDataWrite, youtubeAnalytics } from "./providers.js";
import { connectionsLink } from "./routes.js";
import { freshAccessToken } from "./oauth.js";
import { PROFILE_FAMILIES, profileUrl } from "./profiles.js";

export const CONNECTION_TOOL_NAMES = ["manage_connections", "bing_webmaster_sites", "bing_webmaster_traffic", "bing_webmaster_queries", "bing_webmaster_pages", "clarity_insights",
  "youtube_channel_report", "youtube_top_videos", "youtube_analytics_report", "youtube_list_videos", "youtube_get_video", "youtube_update_video",
  "youtube_list_playlists", "youtube_create_playlist", "youtube_add_to_playlist"];

const videoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/).describe("11-character YouTube video ID");
// YouTube rejects < and > in titles and descriptions.
const noAngles = s => !/[<>]/.test(s);
const videoSummary = item => ({
  videoId: item.id, title: item.snippet?.title, description: item.snippet?.description, tags: item.snippet?.tags || [],
  categoryId: item.snippet?.categoryId, defaultLanguage: item.snippet?.defaultLanguage, defaultAudioLanguage: item.snippet?.defaultAudioLanguage,
  publishedAt: item.snippet?.publishedAt, privacyStatus: item.status?.privacyStatus, liveBroadcastContent: item.snippet?.liveBroadcastContent,
  duration: item.contentDetails?.duration, views: item.statistics?.viewCount ? Number(item.statistics.viewCount) : undefined,
  url: `https://www.youtube.com/watch?v=${item.id}`
});

const DAY = 86_400_000;
const isoDay = time => new Date(time).toISOString().slice(0, 10);
const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Default period: the last 28 days ending yesterday, as in the dashboard.
const period = ({ startDate, endDate } = {}) => ({ startDate: startDate || isoDay(Date.now() - 28 * DAY), endDate: endDate || isoDay(Date.now() - DAY) });
const periodInput = { startDate: dateInput.optional().describe("YYYY-MM-DD; default 28 days ago"), endDate: dateInput.optional().describe("YYYY-MM-DD; default yesterday") };

const siteInput = { siteUrl: z.string().min(4).max(300).describe("A verified site exactly as listed by bing_webmaster_sites, e.g. https://www.example.com/") };

export function registerConnectionTools(server, { req, store, seal, withAuth, result, baseUrl }) {
  // Runs a tool for the signed-in user; `needs` names the platform connection it requires.
  const forUser = (needs, run) => async (args = {}) => withAuth(req, [], async auth => {
    if (!store) return result({ error: "connections_unavailable", error_description: "Connections are not set up on this server yet." }, true);
    if (!auth.userId) return result({ error: "reconnect_required", error_description: "Disconnect and reconnect Marketer Companion once to use connected platforms. Your existing tools keep working meanwhile." }, true);
    if (!needs) return run({ auth, args });
    const record = await store.get(auth.userId, needs);
    if (!record) {
      const link = connectionsLink(baseUrl(req), seal, auth.userId);
      return result({ error: "not_connected", error_description: `${PROVIDERS[needs].name} is not connected. Open this private link to connect it, then ask again.`, connectUrl: link.url, linkExpiresAt: link.expiresAt }, true);
    }
    // Sign-in platforms get a fresh access token; key platforms get their stored credentials.
    const accessToken = PROVIDERS[needs].oauth
      ? await freshAccessToken({ store, userId: auth.userId, providerId: needs, provider: PROVIDERS[needs], record }).catch(error => ({ error }))
      : null;
    if (accessToken?.error) return result({ error: "reconnect_platform", error_description: accessToken.error.message, connectUrl: connectionsLink(baseUrl(req), seal, auth.userId).url }, true);
    return run({ auth, args, credentials: record.credentials, accessToken, record });
  });
  const reply = (response, shape = body => body) => response.ok
    ? result(shape(response.body))
    : result({ error: "platform_error", status: response.status, error_description: typeof response.body === "string" ? response.body.slice(0, 300) : response.body?.error?.message || response.body?.message || response.body?.Message || `The platform returned ${response.status}.` }, true);

  server.registerTool("manage_connections", {
    title: "Manage Connections",
    description: `Connect or disconnect extra platforms (${Object.values(PROVIDERS).map(p => p.name).join(", ")}). Extra Google accounts, Meta logins and CallRail keys can be added too; tools then use whichever account can see the property asked about. Also lists the user's profiles (one per client: a set of accounts with default IDs). Each profile has its own connector URL to add as a separate connector, and on this connector any tool takes account "profile:<slug>" to use that profile's account; run_across_profiles compares profiles. Returns the platforms already connected and a private link, valid 30 minutes, to a page where the user connects platforms and builds profiles. Give the user the link; never ask for keys in chat.`,
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, forUser(null, async ({ auth }) => {
    const ids = await store.list(auth.userId);
    const connected = (await Promise.all(ids.map(async id => publicConnection(id, await store.get(auth.userId, id))))).filter(Boolean);
    const link = connectionsLink(baseUrl(req), seal, auth.userId);
    const profiles = (await store.listProfiles(auth.userId)).map(profile => ({
      name: profile.name, slug: profile.slug, connectorUrl: profileUrl(baseUrl(req), profile.slug),
      accounts: Object.fromEntries(Object.keys(PROFILE_FAMILIES).filter(family => profile.accounts?.[family]).map(family => [family, profile.accountLabels?.[family] || profile.accounts[family]])),
      platforms: profile.platforms || [], defaults: profile.defaults || {}
    }));
    const mainGoogle = (await store.getAccountInfo(auth.userId))?.googleEmail || null;
    return result({ ...(req.profile ? { currentProfile: { name: req.profile.name, slug: req.profile.slug } } : {}), mainSignIn: { google: mainGoogle || "connected (email shown after the next reconnect)" }, connected, profiles, available: Object.entries(PROVIDERS).filter(([id, p]) => p.multi || !ids.includes(id)).map(([id, p]) => ({ provider: id, name: p.name, category: p.category })), manageUrl: link.url, linkExpiresAt: link.expiresAt });
  }));

  server.registerTool("bing_webmaster_sites", {
    title: "Bing Webmaster Sites", description: "List the sites in the user's Bing Webmaster Tools account and whether each is verified.",
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, forUser("bing_webmaster", async ({ credentials }) => reply(await bingCall(credentials.apiKey, "GetUserSites"), sites => ({ sites: (sites || []).map(site => ({ url: site.Url, verified: site.IsVerified })) }))));

  server.registerTool("bing_webmaster_traffic", {
    title: "Bing Webmaster Traffic", description: "Daily Bing search clicks and impressions for a verified site (Bing keeps about six months).",
    inputSchema: siteInput, annotations: { readOnlyHint: true }
  }, forUser("bing_webmaster", async ({ credentials, args }) => reply(await bingCall(credentials.apiKey, "GetRankAndTrafficStats", { siteUrl: args.siteUrl }), rows => ({ siteUrl: args.siteUrl, days: (rows || []).map(row => ({ date: row.Date, clicks: row.Clicks, impressions: row.Impressions })) }))));

  server.registerTool("bing_webmaster_queries", {
    title: "Bing Webmaster Queries", description: "Top Bing search queries for a verified site with clicks, impressions and average positions.",
    inputSchema: siteInput, annotations: { readOnlyHint: true }
  }, forUser("bing_webmaster", async ({ credentials, args }) => reply(await bingCall(credentials.apiKey, "GetQueryStats", { siteUrl: args.siteUrl }), rows => ({ siteUrl: args.siteUrl, queries: (rows || []).slice(0, 200) }))));

  server.registerTool("bing_webmaster_pages", {
    title: "Bing Webmaster Pages", description: "Top pages in Bing search for a verified site with clicks, impressions and average positions.",
    inputSchema: siteInput, annotations: { readOnlyHint: true }
  }, forUser("bing_webmaster", async ({ credentials, args }) => reply(await bingCall(credentials.apiKey, "GetPageStats", { siteUrl: args.siteUrl }), rows => ({ siteUrl: args.siteUrl, pages: (rows || []).slice(0, 200) }))));

  const YOUTUBE_TOTALS = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares";

  server.registerTool("youtube_channel_report", {
    title: "YouTube Channel Report",
    description: "YouTube channel performance for a period: views, watch time (minutes), average view duration and percentage, subscribers gained and lost, likes, comments and shares, as totals and per day. Default: last 28 days ending yesterday.",
    inputSchema: periodInput, annotations: { readOnlyHint: true }
  }, forUser("youtube", async ({ accessToken, args, record }) => {
    const { startDate, endDate } = period(args);
    const [totals, daily] = await Promise.all([
      youtubeAnalytics(accessToken, { startDate, endDate, metrics: YOUTUBE_TOTALS }),
      youtubeAnalytics(accessToken, { startDate, endDate, metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost", dimensions: "day", sort: "day" })
    ]);
    if (!totals.ok) return reply(totals);
    return result({ channel: record.label || null, startDate, endDate, totals: totals.body.rows[0] || {}, daily: daily.ok ? daily.body.rows : [], dailyError: daily.ok ? undefined : daily.status });
  }));

  server.registerTool("youtube_top_videos", {
    title: "YouTube Top Videos",
    description: "The channel's top videos for a period with titles: views, watch time, average view duration, likes, comments, shares and subscribers gained. Default: last 28 days ending yesterday, sorted by views.",
    inputSchema: { ...periodInput, sortBy: z.enum(["views", "estimatedMinutesWatched", "subscribersGained", "likes"]).optional(), maxResults: z.number().int().min(1).max(25).optional() },
    annotations: { readOnlyHint: true }
  }, forUser("youtube", async ({ accessToken, args }) => {
    const { startDate, endDate } = period(args);
    const sortBy = args.sortBy || "views";
    const report = await youtubeAnalytics(accessToken, { startDate, endDate, dimensions: "video", metrics: "views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained", sort: `-${sortBy}`, maxResults: args.maxResults || 10 });
    if (!report.ok) return reply(report);
    const ids = report.body.rows.map(row => row.video).filter(Boolean);
    const titles = ids.length ? await youtubeData(accessToken, "videos", { part: "snippet", id: ids.join(",") }) : { ok: true, body: { items: [] } };
    const byId = new Map((titles.ok ? titles.body.items || [] : []).map(item => [item.id, { title: item.snippet?.title, publishedAt: item.snippet?.publishedAt?.slice(0, 10) }]));
    return result({ startDate, endDate, sortBy, videos: report.body.rows.map(row => ({ ...row, ...(byId.get(row.video) || {}), url: `https://www.youtube.com/watch?v=${row.video}` })) });
  }));

  server.registerTool("youtube_analytics_report", {
    title: "YouTube Analytics Report",
    description: "Any YouTube Analytics report for the connected channel. metrics and dimensions use YouTube Analytics API names, e.g. metrics 'views,estimatedMinutesWatched' with dimensions 'insightTrafficSourceType' (traffic sources), 'country', 'deviceType', 'ageGroup,gender' (with viewerPercentage) or 'day'. filters like 'video==VIDEO_ID' or 'country==US'.",
    inputSchema: {
      ...periodInput,
      metrics: z.string().regex(/^[A-Za-z,]+$/).max(400),
      dimensions: z.string().regex(/^[A-Za-z,]+$/).max(200).optional(),
      filters: z.string().max(300).optional(),
      sort: z.string().regex(/^-?[A-Za-z,-]+$/).max(200).optional(),
      maxResults: z.number().int().min(1).max(200).optional()
    },
    annotations: { readOnlyHint: true }
  }, forUser("youtube", async ({ accessToken, args }) => {
    const { startDate, endDate } = period(args);
    return reply(await youtubeAnalytics(accessToken, { startDate, endDate, metrics: args.metrics, dimensions: args.dimensions, filters: args.filters, sort: args.sort, maxResults: args.maxResults }),
      body => ({ startDate, endDate, rows: body.rows }));
  }));

  // A YouTube connection made before editing was added has no write scope: ask for one reconnect.
  const missingWriteScope = response => response.status === 403 && /insufficient|scope/i.test(JSON.stringify(response.body || ""));

  server.registerTool("youtube_list_videos", {
    title: "YouTube List Videos",
    description: "The channel's uploads, newest first, including past livestreams and private or unlisted videos: video ID, title, description, tags, category, privacy, duration, views and publish date. Use it to find the ID for youtube_update_video.",
    inputSchema: { maxResults: z.number().int().min(1).max(50).optional().describe("Default 25") },
    annotations: { readOnlyHint: true }
  }, forUser("youtube", async ({ accessToken, args }) => {
    const channel = await youtubeData(accessToken, "channels", { part: "contentDetails", mine: "true" });
    if (!channel.ok) return reply(channel);
    const uploads = channel.body?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return result({ error: "no_channel", error_description: "No uploads playlist found for this channel." }, true);
    const list = await youtubeData(accessToken, "playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: args.maxResults || 25 });
    if (!list.ok) return reply(list);
    const ids = (list.body.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
    if (!ids.length) return result({ videos: [] });
    const videos = await youtubeData(accessToken, "videos", { part: "snippet,status,contentDetails,statistics", id: ids.join(",") });
    return reply(videos, body => ({ videos: (body.items || []).map(videoSummary).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))) }));
  }));

  server.registerTool("youtube_get_video", {
    title: "YouTube Get Video",
    description: "Full current metadata for one of the channel's videos: title, description, tags, category, languages, privacy, duration and views.",
    inputSchema: { videoId }, annotations: { readOnlyHint: true }
  }, forUser("youtube", async ({ accessToken, args }) => {
    const response = await youtubeData(accessToken, "videos", { part: "snippet,status,contentDetails,statistics", id: args.videoId });
    if (!response.ok) return reply(response);
    const item = response.body?.items?.[0];
    return item ? result(videoSummary(item)) : result({ error: "not_found", error_description: `No video ${args.videoId} on this channel.` }, true);
  }));

  server.registerTool("youtube_update_video", {
    title: "YouTube Update Video",
    description: "Change a video's title, description, tags, category or language on the connected channel. Only the fields given change: the current metadata is read first and everything else is kept. Returns the metadata before and after. Confirm the new text with the user before calling.",
    inputSchema: {
      videoId,
      title: z.string().min(1).max(100).refine(noAngles, "Titles cannot contain < or >").optional().describe("Max 100 characters"),
      description: z.string().max(5000).refine(noAngles, "Descriptions cannot contain < or >").optional().describe("Max 5000 characters"),
      tags: z.array(z.string().min(1).max(100)).max(60).optional().describe("Replaces all tags; total about 500 characters max"),
      categoryId: z.string().regex(/^\d{1,3}$/).optional().describe("e.g. 20 = Gaming, 22 = People & Blogs"),
      defaultLanguage: z.string().max(10).optional().describe("Language of the title and description, e.g. hi, en")
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, forUser("youtube", async ({ auth, accessToken, args }) => {
    const changes = ["title", "description", "tags", "categoryId", "defaultLanguage"].filter(key => args[key] !== undefined);
    if (!changes.length) return result({ error: "nothing_to_change", error_description: "Give at least one of title, description, tags, categoryId or defaultLanguage." }, true);
    const current = await youtubeData(accessToken, "videos", { part: "snippet", id: args.videoId });
    if (!current.ok) return reply(current);
    const item = current.body?.items?.[0];
    if (!item) return result({ error: "not_found", error_description: `No video ${args.videoId} on this channel.` }, true);
    // videos.update replaces the whole snippet, so send every kept field back with the changes.
    const old = item.snippet || {};
    const snippet = {
      title: args.title ?? old.title,
      description: args.description ?? old.description ?? "",
      categoryId: args.categoryId ?? old.categoryId,
      ...((args.tags ?? old.tags) ? { tags: args.tags ?? old.tags } : {}),
      ...((args.defaultLanguage ?? old.defaultLanguage) ? { defaultLanguage: args.defaultLanguage ?? old.defaultLanguage } : {}),
      ...(old.defaultAudioLanguage ? { defaultAudioLanguage: old.defaultAudioLanguage } : {})
    };
    const updated = await youtubeDataWrite(accessToken, "videos", { part: "snippet" }, { id: args.videoId, snippet });
    if (missingWriteScope(updated)) return result({ error: "reconnect_platform", error_description: "YouTube was connected with read-only access. Reconnect YouTube once on the Connections page to allow editing titles and descriptions, then ask again.", connectUrl: connectionsLink(baseUrl(req), seal, auth.userId).url }, true);
    if (!updated.ok) return reply(updated);
    const pick = s => ({ title: s.title, description: s.description, tags: s.tags || [], categoryId: s.categoryId, defaultLanguage: s.defaultLanguage });
    return result({ videoId: args.videoId, changed: changes, before: pick(old), after: pick(updated.body?.snippet || snippet), url: `https://www.youtube.com/watch?v=${args.videoId}` });
  }));

  const writeScopeError = auth => result({ error: "reconnect_platform", error_description: "YouTube was connected with read-only access. Reconnect YouTube once on the Connections page to allow managing playlists, then ask again.", connectUrl: connectionsLink(baseUrl(req), seal, auth.userId).url }, true);
  const playlistId = z.string().regex(/^[A-Za-z0-9_-]{10,64}$/).describe("Playlist ID from youtube_list_playlists or youtube_create_playlist");
  const videoIds = z.array(videoId).min(1).max(50).describe("Video IDs, added in this order");

  // Adds videos one by one (the API takes one per call) so the order is kept. Videos already in the
  // playlist are skipped; one failure does not stop the rest.
  const addVideos = async (accessToken, id, ids, position) => {
    const existing = new Set();
    let pageToken;
    do {
      const page = await youtubeData(accessToken, "playlistItems", { part: "contentDetails", playlistId: id, maxResults: 50, pageToken });
      if (!page.ok) break;
      (page.body.items || []).forEach(item => existing.add(item.contentDetails?.videoId));
      pageToken = page.body.nextPageToken;
    } while (pageToken);
    const added = [], skipped = [], failed = [];
    let at = position;
    for (const vid of [...new Set(ids)]) {
      if (existing.has(vid)) { skipped.push(vid); continue; }
      const snippet = { playlistId: id, resourceId: { kind: "youtube#video", videoId: vid }, ...(at !== undefined ? { position: at } : {}) };
      const response = await youtubeDataWrite(accessToken, "playlistItems", { part: "snippet" }, { snippet }, "POST");
      if (missingWriteScope(response)) return { scopeError: true };
      if (response.ok) { added.push(vid); if (at !== undefined) at += 1; }
      else failed.push({ videoId: vid, status: response.status, error: response.body?.error?.message || `YouTube returned ${response.status}.` });
    }
    return { added, skipped, failed };
  };

  server.registerTool("youtube_list_playlists", {
    title: "YouTube List Playlists",
    description: "The channel's playlists, including private and unlisted ones: playlist ID, title, description, privacy, video count and link.",
    inputSchema: { maxResults: z.number().int().min(1).max(50).optional().describe("Default 25") },
    annotations: { readOnlyHint: true }
  }, forUser("youtube", async ({ accessToken, args }) => reply(
    await youtubeData(accessToken, "playlists", { part: "snippet,status,contentDetails", mine: "true", maxResults: args.maxResults || 25 }),
    body => ({ playlists: (body.items || []).map(item => ({ playlistId: item.id, title: item.snippet?.title, description: item.snippet?.description, privacyStatus: item.status?.privacyStatus, videoCount: item.contentDetails?.itemCount, url: `https://www.youtube.com/playlist?list=${item.id}` })) })
  )));

  server.registerTool("youtube_create_playlist", {
    title: "YouTube Create Playlist",
    description: "Create a playlist on the connected channel and optionally add videos to it in the given order. Check youtube_list_playlists first so you don't create a duplicate, and confirm the title, description, privacy and videos with the user before calling.",
    inputSchema: {
      title: z.string().min(1).max(150).refine(noAngles, "Titles cannot contain < or >").describe("Max 150 characters"),
      description: z.string().max(5000).refine(noAngles, "Descriptions cannot contain < or >").optional(),
      privacyStatus: z.enum(["public", "unlisted", "private"]).optional().describe("Default public"),
      defaultLanguage: z.string().max(10).optional().describe("e.g. hi, en"),
      videoIds: videoIds.optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, forUser("youtube", async ({ auth, accessToken, args }) => {
    const created = await youtubeDataWrite(accessToken, "playlists", { part: "snippet,status" }, {
      snippet: { title: args.title, description: args.description || "", ...(args.defaultLanguage ? { defaultLanguage: args.defaultLanguage } : {}) },
      status: { privacyStatus: args.privacyStatus || "public" }
    }, "POST");
    if (missingWriteScope(created)) return writeScopeError(auth);
    if (!created.ok) return reply(created);
    const id = created.body?.id;
    const videos = args.videoIds?.length ? await addVideos(accessToken, id, args.videoIds) : { added: [], skipped: [], failed: [] };
    if (videos.scopeError) return writeScopeError(auth);
    return result({ playlistId: id, title: created.body?.snippet?.title, privacyStatus: created.body?.status?.privacyStatus, url: `https://www.youtube.com/playlist?list=${id}`, ...videos });
  }));

  server.registerTool("youtube_add_to_playlist", {
    title: "YouTube Add To Playlist",
    description: "Add videos to one of the channel's playlists in the given order. Videos already in the playlist are skipped. position (0 = first) inserts them there; otherwise they go at the end.",
    inputSchema: { playlistId, videoIds, position: z.number().int().min(0).optional().describe("0-based; default end of playlist") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, forUser("youtube", async ({ auth, accessToken, args }) => {
    const videos = await addVideos(accessToken, args.playlistId, args.videoIds, args.position);
    if (videos.scopeError) return writeScopeError(auth);
    return result({ playlistId: args.playlistId, url: `https://www.youtube.com/playlist?list=${args.playlistId}`, ...videos }, videos.added.length === 0 && videos.failed.length > 0);
  }));

  server.registerTool("clarity_insights", {
    title: "Microsoft Clarity Insights",
    description: `Microsoft Clarity behaviour data for the last 1–3 days: sessions, bot sessions, pages per session, scroll depth, engagement time, dead, rage, quick-back and error clicks, and JavaScript errors, broken down by up to three of: ${CLARITY_DIMENSIONS.join(", ")}. Clarity allows 10 requests a day per project, so identical requests are served from a one-hour cache.`,
    inputSchema: {
      numOfDays: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("Last 24, 48 or 72 hours (default 3)"),
      dimensions: z.array(z.enum(CLARITY_DIMENSIONS)).max(3).optional()
    },
    annotations: { readOnlyHint: true }
  }, forUser("clarity", async ({ auth, credentials, args }) => {
    const numOfDays = args.numOfDays || 3, dimensions = args.dimensions || [];
    const response = await store.cached(`clarity:${auth.userId}:${numOfDays}:${dimensions.join(",")}`, 3600, () => clarityInsights(credentials.token, { numOfDays, dimensions }));
    if (response.status === 429) return result({ error: "daily_limit", error_description: "Clarity's limit of 10 requests a day for this project is used up. Try again tomorrow, or reuse an earlier answer." }, true);
    return reply(response, metrics => ({ numOfDays, dimensions, servedFromCache: Boolean(response.cached), metrics }));
  }));
}
