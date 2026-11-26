import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { buildProfile, profileInstructions } from "./connections/profiles.js";
import { compare, frictionReport, funnelReport, matchProject, pagePath, pickClarityProject, recordingsRequest, scorecard, singleNumber, sumSnapshots, tabulate, withStepRates } from "./connections/_clarity.js";

// The in-memory store must be chosen before the server module creates its store.
process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
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
  const google = { sessionId, refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId };
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
const linkFor = async token => new URL((await callTool(token, "manage_connections", { includeManageUrl: true })).structuredContent.manageUrl).searchParams.get("t");
const form = (t, path, fields) => realFetch(`${baseUrl}${path}?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

// A Data Export answer by URL and device, in Clarity's shape (counts as strings, rates as numbers).
const page = (URL, Device, sessions) => ({ URL, Device, totalSessionCount: String(sessions), totalBotSessionCount: "0", distantUserCount: String(sessions), PagesPerSessionPercentage: 2 });
const signal = (URL, Device, sessions, percent) => ({ URL, Device, sessionsCount: String(sessions), sessionsWithMetricPercentage: percent, sessionsWithoutMetricPercentage: 100 - percent, subTotal: "5" });
const EXPORT = [
  { metricName: "Traffic", information: [
    page("https://www.shop.com/products/carport-a", "Mobile", 400), page("https://www.shop.com/products/carport-a?utm_source=fb", "Mobile", 100),
    page("https://www.shop.com/products/carport-b", "Mobile", 300), page("https://www.shop.com/products/carport-a", "PC", 200),
    page("https://www.shop.com/quote", "Mobile", 120), page("https://www.shop.com/designer", "Mobile", 60), page("https://www.shop.com/tiny", "Mobile", 3)] },
  { metricName: "DeadClickCount", information: [signal("https://www.shop.com/products/carport-a", "Mobile", 400, 10), signal("https://www.shop.com/products/carport-b", "Mobile", 300, 30)] },
  { metricName: "RageClickCount", information: [signal("https://www.shop.com/products/carport-a", "Mobile", 400, 5), signal("https://www.shop.com/products/carport-b", "Mobile", 300, 10)] },
  { metricName: "QuickbackClick", information: [signal("https://www.shop.com/products/carport-a", "PC", 200, 50)] },
  { metricName: "ScrollDepth", information: [{ URL: "https://www.shop.com/products/carport-b", Device: "Mobile", averageScrollDepth: 35.5 }] },
  { metricName: "EngagementTime", information: [{ URL: "https://www.shop.com/products/carport-b", Device: "Mobile", totalTime: "90", activeTime: "40" }] },
  { metricName: "PopularPages", information: [{ url: "x", visitsCount: "1" }] }
];

test("Data Export rows are grouped by page, with each friction signal's sessions and rate", () => {
  assert.equal(pagePath("https://www.shop.com/products/a/?utm_source=x#top"), "shop.com/products/a");
  const table = tabulate(EXPORT, ["URL", "Device"]);
  const a = table.rows.find(row => row.URL === "shop.com/products/carport-a" && row.Device === "Mobile");
  assert.equal(a.sessions, 500, "the ?utm_ variant adds to the page");
  assert.equal(a.deadClicksSessions, 40);
  assert.equal(a.deadClicksRate, 10);
  assert.equal(a.frictionSessions, 60);
  const b = table.rows.find(row => row.URL === "shop.com/products/carport-b");
  assert.equal(b.scrollDepth, 35.5);
  assert.equal(b.activeTimeSec, 40);
  assert.equal(table.truncated, false);

  const report = frictionReport(table, { urlContains: ["/products/"], minSessions: 10 });
  assert.deepEqual(report.pages.map(p => [p.URL, p.Device, p.frictionSessions]), [
    ["shop.com/products/carport-b", "Mobile", 120], ["shop.com/products/carport-a", "PC", 100], ["shop.com/products/carport-a", "Mobile", 60]
  ]);
  assert.equal(frictionReport(table, { urlContains: ["/products/"], device: "PC" }).pages.length, 1);
  assert.equal(frictionReport(table, {}).belowMinSessions, 1, "the 3-session page is left out of the ranking");
});

test("the funnel counts sessions per step and finds the step that loses the most", () => {
  const table = tabulate(EXPORT, ["URL", "Device"]);
  const report = funnelReport(table, [
    { name: "Product page", urlContains: ["/products/"] }, { name: "Quote form", urlContains: ["/quote"] }, { name: "3D Designer", urlContains: ["/designer"] }
  ], { device: "Mobile" });
  assert.deepEqual(report.steps.map(step => step.sessions), [800, 120, 60]);
  assert.equal(report.steps[1].percentOfFirstStep, 15);
  assert.deepEqual(report.biggestDrop, { from: "Product page", to: "Quote form", keptPercent: 15, lostSessions: 680 });
  // A Smart Event step whose count is filled in later.
  const rated = withStepRates([{ step: "A", sessions: 100 }, { step: "Quote", smartEvent: "RequestQuote", sessions: 25 }]);
  assert.equal(rated.steps[1].percentOfPreviousStep, 25);
  assert.equal(singleNumber({ result: { value: "1,250" } }), 1250);
  assert.equal(singleNumber({ a: 1, b: 2 }), null, "several numbers: no single answer");
});

test("the campaign scorecard flags rows against the site average", () => {
  const body = [
    { metricName: "Traffic", information: [{ Campaign: "spring", totalSessionCount: "500" }, { Campaign: "brand", totalSessionCount: "500" }] },
    { metricName: "QuickbackClick", information: [{ Campaign: "spring", sessionsCount: "500", sessionsWithMetricPercentage: 40 }, { Campaign: "brand", sessionsCount: "500", sessionsWithMetricPercentage: 4 }] },
    { metricName: "ScrollDepth", information: [{ Campaign: "spring", averageScrollDepth: 20 }, { Campaign: "brand", averageScrollDepth: 60 }] }
  ];
  const card = scorecard(tabulate(body, ["Campaign"]));
  const spring = card.rows.find(row => row.Campaign === "spring");
  assert.deepEqual(spring.flags, ["high quick-back", "shallow scroll"]);
  assert.deepEqual(card.rows.find(row => row.Campaign === "brand").flags, []);
});

test("snapshots add up into periods and compare as counts and rates", () => {
  const day = (mobile, pc) => ({ rows: [{ Device: "Mobile", sessions: mobile, users: mobile, scrollDepth: 40, deadClicksSessions: mobile / 10 }, { Device: "PC", sessions: pc, users: pc, scrollDepth: 60, deadClicksSessions: 0 }] });
  const now = sumSnapshots([day(100, 100), day(100, 100)]), before = sumSnapshots([day(50, 50)]);
  assert.equal(now.total.sessions, 400);
  assert.equal(now.total.scrollDepth, 50);
  assert.equal(now.byDevice.Mobile.deadClicksRate, 10);
  const change = compare(now.total, before.total);
  assert.deepEqual(change.sessions, { current: 400, previous: 100, change: 300, changePercent: 300 });
  assert.equal(change.scrollDepth.changePercent, undefined, "averages change in points only");
});

test("recording filters map to Clarity's request shape", () => {
  const body = recordingsRequest({ urlContains: "/products/a", device: ["Mobile"], friction: ["rageClicks", "scriptErrors"], sortBy: "SessionClickCount_DESC", count: 10, startDate: "2026-11-01", endDate: "2026-11-03" }, Date.parse("2026-11-25T00:00:00Z"));
  assert.equal(body.sortBy, 5);
  assert.equal(body.count, 10);
  assert.deepEqual(body.filters.visitedUrls, [{ url: "/products/a", operator: "contains" }]);
  assert.deepEqual(body.filters.deviceType, ["Mobile"]);
  assert.equal(body.filters.rageClickPresent, true);
  assert.deepEqual(body.filters.javascriptErrors, [""]);
  assert.deepEqual(body.filters.date, { start: "2026-11-01T00:00:00.000Z", end: "2026-11-03T23:59:59.999Z" });
});

test("a Clarity project is picked by name, site, ID, profile, or the only one connected", () => {
  const projects = [{ id: "clarity:a", name: "getcarports.com", projectId: "abc123" }, { id: "clarity:b", name: "ProBuilt Steel", projectId: null }];
  assert.equal(matchProject(projects, "https://www.getcarports.com/").id, "clarity:a");
  assert.equal(matchProject(projects, "abc123").id, "clarity:a");
  assert.equal(matchProject(projects, "probuilt").id, "clarity:b");
  assert.equal(pickClarityProject({ projects }).error, "choose_project");
  assert.equal(pickClarityProject({ projects: projects.slice(0, 1) }).project.id, "clarity:a");
  assert.equal(pickClarityProject({ projects, pinned: "clarity:b" }).project.id, "clarity:b");
  assert.equal(pickClarityProject({ projects, pinned: "clarity:b", wanted: "getcarports.com" }).error, "other_project");
  assert.equal(pickClarityProject({ projects: [] }).error, "not_connected");
});

test("several Clarity projects connect on the Connections page and each tool uses the one named", async () => {
  const token = tokenFor("cl-multi"), t = await linkFor(token);
  const first = await form(t, "/connections/clarity", { token: "aaa.bbb.ccc", project: "getcarports.com", projectId: "abc123", snapshots: "on" });
  assert.match(first.headers.get("location"), /connected=clarity/);
  const second = await form(t, "/connections/clarity", { token: "ddd.eee.fff", project: "ProBuilt Steel" });
  assert.match(second.headers.get("location"), /connected=clarity/);
  const again = await form(t, "/connections/clarity", { token: "ddd.eee.fff", project: "ProBuilt Steel Buildings" });
  assert.match(again.headers.get("location"), /refreshed=1/, "the same token updates its project");
  const bad = await form(t, "/connections/clarity", { token: "ggg.hhh.iii", projectId: "not an id!" });
  assert.match(new URL(bad.headers.get("location"), baseUrl).searchParams.get("error"), /project ID/);

  const listed = (await callTool(token, "clarity_list_projects")).structuredContent;
  assert.equal(listed.projects.length, 2);
  assert.equal(listed.projects.find(p => p.project === "getcarports.com").links.heatmaps, "https://clarity.microsoft.com/projects/view/abc123/heatmaps");
  assert.equal(listed.projects.find(p => p.project === "ProBuilt Steel Buildings").dailySnapshots, false, "unticked box turns snapshots off");
  assert.ok(listed.addProjectUrl.includes("/connections?t="));
  assert.equal((await callTool(token, "manage_connections")).structuredContent.clarity.projects.length, 2);
  const pageHtml = await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text();
  assert.match(pageHtml, /type="checkbox" name="snapshots" value="on" checked/);
  assert.match(pageHtml, /Add another Clarity project/);
  assert.match(pageHtml, /2 of 20 projects connected/);

  const seen = [];
  const clarity = async (url, init) => { seen.push(init.headers.Authorization); return json(EXPORT); };
  const ask = await callTool(token, "clarity_friction_report", {}, clarity);
  assert.equal(ask.structuredContent.error, "choose_project");
  assert.equal(ask.structuredContent.projects.length, 2);
  const report = (await callTool(token, "clarity_friction_report", { project: "getcarports.com", urlContains: ["/products/"] }, clarity)).structuredContent;
  assert.equal(report.clarityProject.project, "getcarports.com");
  assert.equal(report.pages[0].URL, "shop.com/products/carport-b");
  assert.deepEqual(seen, ["Bearer aaa.bbb.ccc"]);
  // The funnel reuses the same cached URL × device pull; the other project gets its own.
  const funnel = (await callTool(token, "clarity_funnel_report", { project: "getcarports.com", steps: [{ name: "Product", urlContains: ["/products/"] }, { name: "Quote", urlContains: ["/quote"] }] }, clarity)).structuredContent;
  assert.equal(funnel.biggestDrop.to, "Quote");
  assert.equal(seen.length, 1, "served from the shared cache");
  await callTool(token, "clarity_friction_report", { project: "ProBuilt" }, clarity);
  assert.deepEqual(seen, ["Bearer aaa.bbb.ccc", "Bearer ddd.eee.fff"]);
});

test("recordings, dashboard queries and heatmap reviews call Clarity's MCP API with the project's token", async () => {
  const token = tokenFor("cl-mcp"), t = await linkFor(token);
  await form(t, "/connections/clarity", { token: "rec.tok.en", project: "shop.com", projectId: "proj9" });
  const calls = [];
  const clarity = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
    if (url.includes("/mcp/recordings/sample")) return json(JSON.parse(init.body).filters.clickedText ? [{ sessionId: "s2" }] : [{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s3" }]);
    if (url.includes("/mcp/dashboard/query")) return json({ answer: "1,234" });
    return json(EXPORT);
  };
  const recordings = (await callTool(token, "clarity_recordings", { urlContains: "/products/carport-a", device: ["Mobile"], friction: ["rageClicks"], count: 2 }, clarity)).structuredContent;
  assert.deepEqual(recordings.recordings, [{ sessionId: "s1" }, { sessionId: "s2" }]);
  assert.equal(calls[0].url, "https://clarity.microsoft.com/mcp/recordings/sample");
  assert.equal(calls[0].auth, "Bearer rec.tok.en");
  assert.equal(calls[0].body.filters.rageClickPresent, true);

  const query = (await callTool(token, "clarity_dashboard_query", { query: "Sessions on mobile from 2026-11-01 to 2026-11-14" }, clarity)).structuredContent;
  assert.deepEqual(query.answer, { answer: "1,234" });
  assert.equal(calls.at(-1).body.timezone, "UTC");

  const heatmap = (await callTool(token, "clarity_heatmap_review", { url: "/products/carport-a", ctaText: "Get a Quote" }, clarity)).structuredContent;
  assert.equal(heatmap.metrics.total.sessions, 700);
  assert.equal(heatmap.cta.sessionsInSampleThatClicked, 1);
  assert.equal(heatmap.cta.clickShareOfSample, 33.3);
  assert.equal(heatmap.heatmap.heatmaps, "https://clarity.microsoft.com/projects/view/proj9/heatmaps");

  const funnel = (await callTool(token, "clarity_funnel_report", { steps: [{ name: "Product", urlContains: ["/products/"] }, { name: "Quote request", smartEvent: "RequestQuote" }] }, clarity)).structuredContent;
  assert.equal(funnel.steps[1].sessions, 1234);
  assert.match(funnel.steps[1].query, /RequestQuote.*mobile/);

  const limited = await callTool(token, "clarity_dashboard_query", { query: "Top pages last 7 days" }, async () => new Response("limit", { status: 429 }));
  assert.equal(limited.structuredContent.error, "daily_limit");
});

test("the daily job saves one snapshot per project and the period report compares them", async () => {
  const token = tokenFor("cl-snap"), t = await linkFor(token);
  await form(t, "/connections/clarity", { token: "snp.tok.en", project: "shop.com", snapshots: "on" });
  const id = (await store.list("cl-snap")).find(other => other.startsWith("clarity:"));

  assert.equal((await callTool(token, "clarity_period_report")).structuredContent.error, "no_snapshots");

  process.env.CRON_SECRET = "cron-secret";
  const denied = await realFetch(`${baseUrl}/cron/clarity-snapshots`, { headers: { Authorization: "Bearer wrong" } });
  assert.equal(denied.status, 401);
  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) ? realFetch(url, init)
    : Promise.resolve(json([{ metricName: "Traffic", information: [{ Device: "Mobile", totalSessionCount: "70" }, { Device: "PC", totalSessionCount: "30" }] }]));
  try {
    const run = await (await realFetch(`${baseUrl}/cron/clarity-snapshots`, { headers: { Authorization: "Bearer cron-secret" } })).json();
    assert.ok(run.saved >= 1);
  } finally { globalThis.fetch = realFetch; delete process.env.CRON_SECRET; }

  // Seed four weeks of days around the saved one.
  const DAY = 86_400_000, iso = time => new Date(time).toISOString().slice(0, 10);
  for (let i = 1; i <= 28; i++) await store.saveSnapshot("cl-snap", id, iso(Date.now() - i * DAY), { rows: [{ Device: "Mobile", sessions: i <= 14 ? 200 : 100, users: 50, scrollDepth: 40, rageClicksSessions: i <= 14 ? 20 : 5 }] });
  const report = (await callTool(token, "clarity_period_report", { days: 14 })).structuredContent;
  assert.equal(report.coverage.currentDays, 14);
  assert.equal(report.coverage.previousDays, 14);
  assert.deepEqual(report.total.sessions, { current: 2800, previous: 1400, change: 1400, changePercent: 100 });
  assert.equal(report.total.rageClicksRate.current, 10);
  assert.equal(report.total.rageClicksRate.change, 5);
  assert.ok(report.byDevice.Mobile);

  // Disconnecting the project deletes its snapshots and drops it from the daily job.
  await realFetch(`${baseUrl}/connections/${encodeURIComponent(id)}/disconnect?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual" });
  assert.equal(await store.getSnapshot("cl-snap", id, iso(Date.now() - 3 * DAY)), null);
  assert.ok(!(await store.snapshotTargets()).some(target => target.userId === "cl-snap"));
});

