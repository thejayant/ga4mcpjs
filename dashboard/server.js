import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const DASHBOARD_URI = 'ui://marketing/dashboard-v1.html';
export const DASHBOARD_TOOLS = ['open_marketing_dashboard', 'list_dashboard_accounts', 'get_marketing_dashboard'];
const DAY = 86400000;
const iso = (date) => date.toISOString().slice(0, 10);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && iso(parsed) === value;
}, 'Use a real calendar date');
const inputs = {
  propertyId: z.string().regex(/^(properties\/)?\d+$/).optional(),
  siteUrl: z.string().min(1).max(500).optional(),
  customerId: z.string().regex(/^[\d-]+$/).optional(),
  loginCustomerId: z.string().regex(/^[\d-]+$/).optional(),
  startDate: date.optional(), endDate: date.optional(), compare: z.boolean().optional()
};

export function dashboardRange(params = {}, now = new Date()) {
  const endDate = params.endDate || iso(new Date(+now - 3 * DAY));
  const startDate = params.startDate || iso(new Date(+new Date(`${endDate}T00:00:00Z`) - 27 * DAY));
  const start = +new Date(`${startDate}T00:00:00Z`);
  const end = +new Date(`${endDate}T00:00:00Z`);
  const days = (end - start) / DAY + 1;
  if (!Number.isInteger(days) || days < 1 || days > 366 || endDate >= iso(now)) {
    throw new Error('Choose 1–366 days ending before today.');
  }
  return { startDate, endDate, previousStartDate: iso(new Date(start - days * DAY)), previousEndDate: iso(new Date(start - DAY)), days };
}

export function ga4Rows(body) {
  const dimensions = body.dimensionHeaders || [];
  const metrics = body.metricHeaders || [];
  return (body.rows || []).map(row => Object.fromEntries([
    ...dimensions.map((h, i) => [h.name, row.dimensionValues?.[i]?.value || '']),
    ...metrics.map((h, i) => [h.name, Number(row.metricValues?.[i]?.value || 0)])
  ]));
}

// Each report keeps its own status. A denied or failed request is never a zero.
export async function report(fetcher, transform = body => body) {
  try {
    const result = await fetcher();
    if (!result.ok) return { status: 'error', httpStatus: result.status, message: result.body?.error?.message || 'Source request failed' };
    return { status: 'ready', data: transform(result.body || {}) };
  } catch {
    return { status: 'error', message: 'Source request failed. Retry or check the connection.' };
  }
}

