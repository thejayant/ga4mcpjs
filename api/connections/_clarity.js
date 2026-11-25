// Microsoft Clarity: several projects per user (one Data Export token each) and the reports built on
// them. Two Clarity APIs take the same project token:
// - Data Export (clarity.ms/export-data): metrics for the last 1 to 3 days by up to three dimensions,
//   10 requests a day per project, at most 1,000 rows. Every report here shares one-hour cached pulls,
//   so the friction, funnel and heatmap reports together usually spend one request.
// - Clarity's MCP API (clarity.microsoft.com/mcp, used by Microsoft's own Clarity MCP server):
//   session recordings and natural-language dashboard queries over any date range, with its own
//   daily limit.
// Neither API returns heatmap click maps, so the heatmap review combines page metrics, a recording
// sample and a link to the heatmap. Daily snapshots (a cron job, opt-in per project) give the
// 14-day and 28-day comparisons that the 3-day API window can't.
import crypto from "node:crypto";
import { z } from "zod";
import { PROVIDERS, clarityInsights, clarityMcp, CLARITY_DIMENSIONS } from "./providers.js";
import { connectionsLink } from "./routes.js";

export const MAX_CLARITY_PROJECTS = PROVIDERS.clarity.maxConnections;
export const CLARITY_TOOL_NAMES = ["clarity_insights", "clarity_list_projects", "clarity_friction_report", "clarity_funnel_report", "clarity_campaign_scorecard",
  "clarity_period_report", "clarity_recordings", "clarity_heatmap_review", "clarity_dashboard_query"];
export const isClarityId = id => id === "clarity" || String(id).startsWith("clarity:");

const DAY = 86_400_000;
const isoDay = time => new Date(time).toISOString().slice(0, 10);
const EXPORT_ROW_LIMIT = 1000;

/* ---------------- Projects ---------------- */

export async function listClarityProjects(store, userId) {
  const ids = (await store.list(userId)).filter(isClarityId).sort();
  const entries = await Promise.all(ids.map(async id => ({ id, record: await store.get(userId, id) })));
  return entries.filter(entry => entry.record?.credentials?.token).map(({ id, record }) => ({
    id, record,
    name: record.label || record.credentials.project || "Clarity project",
    projectId: record.credentials.projectId || record.meta?.projectId || null,
    // Older connections have no setting and get snapshots, like the form's default.
    snapshots: record.credentials.snapshots !== "off"
  }));
}

export const projectSummary = project => ({ project: project.name, id: project.id, ...(project.projectId ? { clarityProjectId: project.projectId } : {}), dailySnapshots: project.snapshots });