test("a profile can be set to one Clarity project", async () => {
  const options = { accountOptions: { google: ["main"], meta: ["main"], callrail: ["main"] }, clarityOptions: [["clarity:a", "getcarports.com"], ["clarity:b", "ProBuilt"]] };
  const { profile } = buildProfile({ name: "ProBuilt", clarityProject: "clarity:b" }, options);
  assert.equal(profile.clarityProject, "clarity:b");
  assert.deepEqual(profile.platforms, ["clarity"]);
  assert.match(profileInstructions(profile), /Clarity project: ProBuilt/);
  assert.equal(buildProfile({ name: "X", clarityProject: "clarity:zzz" }, options).error, "Pick a Clarity project from the list.");
  assert.equal(buildProfile({ name: "Any", clarityProject: "any" }, options).profile.clarityProject, null);

  await store.save("cl-profile", "clarity:a", { credentials: { token: "one.one.one", project: "getcarports.com" }, label: "getcarports.com" });
  await store.save("cl-profile", "clarity:b", { credentials: { token: "two.two.two", project: "ProBuilt" }, label: "ProBuilt" });
  await store.saveProfile("cl-profile", { slug: "probuilt-cccccc", name: "ProBuilt", accounts: { google: null, meta: null, callrail: null }, accountLabels: { clarity: "ProBuilt" }, platforms: ["clarity"], clarityProject: "clarity:b", defaults: {}, createdAt: Date.now() });
  const token = tokenFor("cl-profile"), path = "/mcp/p/probuilt-cccccc";
  const tools = (await rpc(token, path, "tools/list", {})).tools;
  assert.ok(!tools.find(tool => tool.name === "clarity_friction_report").inputSchema.properties?.project, "the profile decides the project");
  let used;
  await callTool(token, "clarity_insights", {}, async (url, init) => { used = init.headers.Authorization; return json([]); }, path);
  assert.equal(used, "Bearer two.two.two");
});