export function registerDashboard(server, deps) {
  const { req, withVerifiedToolAuth: auth, buildToolResult: result, scopes, listGa4Properties,
    listSearchConsoleSites, listGoogleAdsAccessibleCustomers, runGa4Report, querySearchConsole, queryGoogleAds } = deps;
  server.registerResource('marketing-dashboard', DASHBOARD_URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
    contents: [{ uri: DASHBOARD_URI, mimeType: 'text/html;profile=mcp-app', text: readFileSync(new URL('./dist/dashboard.html', import.meta.url), 'utf8'),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } }, 'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' } } }]
  }));
  server.registerTool('open_marketing_dashboard', {
    title: 'Marketing Dashboard', description: 'Open the marketing dashboard in ChatGPT. Select your GA4 property, Search Console site and optional Google Ads account, then load verified performance data.',
    inputSchema: {}, annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } }
  }, async () => result({ version: 1, defaults: { ...dashboardRange(), compare: true } }));

  const source = async (scope, fetcher) => {
    const envelope = await auth(req, [scope], async ({ googleCredentials }) => result(await fetcher(googleCredentials.accessToken)));
    return envelope.isError ? { status: 'error', message: envelope.structuredContent?.error_description || 'Reconnect this source to grant access.' } : envelope.structuredContent;
  };
  server.registerTool('list_dashboard_accounts', {
    title: 'List Dashboard Accounts', description: 'List accessible GA4 properties, Search Console sites and Google Ads customer IDs. Each source reports access errors independently.',
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, async () => {
    const [ga4, search_console, google_ads] = await Promise.all([
      source(scopes.ga4, token => report(() => listGa4Properties(token), body => (body.accountSummaries || []).flatMap(a => (a.propertySummaries || []).map(p => ({ id: p.property, name: p.displayName, account: a.displayName }))))),
      source(scopes.search_console, token => report(() => listSearchConsoleSites(token), body => (body.siteEntry || []).map(s => ({ id: s.siteUrl, name: s.siteUrl })))),
      source(scopes.google_ads, token => report(() => listGoogleAdsAccessibleCustomers(token), body => (body.resourceNames || []).map(id => ({ id: id.replace('customers/', ''), name: id.replace('customers/', '') }))))
    ]);
    return result({ ga4, search_console, google_ads });
  });
  server.registerTool('get_marketing_dashboard', {
    title: 'Load Marketing Dashboard', description: 'Fetch live marketing reports for selected accounts. Default: last 28 days ending three days ago, previous equal period. GA4 users use period totals, not summed daily users; GSC totals exclude query breakdowns. Ads conversions retain their own attribution.',
    inputSchema: inputs, annotations: { readOnlyHint: true }
  }, async raw => {
    const params = z.object(inputs).parse(raw);
    let range;
    try { range = dashboardRange(params); } catch (error) { return result({ error: error.message }, true); }
    const sources = {};
    const metrics = ['sessions', 'activeUsers', 'keyEvents', 'totalRevenue'];
    const tasks = [];
    const previous = { startDate: range.previousStartDate, endDate: range.previousEndDate };
    const current = { startDate: range.startDate, endDate: range.endDate };
    if (params.propertyId) tasks.push(source(scopes.ga4, async token => {
      const run = (dimensions, dates = current, limit = '10') => report(() => runGa4Report(token, {
        propertyId: params.propertyId, dateRanges: [dates], dimensions: dimensions.map(name => ({ name })),
        metrics: metrics.map(name => ({ name })), limit,
        orderBys: dimensions[0] === 'date' ? [{ dimension: { dimensionName: 'date' } }] : [{ metric: { metricName: 'sessions' }, desc: true }]
      }), body => ({ rows: ga4Rows(body), rowCount: body.rowCount || 0, metadata: body.metadata || {}, limited: (body.rowCount || 0) > Number(limit) }));
      const [totals, comparison, daily, channels, pages] = await Promise.all([
        run([]), params.compare === false ? null : run([], previous), run(['date'], current, '366'), run(['sessionDefaultChannelGroup']), run(['landingPagePlusQueryString'])
      ]);
      return { status: 'ready', account: params.propertyId, totals, comparison, daily, channels, pages };
    }).then(data => { sources.ga4 = data; }));
    if (params.siteUrl) tasks.push(source(scopes.search_console, async token => {
      const run = (dimensions, dates = current, rowLimit = 10) => report(() => querySearchConsole(token, {
        siteUrl: params.siteUrl, ...dates, dimensions, rowLimit, dataState: 'final', type: 'web', aggregationType: 'auto'
      }), body => ({ rows: (body.rows || []).map(row => ({ label: row.keys?.[0] || '', clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position })), limited: (body.rows || []).length === rowLimit }));
      const [totals, comparison, daily, queries, pages] = await Promise.all([
        run([]), params.compare === false ? null : run([], previous), run(['date'], current, 366), run(['query']), run(['page'])
      ]);
      return { status: 'ready', account: params.siteUrl, totals, comparison, daily, queries, pages };
    }).then(data => { sources.search_console = data; }));
    if (params.customerId) tasks.push(source(scopes.google_ads, async token => {
      const run = (kind, dates = current) => {
        const dimension = kind === 'daily' ? ', segments.date' : kind === 'campaigns' ? ', campaign.name' : '';
        const from = kind === 'campaigns' ? 'campaign' : 'customer';
        const order = kind === 'daily' ? 'segments.date ASC' : 'metrics.cost_micros DESC';
        const limit = kind === 'daily' ? 366 : 10;
        return report(() => queryGoogleAds(token, {
          customerId: params.customerId, loginCustomerId: params.loginCustomerId,
          query: `SELECT customer.currency_code, customer.time_zone, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value${dimension} FROM ${from} WHERE segments.date BETWEEN '${dates.startDate}' AND '${dates.endDate}' ORDER BY ${order} LIMIT ${limit}`
        }), body => ({ rows: (body.results || []).map(row => ({ label: row.segments?.date || row.campaign?.name || '', currency: row.customer?.currencyCode, timeZone: row.customer?.timeZone,
          impressions: Number(row.metrics?.impressions || 0), clicks: Number(row.metrics?.clicks || 0), cost: Number(row.metrics?.costMicros || 0) / 1e6,
          conversions: Number(row.metrics?.conversions || 0), conversionValue: Number(row.metrics?.conversionsValue || 0) })), limited: Boolean(body.nextPageToken) || (body.results || []).length === limit }));
      };
      const [totals, comparison, daily, campaigns] = await Promise.all([run('totals'), params.compare === false ? null : run('totals', previous), run('daily'), run('campaigns')]);
      return { status: 'ready', account: params.customerId, totals, comparison, daily, campaigns };
    }).then(data => { sources.google_ads = data; }));
    await Promise.all(tasks);
    return result({ version: 1, fetchedAt: new Date().toISOString(), range, selection: params, sources,
      notes: ['GA4 dates use the property time zone; Google Ads uses the account time zone; Search Console uses Pacific time.',
        'GA4 key events and Google Ads conversions have different attribution. Do not add them together.',
        'Top-ten tables are partial breakdowns, not totals. Search Console omits anonymised queries.',
        'The default range ends three days ago to allow reporting delay. Data may still be revised.'] });
  });
}