const bareHost = text => String(text || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

// A project by connection ID, Clarity project ID, exact name, the same site, or a name fragment that matches only one.
export function matchProject(projects, wanted) {
  const text = String(wanted || "").trim().toLowerCase();
  if (!text) return null;
  const exact = projects.find(p => p.id.toLowerCase() === text || (p.projectId || "").toLowerCase() === text || p.name.toLowerCase() === text);
  if (exact) return exact;
  const site = projects.filter(p => bareHost(p.name) && bareHost(p.name) === bareHost(text));
  if (site.length === 1) return site[0];
  const partial = projects.filter(p => p.name.toLowerCase().includes(text));
  return partial.length === 1 ? partial[0] : null;
}

/** Picks the project for a call: the profile's pinned one, the one named, or the only one. */
export function pickClarityProject({ projects, wanted, pinned }) {
  if (!projects.length) return { error: "not_connected" };
  const list = projects.map(projectSummary);
  if (pinned) {
    const own = projects.find(project => project.id === pinned);
    if (!own) return { error: "profile_project_missing", message: "This profile's Clarity project was disconnected. Choose another project for the profile on the Connections page." };
    if (wanted && matchProject([own], wanted) !== own) return { error: "other_project", message: `This connector is set to the Clarity project "${own.name}". Use the connector or profile of the other project.` };
    return { project: own };
  }
  if (wanted) {
    const match = matchProject(projects, wanted);
    return match ? { project: match } : { error: "unknown_project", message: `No connected Clarity project matches "${wanted}".`, projects: list };
  }
  if (projects.length === 1) return { project: projects[0] };
  return { error: "choose_project", message: `${projects.length} Clarity projects are connected. Say which one with \`project\` (its name or ID), then ask again.`, projects: list };
}

// Registers or drops a project for the daily snapshot job when it is saved on the Connections page.
PROVIDERS.clarity.afterSave = async ({ store, userId, id, credentials }) => {
  if (!store.addSnapshotTarget) return;
  if (credentials.snapshots === "off") await store.removeSnapshotTarget(userId, id);
  else await store.addSnapshotTarget(userId, id);
};

/* ---------------- Reading Data Export responses ---------------- */

const norm = text => String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const num = value => { const n = Number(value); return value !== null && value !== "" && Number.isFinite(n) ? n : null; };
const field = (row, name) => { const key = Object.keys(row || {}).find(k => norm(k) === norm(name)); return key === undefined ? undefined : row[key]; };
const round = (value, digits = 1) => value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const pct = (part, whole) => whole ? round((part / whole) * 100) : null;

// Clarity's metric names (display names differ) mapped to the names reports use.
const METRICS = {
  traffic: "traffic", scrolldepth: "scrollDepth", engagementtime: "engagementTime",
  deadclickcount: "deadClicks", rageclickcount: "rageClicks", quickbackclick: "quickBacks",
  excessivescroll: "excessiveScroll", scripterrorcount: "scriptErrors", errorclickcount: "errorClicks"
};
export const FRICTION_SIGNALS = ["deadClicks", "rageClicks", "quickBacks", "errorClicks", "scriptErrors", "excessiveScroll"];
// What a page "loses" a session to: the four signals the reports rank by (excessive scroll is shown, not ranked).
const RANKED_SIGNALS = ["deadClicks", "rageClicks", "quickBacks", "errorClicks", "scriptErrors"];

// URL rows grouped by page (host + path, no query string), so ?utm_ variants add up.
export function pagePath(url) {
  const text = String(url || "").trim();
  try {
    const parsed = new URL(text);
    return `${parsed.host.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return text.replace(/[?#].*$/, "").replace(/\/+$/, "") || text;
  }
}

/**
 * Turns a Data Export response into one row per combination of `dimensions`, with traffic, scroll,
 * engagement and each friction signal. Friction signals give the sessions they were seen in
 * (sessionsCount × sessionsWithMetricPercentage) and their rate. `groupUrls` merges URL variants.
 */
export function tabulate(body, dimensions, { groupUrls = true } = {}) {
  const rows = new Map();
  let rawRows = 0;
  for (const metric of Array.isArray(body) ? body : []) {
    const name = METRICS[norm(metric?.metricName)];
    if (!name) continue;
    const info = Array.isArray(metric.information) ? metric.information : [];
    if (name === "traffic") rawRows = Math.max(rawRows, info.length);
    for (const item of info) {
      const dims = Object.fromEntries(dimensions.map(d => {
        const value = field(item, d) ?? "(none)";
        return [d, d === "URL" && groupUrls ? pagePath(value) : String(value)];
      }));
      const key = JSON.stringify(dimensions.map(d => dims[d]));
      if (!rows.has(key)) rows.set(key, { ...dims, sessions: 0, botSessions: 0, users: 0, _pps: 0, _scroll: [0, 0], _active: [0, 0], _total: [0, 0], signals: {} });
      const row = rows.get(key);
      if (name === "traffic") {
        const sessions = num(field(item, "totalSessionCount")) || 0;
        row.sessions += sessions;
        row.botSessions += num(field(item, "totalBotSessionCount")) || 0;
        row.users += num(field(item, "distantUserCount")) || 0;
        row._pps += (num(field(item, "PagesPerSessionPercentage")) || 0) * sessions;
      } else if (name === "scrollDepth") {
        const value = num(field(item, "averageScrollDepth"));
        if (value !== null) { row._scroll[0] += value; row._scroll[1]++; }
      } else if (name === "engagementTime") {
        const active = num(field(item, "activeTime")), total = num(field(item, "totalTime"));
        if (active !== null) { row._active[0] += active; row._active[1]++; }
        if (total !== null) { row._total[0] += total; row._total[1]++; }
      } else {
        const base = num(field(item, "sessionsCount")) || 0;
        const share = num(field(item, "sessionsWithMetricPercentage"));
        const signal = row.signals[name] ||= { sessions: 0, base: 0, events: 0 };
        signal.base += base;
        signal.sessions += share === null ? 0 : base * share / 100;
        signal.events += num(field(item, "subTotal")) || 0;
      }
    }
  }
  const list = [...rows.values()].map(row => {
    const { _pps, _scroll, _active, _total, signals, ...rest } = row;
    const out = {
      ...rest,
      pagesPerSession: row.sessions ? round(_pps / row.sessions, 2) : null,
      scrollDepth: _scroll[1] ? round(_scroll[0] / _scroll[1]) : null,
      activeTimeSec: _active[1] ? round(_active[0] / _active[1]) : null,
      totalTimeSec: _total[1] ? round(_total[0] / _total[1]) : null
    };
    for (const signal of FRICTION_SIGNALS) {
      const s = signals[signal];
      out[`${signal}Sessions`] = s ? Math.round(s.sessions) : 0;
      out[`${signal}Rate`] = s ? pct(s.sessions, s.base || row.sessions) : null;
    }
    // Sessions behind the ranked signals, added up: a session with two signals counts twice.
    out.frictionSessions = RANKED_SIGNALS.reduce((sum, signal) => sum + out[`${signal}Sessions`], 0);
    out.frictionPer100Sessions = row.sessions ? round((out.frictionSessions / row.sessions) * 100) : null;
    return out;
  });
  return { rows: list, rawRows, truncated: rawRows >= EXPORT_ROW_LIMIT };
}

// Totals over rows: counts add up, averages are weighted by sessions.
export function totals(rows) {
  const sessions = rows.reduce((sum, row) => sum + row.sessions, 0);
  const weighted = key => {
    const usable = rows.filter(row => row[key] !== null && row[key] !== undefined && row.sessions);
    const weight = usable.reduce((sum, row) => sum + row.sessions, 0);
    return weight ? round(usable.reduce((sum, row) => sum + row[key] * row.sessions, 0) / weight, key === "pagesPerSession" ? 2 : 1) : null;
  };
  const out = { sessions, botSessions: rows.reduce((s, r) => s + (r.botSessions || 0), 0), pagesPerSession: weighted("pagesPerSession"), scrollDepth: weighted("scrollDepth"), activeTimeSec: weighted("activeTimeSec") };
  for (const signal of FRICTION_SIGNALS) {
    out[`${signal}Sessions`] = rows.reduce((s, r) => s + (r[`${signal}Sessions`] || 0), 0);
    out[`${signal}Rate`] = pct(out[`${signal}Sessions`], sessions);
  }
  out.frictionSessions = RANKED_SIGNALS.reduce((s, signal) => s + out[`${signal}Sessions`], 0);
  return out;
}

const matches = (value, patterns) => !patterns?.length || patterns.some(pattern => String(value).toLowerCase().includes(String(pattern).toLowerCase()));
const deviceMatches = (row, device) => !device || device === "All" || norm(row.Device) === norm(device);

/* ---------------- Reports (pure, so they can be tested without Clarity) ---------------- */

export function frictionReport(table, { urlContains, device, minSessions = 10, limit = 25 } = {}) {
  const rows = table.rows.filter(row => matches(row.URL, urlContains) && deviceMatches(row, device));
  const ranked = rows.filter(row => row.sessions >= minSessions).sort((a, b) => b.frictionSessions - a.frictionSessions || b.sessions - a.sessions);
  return {
    pages: ranked.slice(0, limit).map((row, i) => ({ rank: i + 1, ...row })),
    matchedPages: rows.length, belowMinSessions: rows.length - ranked.length,
    totals: totals(rows)
  };
}

/** Step reach: sessions on pages matching each step, on the chosen device. */
export function funnelReport(table, steps, { device = "Mobile" } = {}) {
  const out = steps.map(step => {
    if (!step.urlContains?.length) return { step: step.name, smartEvent: step.smartEvent || null, sessions: null, pages: [] };
    const rows = table.rows.filter(row => deviceMatches(row, device) && matches(row.URL, step.urlContains));
    return { step: step.name, urlContains: step.urlContains, sessions: rows.reduce((s, r) => s + r.sessions, 0), pages: rows.sort((a, b) => b.sessions - a.sessions).slice(0, 5).map(r => ({ url: r.URL, sessions: r.sessions })) };
  });
  return withStepRates(out);
}

export function withStepRates(steps) {
  const first = steps[0]?.sessions;
  let worst = null;
  const rated = steps.map((step, i) => {
    const previous = i ? steps[i - 1].sessions : null;
    const ofFirst = step.sessions !== null && first ? pct(step.sessions, first) : null;
    const ofPrevious = i && step.sessions !== null && previous ? pct(step.sessions, previous) : null;
    if (ofPrevious !== null && (!worst || ofPrevious < worst.keptPercent)) worst = { from: steps[i - 1].step, to: step.step, keptPercent: ofPrevious, lostSessions: previous - step.sessions };
    return { ...step, percentOfFirstStep: i ? ofFirst : 100, percentOfPreviousStep: ofPrevious };
  });
  return { steps: rated, biggestDrop: worst };
}

export function scorecard(table, { minSessions = 20, limit = 30 } = {}) {
  const site = totals(table.rows);
  const errorRate = row => pct((row.errorClicksSessions || 0) + (row.scriptErrorsSessions || 0), row.sessions);
  const siteError = errorRate(site);
  const rows = table.rows.filter(row => row.sessions >= minSessions).map(row => {
    const flags = [];
    if (site.quickBacksRate && row.quickBacksRate !== null && row.quickBacksRate > site.quickBacksRate * 1.5) flags.push("high quick-back");
    if (siteError && errorRate(row) > siteError * 1.5) flags.push("high errors");
    if (site.scrollDepth && row.scrollDepth !== null && row.scrollDepth < site.scrollDepth * 0.75) flags.push("shallow scroll");
    if (site.activeTimeSec && row.activeTimeSec !== null && row.activeTimeSec > site.activeTimeSec * 1.25) flags.push("strong engagement");
    const { users, botSessions, totalTimeSec, ...rest } = row;
    return { ...rest, errorRate: errorRate(row), flags };
  }).sort((a, b) => b.sessions - a.sessions).slice(0, limit);
  return { siteAverage: { quickBacksRate: site.quickBacksRate, errorRate: siteError, scrollDepth: site.scrollDepth, activeTimeSec: site.activeTimeSec }, rows };
}

/** Sums daily snapshots into one period: counts add up, averages are weighted by sessions. */
export function sumSnapshots(snapshots) {
  const byDevice = new Map();
  for (const snapshot of snapshots) for (const row of snapshot.rows || []) {
    const list = byDevice.get(row.Device) || [];
    list.push(row);
    byDevice.set(row.Device, list);
  }
  const deviceTotals = Object.fromEntries([...byDevice].map(([device, rows]) => [device, { ...totals(rows), userDays: rows.reduce((s, r) => s + (r.users || 0), 0) }]));
  const all = snapshots.flatMap(snapshot => snapshot.rows || []);
  return { total: { ...totals(all), userDays: all.reduce((s, r) => s + (r.users || 0), 0) }, byDevice: deviceTotals };
}

const COMPARED = ["sessions", "botSessions", "userDays", "pagesPerSession", "scrollDepth", "activeTimeSec", "frictionSessions",
  ...FRICTION_SIGNALS.flatMap(signal => [`${signal}Sessions`, `${signal}Rate`])];
export function compare(current, previous) {
  return Object.fromEntries(COMPARED.filter(key => current?.[key] !== undefined).map(key => {
    const now = current[key], before = previous?.[key];
    const change = now !== null && before !== null && before !== undefined ? round(now - before, 2) : null;
    // Rates and averages change in points; counts also in percent.
    const isRate = /Rate$|scrollDepth|pagesPerSession|activeTimeSec/.test(key);
    return [key, { current: now, previous: before ?? null, change, ...(isRate ? {} : { changePercent: change !== null && before ? round((change / before) * 100) : null }) }];
  }));
}

/* ---------------- Clarity links ---------------- */

export function clarityLinks(project) {
  if (!project.projectId) return { note: "Add the project ID on the Connections page to get direct dashboard, heatmap and recording links." };
  const base = `https://clarity.microsoft.com/projects/view/${encodeURIComponent(project.projectId)}`;
  return { dashboard: `${base}/dashboard`, heatmaps: `${base}/heatmaps`, recordings: `${base}/impressions` };
}

/* ---------------- Daily snapshots ---------------- */

// One Data Export request (last 24 hours by device) per project and day.
export async function captureSnapshot(store, { userId, id }, now = Date.now()) {
  const record = await store.get(userId, id);
  if (!record?.credentials?.token || record.credentials.snapshots === "off") { await store.removeSnapshotTarget(userId, id); return { id, skipped: "disconnected or turned off" }; }
  // Runs just after midnight UTC, so the last 24 hours are (almost exactly) the previous UTC day.
  const date = isoDay(now - DAY / 2);
  if (await store.getSnapshot(userId, id, date)) return { id, date, skipped: "already saved" };
  const response = await clarityInsights(record.credentials.token, { numOfDays: 1, dimensions: ["Device"] });
  if (!response.ok) return { id, date, error: response.status };
  const table = tabulate(response.body, ["Device"]);
  await store.saveSnapshot(userId, id, date, { rows: table.rows });
  return { id, date, saved: true };
}

/**
 * GET /cron/clarity-snapshots, called once a day by Vercel Cron (vercel.json). Vercel sends
 * "Authorization: Bearer $CRON_SECRET"; without CRON_SECRET set the route refuses to run.
 */
export function registerClaritySnapshotRoute(app, { store }) {
  app.get("/cron/clarity-snapshots", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(503).json({ error: "CRON_SECRET is not set" });
    const given = Buffer.from(String(req.headers.authorization || ""));
    const expected = Buffer.from(`Bearer ${secret}`);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return res.status(401).json({ error: "unauthorized" });
    if (!store?.snapshotTargets) return res.status(503).json({ error: "no connection store" });
    const started = Date.now(), results = [];
    const queue = await store.snapshotTargets();
    const worker = async () => {
      while (queue.length && Date.now() - started < 50_000) {
        const target = queue.shift();
        results.push(await captureSnapshot(store, target).catch(error => ({ id: target.id, error: error.message })));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    res.set("Cache-Control", "no-store").json({ visited: results.length, saved: results.filter(r => r.saved).length, failed: results.filter(r => r.error).length, notReached: queue.length });
  });
}

/* ---------------- Tools ---------------- */

const PROJECT_INPUT = z.string().trim().min(1).max(200).optional()
  .describe("Only with several Clarity projects connected: the project's name, site or ID (from clarity_list_projects). Usually omit it.");
const DAYS_INPUT = z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("Last 24, 48 or 72 hours (default 3). Clarity's Data Export API reaches back 3 days at most.");
const DEVICE = z.enum(["Mobile", "PC", "Tablet"]);
const URL_PATTERNS = z.array(z.string().trim().min(1).max(200)).min(1).max(10);
const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SORTS = ["SessionStart_DESC", "SessionStart_ASC", "SessionDuration_ASC", "SessionDuration_DESC", "SessionClickCount_ASC", "SessionClickCount_DESC", "PageCount_ASC", "PageCount_DESC"];
const RECORDING_FLAGS = { deadClicks: { deadClickPresent: true }, rageClicks: { rageClickPresent: true }, quickBacks: { quickbackClickPresent: true },
  excessiveScroll: { excessiveScrollPresent: true }, errorClicks: { clickErrors: [""] }, scriptErrors: { javascriptErrors: [""] } };
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const LIMITS_NOTE = "Clarity's Data Export API allows 10 requests a day per project and covers the last 1 to 3 days; this server caches each pull for an hour and shares it between reports.";

export function registerClarityTools(server, { req, store, seal, withAuth, result, baseUrl, reply }) {
  // On a profile connector set to one project, the profile decides and tools take no `project`.
  const register = (name, config, handler) => {
    const { project, ...shape } = config.inputSchema || {};
    return server.registerTool(name, { ...config, inputSchema: req.profile?.clarityProject ? shape : config.inputSchema }, handler);
  };
  // Runs a tool with the chosen project; with several projects connected the result names it.
  const forProject = run => async (args = {}) => withAuth(req, [], async auth => {
    if (!store) return result({ error: "connections_unavailable", error_description: "Connections are not set up on this server yet." }, true);
    if (!auth.userId) return result({ error: "reconnect_required", error_description: "Disconnect and reconnect Marketer Companion once to use connected platforms. Your existing tools keep working meanwhile." }, true);
    const { project: wanted, ...rest } = args;
    const projects = await listClarityProjects(store, auth.userId);
    const link = () => connectionsLink(baseUrl(req), seal, auth.userId);
    const picked = pickClarityProject({ projects, wanted, pinned: req.profile?.clarityProject });
    if (picked.error === "not_connected") return result({ error: "not_connected", error_description: "Microsoft Clarity is not connected. Open this private link to add a Clarity project, then ask again.", connectUrl: link().url, linkExpiresAt: link().expiresAt }, true);
    if (picked.error) return result({ error: picked.error, error_description: picked.message, ...(picked.projects ? { projects: picked.projects } : {}) }, true);
    const project = picked.project;
    // Projects connected before snapshots existed join the daily job on first use.
    if (project.snapshots && store.addSnapshotTarget) await store.addSnapshotTarget(auth.userId, project.id).catch(() => {});
    const outcome = await run({ auth, args: rest, project, token: project.record.credentials.token, link });
    const content = outcome?.structuredContent;
    if (projects.length > 1 && content && typeof content === "object" && !Array.isArray(content)) {
      outcome.structuredContent = { clarityProject: projectSummary(project), ...content };
      outcome.content = [{ type: "text", text: JSON.stringify(outcome.structuredContent, null, 2) }];
    }
    return outcome;
  });

  // A Data Export pull, cached for an hour per project, period and dimensions.
  const exportPull = (auth, project, numOfDays, dimensions) =>
    store.cached(`clarity:${auth.userId}:${project.id}:${numOfDays}:${dimensions.join(",")}`, 3600, () => clarityInsights(project.record.credentials.token, { numOfDays, dimensions }));
  const exportError = (response, link) => response.status === 429
    ? result({ error: "daily_limit", error_description: "Clarity's limit of 10 data-export requests a day for this project is used up. Try again tomorrow, reuse an earlier answer, or use clarity_dashboard_query." }, true)
    : response.status === 401 || response.status === 403
      ? result({ error: "token_rejected", error_description: "Clarity rejected this project's token (it may have been deleted or regenerated). Add the project again with a new token.", connectUrl: link().url }, true)
      : reply(response);
  // A call to Clarity's MCP API, cached (default 15 minutes) so repeated questions don't spend its daily limit.
  const mcpCall = async (auth, project, path, body, ttl = 900) => {
    const response = await store.cached(`claritymcp:${auth.userId}:${project.id}:${path}:${hash(body)}`, ttl, () => clarityMcp(project.record.credentials.token, path, body));
    return response;
  };
  const mcpError = (response, link) => response.status === 429
    ? result({ error: "daily_limit", error_description: "Clarity's daily limit for recordings and dashboard queries is used up for this project. Try again tomorrow." }, true)
    : response.status === 401 || response.status === 403
      ? result({ error: "token_rejected", error_description: "Clarity refused this request for this project's token. Check the token is current, or add the project again with a new one.", connectUrl: link().url }, true)
      : reply(response);
  const meta = (project, response, numOfDays, dimensions) => ({ numOfDays, window: `last ${numOfDays * 24} hours (UTC)`, dimensions, servedFromCache: Boolean(response.cached), links: clarityLinks(project) });

  register("clarity_insights", {
    title: "Microsoft Clarity Insights",
    description: `Raw Microsoft Clarity behaviour data for the last 1–3 days: sessions, bot sessions, pages per session, scroll depth, engagement time, dead, rage, quick-back and error clicks, and JavaScript errors, broken down by up to three of: ${CLARITY_DIMENSIONS.join(", ")}. For ranked answers prefer the clarity_*_report tools. ${LIMITS_NOTE}`,
    inputSchema: { project: PROJECT_INPUT, numOfDays: DAYS_INPUT, dimensions: z.array(z.enum(CLARITY_DIMENSIONS)).max(3).optional() },
    annotations: { readOnlyHint: true }
  }, forProject(async ({ auth, args, project, link }) => {
    const numOfDays = args.numOfDays || 3, dimensions = args.dimensions || [];
    const response = await exportPull(auth, project, numOfDays, dimensions);
    if (!response.ok) return exportError(response, link);
    return result({ numOfDays, dimensions, servedFromCache: Boolean(response.cached), metrics: response.body });
  }));

  register("clarity_list_projects", {
    title: "List Clarity Projects",
    description: `List the user's connected Microsoft Clarity projects (up to ${MAX_CLARITY_PROJECTS}, one token each), whether each saves daily snapshots, and a private link, valid 30 minutes, where the user adds another project or removes one. Costs no Clarity requests. Give the user the link; never ask for tokens in chat.`,
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, async () => withAuth(req, [], async auth => {
    if (!store) return result({ error: "connections_unavailable", error_description: "Connections are not set up on this server yet." }, true);
    if (!auth.userId) return result({ error: "reconnect_required", error_description: "Disconnect and reconnect Marketer Companion once to use connected platforms." }, true);
    const projects = await listClarityProjects(store, auth.userId);
    const link = connectionsLink(baseUrl(req), seal, auth.userId);
    const pinned = req.profile?.clarityProject;
    return result({
      projects: projects.filter(project => !pinned || project.id === pinned).map(project => ({ ...projectSummary(project), links: clarityLinks(project) })),
      limit: MAX_CLARITY_PROJECTS,
      ...(pinned ? { note: "This profile connector uses one Clarity project." } : {}),
      addProjectUrl: link.url, linkExpiresAt: link.expiresAt,
      howToAdd: "On that page, under Microsoft Clarity, paste the project's Data Export token (Clarity → project → Settings → Data Export → Generate new API token) and its name, then Add. Repeat per project."
    });
  }));

  register("clarity_friction_report", {
    title: "Clarity Page Friction Report",
    description: `Rank pages (for example product pages) by sessions hit by friction in the last 1–3 days: dead clicks, rage clicks, quick backs, error clicks and JavaScript errors, with each signal's rate, scroll depth and engagement, by device. Use it to decide which pages to fix first. \`urlContains\` narrows to matching URLs (e.g. ["/product", "/carports/"]). frictionSessions adds the signals up, so one session with two signals counts twice: use it to rank, not as a unique count. Uses one Data Export request (URL × Device), shared with the funnel and heatmap reports. ${LIMITS_NOTE}`,
    inputSchema: {
      project: PROJECT_INPUT, numOfDays: DAYS_INPUT,
      urlContains: URL_PATTERNS.optional().describe("Keep only URLs containing any of these, case-insensitive"),
      device: DEVICE.optional().describe("Only this device; default all devices, each its own row"),
      byDevice: z.boolean().optional().describe("Split each page by device (default true). False merges devices into one row per page."),
      minSessions: z.number().int().min(1).max(100000).optional().describe("Skip pages with fewer sessions (default 10)"),
      limit: z.number().int().min(1).max(100).optional().describe("Rows to return (default 25)")
    },
    annotations: { readOnlyHint: true }
  }, forProject(async ({ auth, args, project, link }) => {
    const numOfDays = args.numOfDays || 3, dimensions = ["URL", "Device"];
    const response = await exportPull(auth, project, numOfDays, dimensions);
    if (!response.ok) return exportError(response, link);
    let table = tabulate(response.body, dimensions);
    if (args.byDevice === false && !args.device) table = { ...table, rows: tabulate(response.body.map(m => ({ ...m, information: (m.information || []).map(({ Device, ...rest }) => rest) })), ["URL"]).rows };
    const report = frictionReport(table, { urlContains: args.urlContains, device: args.device, minSessions: args.minSessions ?? 10, limit: args.limit || 25 });
    return result({
      ...meta(project, response, numOfDays, dimensions), filters: { urlContains: args.urlContains || null, device: args.device || null }, ...report,
      ...(table.truncated ? { warning: "Clarity returned its maximum of 1,000 URL × device rows, so smaller pages may be missing. Narrow with numOfDays: 1 or set byDevice: false." } : {}),
      notes: ["Rates are the share of a page's sessions with that signal.", "Next: clarity_recordings for the top page to see what shoppers hit, then clarity_heatmap_review for the page."]
    });
  }));

  register("clarity_funnel_report", {
    title: "Clarity Funnel (Step Reach)",
    description: `Show how many sessions reach each step of a journey on one device (default Mobile), for example product page → quote form → 3D designer → thank-you page, and which step loses the most. URL steps use Clarity's last 1–3 days of page data (one shared Data Export request). Steps that are Clarity Smart Events (e.g. RequestQuote, SubmitForm, or a custom event) are counted with a Clarity dashboard query instead. This is step reach, not a strict ordered funnel: a session that skips a step still counts at later steps. For an exact ordered funnel over any period, also run run_ga4_funnel_report when those steps are GA4 events.`,
    inputSchema: {
      project: PROJECT_INPUT, numOfDays: DAYS_INPUT,
      device: z.enum(["Mobile", "PC", "Tablet", "All"]).optional().describe("Default Mobile"),
      steps: z.array(z.object({
        name: z.string().trim().min(1).max(80),
        urlContains: URL_PATTERNS.optional().describe("Pages that count as this step, e.g. [\"/quote\"]"),
        smartEvent: z.string().trim().min(1).max(80).optional().describe("Or a Clarity Smart Event name, e.g. RequestQuote")
      }).refine(step => Boolean(step.urlContains?.length) !== Boolean(step.smartEvent), "Give each step either urlContains or smartEvent")).min(2).max(6)
    },
    annotations: { readOnlyHint: true }
  }, forProject(async ({ auth, args, project, link }) => {
    const numOfDays = args.numOfDays || 3, dimensions = ["URL", "Device"], device = args.device || "Mobile";
    const needsPages = args.steps.some(step => step.urlContains?.length);
    let response = { ok: true, cached: false }, table = { rows: [], truncated: false };
    if (needsPages) {
      response = await exportPull(auth, project, numOfDays, dimensions);
      if (!response.ok) return exportError(response, link);
      table = tabulate(response.body, dimensions);
    }
    const report = funnelReport(table, args.steps, { device });
    // Smart Event steps: one dashboard query each, over the same window.
    for (const step of report.steps) {
      if (!step.smartEvent) continue;
      const query = `Number of sessions with the smart event "${step.smartEvent}"${device === "All" ? "" : ` on ${device === "PC" ? "PC" : device.toLowerCase()} devices`} in the last ${numOfDays} days`;
      const answer = await mcpCall(auth, project, "/dashboard/query", { query, timezone: "UTC" }, 3600);
      step.query = query;
      if (answer.ok) { step.dashboardAnswer = answer.body; step.sessions = singleNumber(answer.body); }
      else step.error = answer.status === 429 ? "Clarity's daily dashboard-query limit is used up" : `Clarity returned ${answer.status}`;
    }
    const rated = withStepRates(report.steps);
    return result({
      ...meta(project, response, numOfDays, needsPages ? dimensions : []), device, ...rated,
      notes: [
        "Each URL step adds the sessions of every matching page, so a session that saw two matching pages counts twice.",
        rated.steps.some(step => step.smartEvent && step.sessions === null) ? "A Smart Event step has no single number in Clarity's answer: read dashboardAnswer." : null,
        "Smart Events must be set up in Clarity (Settings → Smart Events) before they can be counted."
      ].filter(Boolean)
    });
  }));

  register("clarity_campaign_scorecard", {
    title: "Clarity Campaign Landing Page Scorecard",
    description: `Score campaigns and their landing pages from the last 1–3 days of Clarity data: sessions, scroll depth, active time, quick-back, error and dead/rage click rates, flagged against the site average (high quick-back, high errors, shallow scroll, strong engagement). view "campaigns" groups by source / medium / campaign, "pages" by campaign × page, "both" (default) does both and costs two Data Export requests. Clarity doesn't know conversions: join with GA4 key events using the ga4Join call in the result.`,
    inputSchema: {
      project: PROJECT_INPUT, numOfDays: DAYS_INPUT,
      view: z.enum(["campaigns", "pages", "both"]).optional(),
      campaignContains: URL_PATTERNS.optional().describe("Keep only campaigns containing any of these"),
      minSessions: z.number().int().min(1).max(100000).optional().describe("Skip rows with fewer sessions (default 20)"),
      limit: z.number().int().min(1).max(100).optional()
    },
    annotations: { readOnlyHint: true }
  }, forProject(async ({ auth, args, project, link }) => {
    const numOfDays = args.numOfDays || 3, view = args.view || "both";
    const options = { minSessions: args.minSessions ?? 20, limit: args.limit || 30 };
    const out = {};
    let cached = true;
    for (const [key, dimensions] of [["campaigns", ["Source", "Medium", "Campaign"]], ["pages", ["Campaign", "URL"]]]) {
      if (view !== "both" && view !== key) continue;
      const response = await exportPull(auth, project, numOfDays, dimensions);
      if (!response.ok) return exportError(response, link);
      cached &&= Boolean(response.cached);
      const table = tabulate(response.body, dimensions);
      const rows = { ...table, rows: table.rows.filter(row => matches(row.Campaign, args.campaignContains)) };
      out[key] = { ...scorecard(rows, options), ...(table.truncated ? { warning: "Clarity returned its 1,000-row maximum; smaller rows may be missing." } : {}) };
    }
    return result({
      numOfDays, window: `last ${numOfDays * 24} hours (UTC)`, view, servedFromCache: cached, ...out, links: clarityLinks(project),
      ga4Join: { tool: "run_ga4_report", why: "Clarity has no conversions. Match its campaigns to GA4 key events.", arguments: { dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }, { name: "sessionCampaignName" }, { name: "landingPage" }], metrics: [{ name: "sessions" }, { name: "keyEvents" }, { name: "sessionKeyEventRate" }], dateRanges: [{ startDate: `${numOfDays}daysAgo`, endDate: "today" }] } },
      notes: ["Campaign values are UTM tags as Clarity recorded them; untagged traffic shows as (none)."]
    });
  }));

  register("clarity_period_report", {
    title: "Clarity 14-Day Client Report",
    description: "Compare a period (default the last 14 days, ending yesterday UTC) with the period before it: sessions, pages per session, scroll depth, active time and every friction signal, as counts and rates, in total and by device. Built from the daily snapshots this server saves for each Clarity project (Clarity's API only reaches back 3 days), so it covers days since snapshots began; coverage says how many days each period has. userDays adds daily users and is not a unique-user count. For exact totals over dates without snapshots, or deduplicated users, use clarity_dashboard_query with explicit dates. Costs no Clarity requests.",
    inputSchema: {
      project: PROJECT_INPUT,
      days: z.union([z.literal(7), z.literal(14), z.literal(28)]).optional().describe("Period length (default 14)"),
      endDate: dateInput.optional().describe("Last day, YYYY-MM-DD (default yesterday, UTC)")
    },
    annotations: { readOnlyHint: true }
  }, forProject(async ({ auth, args, project }) => {
    const days = args.days || 14;
    const end = args.endDate ? Date.parse(`${args.endDate}T00:00:00Z`) : Date.parse(`${isoDay(Date.now() - DAY)}T00:00:00Z`);
    const dates = (offset) => Array.from({ length: days }, (_, i) => isoDay(end - (offset + i) * DAY)).reverse();
    const currentDates = dates(0), previousDates = dates(days);
    const load = list => Promise.all(list.map(date => store.getSnapshot(auth.userId, project.id, date).then(snapshot => snapshot ? { ...snapshot, date } : null)));
    const [current, previous] = await Promise.all([load(currentDates), load(previousDates)]);
    const have = list => list.filter(Boolean);
    if (!have(current).length && !have(previous).length) {
      return result({
        error: "no_snapshots", project: project.name, dailySnapshots: project.snapshots,
        error_description: project.snapshots
          ? "No daily snapshots saved for this project yet. The first one is saved after the next midnight UTC run, and a full 14-day comparison needs 28 days. Meanwhile, use clarity_dashboard_query with explicit date ranges (e.g. \"Sessions from 2026-11-01 to 2026-11-14\") for each total, or the Clarity dashboard's CSV export."
          : "Daily snapshots are turned off for this project. Turn them on by adding the project again on the Connections page with the snapshot box ticked, or use clarity_dashboard_query with explicit date ranges."
      }, true);
    }
    const now = sumSnapshots(have(current)), before = sumSnapshots(have(previous));
    const devices = [...new Set([...Object.keys(now.byDevice), ...Object.keys(before.byDevice)])];
    const missing = [...currentDates.filter((_, i) => !current[i]), ...previousDates.filter((_, i) => !previous[i])];
    return result({
      period: { current: { from: currentDates[0], to: currentDates.at(-1) }, previous: { from: previousDates[0], to: previousDates.at(-1) } },
      coverage: { currentDays: have(current).length, previousDays: have(previous).length, days, ...(missing.length ? { missingDates: missing.slice(0, 20) } : {}) },
      total: compare(now.total, before.total),
      byDevice: Object.fromEntries(devices.map(device => [device, compare(now.byDevice[device], before.byDevice[device])])),
      links: clarityLinks(project),
      notes: [
        "Counts change as numbers and percent; rates and averages change in points.",
        missing.length ? "Some days have no snapshot, so their periods aren't like for like: compare rates, or fill the gaps with clarity_dashboard_query totals." : null,
        "Each snapshot is the 24 hours before about 00:30 UTC."
      ].filter(Boolean)
    });
  }));

  register("clarity_recordings", {
    title: "Clarity Recording Review Queue",
    description: "List Clarity session recordings for review, for example the latest mobile sessions on a priority product page that hit rage clicks or quick backs, with links to watch each one. Filters: page (urlContains), device, friction signals, campaign, and a date range (default the last 3 days; Clarity keeps recordings about 30 days). Uses Clarity's MCP API (its own daily limit, not the 10 data-export requests); repeated identical calls are cached for 15 minutes.",
    inputSchema: {
      project: PROJECT_INPUT,
      urlContains: z.string().trim().min(1).max(300).optional().describe("Sessions that visited a URL containing this, e.g. /products/carport-20x20"),
      entryUrlContains: z.string().trim().min(1).max(300).optional().describe("Sessions that landed on a URL containing this"),
      device: z.array(DEVICE).min(1).max(3).optional(),
      friction: z.array(z.enum(Object.keys(RECORDING_FLAGS))).max(6).optional().describe("Only sessions with all of these signals"),
      campaign: z.array(z.string().trim().min(1).max(200)).max(10).optional().describe("UTM campaign values"),
      clickedText: z.string().trim().min(1).max(200).optional().describe("Sessions that clicked text containing this, e.g. Get a Quote"),
      startDate: dateInput.optional().describe("YYYY-MM-DD, UTC; default 3 days ago"),
      endDate: dateInput.optional().describe("YYYY-MM-DD, UTC; default now"),
      sortBy: z.enum(SORTS).optional().describe("Default SessionStart_DESC (newest first)"),
      count: z.number().int().min(1).max(100).optional().describe("Recordings to return (default 20)")
    },
    annotations: { readOnlyHint: true }
  }, forProject(async ({ auth, args, project, link }) => {
    const body = recordingsRequest(args);
    const response = await mcpCall(auth, project, "/recordings/sample", body);
    if (!response.ok) return mcpError(response, link);
    const recordings = Array.isArray(response.body) ? response.body.slice(0, body.count) : response.body;
    return result({ filters: body.filters, sortBy: args.sortBy || "SessionStart_DESC", servedFromCache: Boolean(response.cached), recordings, links: clarityLinks(project) });
  }));

  register("clarity_heatmap_review", {
    title: "Clarity Heatmap Review",
    description: "Review one page the way you would in its Clarity heatmap: scroll depth, engagement and click friction on the page by device (Data Export, last 1–3 days), a sample of recent recordings on the page, and, with ctaText, how many sampled sessions clicked the call to action (for example \"Get a Quote\" or \"View specs\"). Clarity's APIs don't return heatmap click or scroll maps, so the result links to the page's heatmap for the visual check. For an exact CTA count, set the CTA up as a Clarity Smart Event and use clarity_funnel_report or clarity_dashboard_query.",
    inputSchema: {
      project: PROJECT_INPUT, numOfDays: DAYS_INPUT,
      url: z.string().trim().min(1).max(300).describe("The page, as a full URL or a path fragment that matches it, e.g. /products/carport-20x20"),
      device: DEVICE.optional().describe("Default all devices"),
      ctaText: z.string().trim().min(1).max(200).optional().describe("Visible text of the call to action, e.g. Get a Quote")
    },
    annotations: { readOnlyHint: true }
  }, forProject(async ({ auth, args, project, link }) => {
    const numOfDays = args.numOfDays || 3, dimensions = ["URL", "Device"];
    const response = await exportPull(auth, project, numOfDays, dimensions);
    if (!response.ok) return exportError(response, link);
    const table = tabulate(response.body, dimensions);
    const rows = table.rows.filter(row => matches(row.URL, [args.url]) && deviceMatches(row, args.device));
    const pageUrls = [...new Set(rows.map(row => row.URL))];
    const sample = { urlContains: args.url, ...(args.device ? { device: [args.device] } : {}), startDate: isoDay(Date.now() - numOfDays * DAY), count: 100 };
    const all = await mcpCall(auth, project, "/recordings/sample", recordingsRequest(sample));
    const cta = args.ctaText ? await mcpCall(auth, project, "/recordings/sample", recordingsRequest({ ...sample, clickedText: args.ctaText })) : null;
    const size = answer => answer?.ok ? (Array.isArray(answer.body) ? answer.body.length : null) : null;
    const sampled = size(all), clicked = size(cta);
    return result({
      page: args.url, matchedUrls: pageUrls.slice(0, 10), device: args.device || "all", numOfDays,
      metrics: { total: rows.length ? totals(rows) : null, byDevice: Object.fromEntries(Object.entries(groupBy(rows, "Device")).map(([device, list]) => [device, totals(list)])) },
      ...(rows.length ? {} : { warning: `No page in the last ${numOfDays * 24} hours matches "${args.url}". Check the URL, or try numOfDays: 3.` }),
      recordings: all.ok ? { sampled, recent: Array.isArray(all.body) ? all.body.slice(0, 10) : all.body } : { error: `Clarity returned ${all.status}` },
      ...(cta ? { cta: cta.ok ? { text: args.ctaText, sessionsInSampleThatClicked: clicked, sampledSessions: sampled,
        clickShareOfSample: sampled && clicked !== null && sampled < 100 ? pct(clicked, sampled) : null,
        note: sampled >= 100 ? "Both samples are capped at 100 recordings, so no share is given; set the CTA up as a Smart Event for an exact rate." : "A share of the recording sample, not of all sessions." } : { error: `Clarity returned ${cta.status}` } } : {}),
      heatmap: { ...clarityLinks(project), lookFor: ["How far the average visitor scrolls compared with where the quote CTA and specs sit", "Clicks on non-clickable images or text (dead clicks)", "Mobile versus desktop differences"] },
      notes: ["Scroll depth is the average share of the page scrolled.", LIMITS_NOTE]
    });
  }));

  register("clarity_dashboard_query", {
    title: "Clarity Dashboard Query",
    description: "Ask Clarity's dashboard one plain-language question over any date range, the same way Microsoft's Clarity MCP server does: totals and breakdowns of sessions, distinct users, pages, devices, countries, sources, channels, campaigns, Smart Events, scroll depth, dead/rage clicks, quick backs, JavaScript errors and Core Web Vitals. Keep each query to one metric with an explicit time range, e.g. \"Sessions on mobile from 2026-11-01 to 2026-11-14\" or \"Top pages by rage clicks last 7 days\". Use it for periods older than 3 days, exact date ranges and deduplicated user counts. Uses Clarity's MCP API (its own daily limit); identical queries are cached for an hour.",
    inputSchema: {
      project: PROJECT_INPUT,
      query: z.string().trim().min(5).max(500),
      timezone: z.string().trim().min(1).max(64).optional().describe("IANA time zone for relative dates, e.g. America/New_York (default UTC)")
    },
    annotations: { readOnlyHint: true }
  }, forProject(async ({ auth, args, project, link }) => {
    const response = await mcpCall(auth, project, "/dashboard/query", { query: args.query, timezone: args.timezone || "UTC" }, 3600);
    if (!response.ok) return mcpError(response, link);
    return result({ query: args.query, timezone: args.timezone || "UTC", servedFromCache: Boolean(response.cached), answer: response.body, links: clarityLinks(project) });
  }));
}

const groupBy = (rows, key) => rows.reduce((groups, row) => { (groups[row[key]] ||= []).push(row); return groups; }, {});

// The body of a recordings request (same shape as Microsoft's Clarity MCP server sends).
export function recordingsRequest({ urlContains, entryUrlContains, device, friction, campaign, clickedText, startDate, endDate, sortBy, count } = {}, now = Date.now()) {
  const end = endDate ? new Date(Math.min(Date.parse(`${endDate}T23:59:59.999Z`), now)) : new Date(now);
  const start = startDate ? new Date(`${startDate}T00:00:00.000Z`) : new Date(end.getTime() - 3 * DAY);
  const filters = {
    date: { start: start.toISOString(), end: end.toISOString() },
    ...(urlContains ? { visitedUrls: [{ url: urlContains, operator: "contains" }] } : {}),
    ...(entryUrlContains ? { entryUrls: [{ url: entryUrlContains, operator: "contains" }] } : {}),
    ...(device?.length ? { deviceType: device } : {}),
    ...(campaign?.length ? { campaign } : {}),
    ...(clickedText ? { clickedText } : {}),
    ...Object.assign({}, ...(friction || []).map(signal => RECORDING_FLAGS[signal]))
  };
  return { sortBy: Math.max(0, SORTS.indexOf(sortBy || "SessionStart_DESC")), start: filters.date.start, end: filters.date.end, filters, count: count || 20 };
}

// The one number in a dashboard answer, when it has exactly one; otherwise null.
export function singleNumber(answer) {
  if (typeof answer === "number") return answer;
  const found = [];
  const walk = value => {
    if (found.length > 1) return;
    if (typeof value === "number") found.push(value);
    else if (typeof value === "string" && /^\s*\d[\d,]*(\.\d+)?\s*$/.test(value)) found.push(Number(value.replace(/,/g, "")));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(answer);
  return found.length === 1 ? found[0] : null;
}
