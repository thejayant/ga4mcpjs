import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { GBP_DAILY_METRICS, gbpDate, gbpId, gbpRequest as gbpFetch } from '../MCP GBP/client.js';

// The version is part of the URI because hosts cache UI resources by URI.
export const DASHBOARD_URI = 'ui://marketing/dashboard-v2.html';
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
  merchantAccountId: z.string().regex(/^(accounts\/)?\d+$/).optional(),
  gbpLocation: z.string().regex(/^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+$/).optional(),
  callrailAccountId: z.string().regex(/^[A-Za-z0-9]+$/).optional(),
  startDate: date.optional(), endDate: date.optional(), compare: z.boolean().optional()
};
const selectionInputs = Object.fromEntries(['propertyId', 'siteUrl', 'customerId', 'loginCustomerId', 'merchantAccountId', 'gbpLocation', 'callrailAccountId'].map(key => [key, inputs[key]]));

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
    if (!result.ok) return { status: 'error', httpStatus: result.status, message: result.body?.error?.message || result.body?.error_description || 'Source request failed' };
    return { status: 'ready', data: transform(result.body || {}) };
  } catch {
    return { status: 'error', message: 'Source request failed. Retry or check the connection.' };
  }
}

const compactDate = value => /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
const ymd = d => d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '';
const n = value => Number(value || 0);

// Sums every numeric field of daily rows into one totals row. Only valid for
// additive metrics, which is why GA4 users are never totalled this way.
export function sumRows(rows, keys) {
  const total = Object.fromEntries(keys.map(key => [key, 0]));
  for (const row of rows) for (const key of keys) total[key] += n(row[key]);
  return total;
}

// Merges the separate per-metric GBP series into one row per day.
export function gbpDailyRows(body) {
  const days = new Map();
  for (const series of body.multiDailyMetricTimeSeries || []) {
    for (const metric of series.dailyMetricTimeSeries || []) {
      const key = GBP_METRIC_KEYS[metric.dailyMetric];
      if (!key) continue;
      for (const point of metric.timeSeries?.datedValues || []) {
        const day = ymd(point.date);
        if (!days.has(day)) days.set(day, { date: day, ...Object.fromEntries(Object.values(GBP_METRIC_KEYS).map(k => [k, 0])) });
        days.get(day)[key] += n(point.value);
      }
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map(row => ({ ...row, impressions: row.mapsImpressions + row.searchImpressions, actions: row.calls + row.websiteClicks + row.directions }));
}
const GBP_METRIC_KEYS = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'mapsImpressions', BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'mapsImpressions',
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'searchImpressions', BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'searchImpressions',
  CALL_CLICKS: 'calls', WEBSITE_CLICKS: 'websiteClicks', BUSINESS_DIRECTION_REQUESTS: 'directions',
  BUSINESS_CONVERSATIONS: 'conversations', BUSINESS_BOOKINGS: 'bookings'
};
const GBP_TOTAL_KEYS = ['impressions', 'mapsImpressions', 'searchImpressions', 'actions', 'calls', 'websiteClicks', 'directions', 'conversations', 'bookings'];

const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const MERCHANT_KEYS = ['clicks', 'impressions', 'conversions', 'conversionValue'];
const merchantRow = row => {
  const view = row.productPerformanceView || {};
  return { date: ymd(view.date), label: view.title || view.marketingMethod || view.offerId || '', offerId: view.offerId,
    clicks: n(view.clicks), impressions: n(view.impressions), conversions: n(view.conversions),
    conversionValue: n(view.conversionValue?.amountMicros) / 1e6, currency: view.conversionValue?.currencyCode || '' };
};

// Product status arrives once per reporting context, with repeated unspecified
// entries; keep the named contexts and fold issues by code.
export function merchantHealth(body) {
  const contexts = [], issues = new Map();
  for (const status of body.aggregateProductStatuses || []) {
    if (!status.reportingContext) continue;
    contexts.push({ context: status.reportingContext, country: status.country,
      active: n(status.stats?.activeCount), pending: n(status.stats?.pendingCount), disapproved: n(status.stats?.disapprovedCount), expiring: n(status.stats?.expiringCount) });
    for (const issue of status.itemLevelIssues || []) {
      const key = `${issue.code}|${issue.attribute || ''}`;
      const seen = issues.get(key);
      const entry = seen || { code: issue.code, label: issue.description || issue.code, detail: issue.detail || '', severity: issue.severity, products: 0, contexts: [], docs: issue.documentationUri || '' };
      entry.products = Math.max(entry.products, n(issue.productCount));
      if (issue.severity === 'DISAPPROVED') entry.severity = 'DISAPPROVED';
      if (!entry.contexts.includes(status.reportingContext)) entry.contexts.push(status.reportingContext);
      issues.set(key, entry);
    }
  }
  const rank = { DISAPPROVED: 0, DEMOTED: 1, NOT_IMPACTED: 2 };
  return { contexts, issues: [...issues.values()].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || b.products - a.products).slice(0, 12) };
}

export function registerDashboard(server, deps) {
  const { req, withVerifiedToolAuth: auth, buildToolResult: result, scopes, listGa4Properties,
    listSearchConsoleSites, listGoogleAdsAccessibleCustomers, runGa4Report, querySearchConsole, queryGoogleAds,
    listMerchantAccounts, searchMerchantReports, getMerchantProductStatusSummary,
    withCallRail, listCallRailAccounts, getCallRailCallSummary, getCallRailCallTimeseries, gbpEnabled } = deps;
  const gbpRequest = deps.gbpRequest || gbpFetch;
  const html = () => readFileSync(new URL('./dist/dashboard.html', import.meta.url), 'utf8');
  server.registerResource('marketing-dashboard', DASHBOARD_URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
    contents: [{ uri: DASHBOARD_URI, mimeType: 'text/html;profile=mcp-app', text: html(),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } }, 'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' } } }]
  }));
  server.registerTool('open_marketing_dashboard', {
    title: 'Marketing Dashboard', description: 'Open the marketing dashboard in ChatGPT: website traffic (GA4), organic search (Search Console), Google Ads, Merchant Center, Google Business Profile and CallRail calls, with a cross-channel overview and period comparison. Optionally pass the account IDs for one business (GA4 property, Search Console site, Ads customer, Merchant account, Business Profile location as accounts/{id}/locations/{id}, CallRail account) to open it preloaded; otherwise the user picks accounts in the dashboard.',
    inputSchema: selectionInputs, annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: DASHBOARD_URI }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } }
  }, async (raw = {}) => {
    // Account IDs the model already knows (for example from list tools) preselect the dashboard.
    const selection = z.object(selectionInputs).parse(raw || {});
    return result({ version: 2, defaults: { ...dashboardRange(), compare: true }, sources: availableSources(), selection });
  });

  function availableSources() {
    return ['ga4', 'search_console', 'google_ads', 'merchant_center', ...(gbpEnabled ? ['gbp'] : []), ...(withCallRail ? ['callrail'] : [])];
  }
  const source = async (scope, fetcher) => {
    const envelope = await auth(req, [scope], async ({ googleCredentials }) => result(await fetcher(googleCredentials.accessToken)));
    return envelope.isError ? { status: 'error', message: envelope.structuredContent?.error_description || 'Reconnect this source to grant access.' } : envelope.structuredContent;
  };
  const callrail = async (fetcher) => {
    const envelope = await withCallRail(async token => result(await fetcher(token)));
    return envelope.isError ? { status: 'error', message: envelope.structuredContent?.error_description || 'Connect CallRail to see call data.' } : envelope.structuredContent;
  };

  server.registerTool('list_dashboard_accounts', {
    title: 'List Dashboard Accounts', description: 'List the accounts the dashboard can show: GA4 properties, Search Console sites, Google Ads customers, Merchant Center accounts, Business Profile locations and CallRail accounts. Each source reports access errors independently.',
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, async () => {
    const tasks = {
      ga4: source(scopes.ga4, token => report(() => listGa4Properties(token), body => (body.accountSummaries || []).flatMap(a => (a.propertySummaries || []).map(p => ({ id: p.property, name: p.displayName, account: a.displayName }))))),
      search_console: source(scopes.search_console, token => report(() => listSearchConsoleSites(token), body => (body.siteEntry || []).map(s => ({ id: s.siteUrl, name: s.siteUrl.replace(/^sc-domain:/, '') , account: s.siteUrl.startsWith('sc-domain:') ? 'Domain property' : 'URL prefix' })))),
      google_ads: source(scopes.google_ads, token => report(() => listGoogleAdsAccessibleCustomers(token), body => (body.resourceNames || []).map(id => ({ id: id.replace('customers/', ''), name: id.replace('customers/', '').replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3') })))),
      merchant_center: source(scopes.merchant_center, token => report(() => listMerchantAccounts(token, { pageSize: 500 }), body => (body.accounts || []).map(a => ({ id: a.accountId, name: a.accountName || a.accountId, account: a.homePageUri?.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') }))))
    };
    if (gbpEnabled) tasks.gbp = source(scopes.gbp, token => gbpLocations(token));
    if (withCallRail) tasks.callrail = callrail(token => report(() => listCallRailAccounts(token, { query: { per_page: 250 } }), body => (body.accounts || []).map(a => ({ id: a.id, name: (a.name || a.id).trim() }))));
    const entries = await Promise.all(Object.entries(tasks).map(async ([key, task]) => [key, await task]));
    return result(Object.fromEntries(entries));
  });

  // Locations are listed per account; capped so one large agency login cannot stall the picker.
  async function gbpLocations(token) {
    const accounts = await gbpRequest(token, 'accounts', '/accounts', { query: { pageSize: 20 } });
    if (!accounts.ok) return { status: 'error', httpStatus: accounts.status, message: accounts.body?.error?.message || 'Business Profile accounts unavailable' };
    const lists = await Promise.all((accounts.body.accounts || []).slice(0, 10).map(async account => {
      const id = account.name.split('/')[1];
      const response = await gbpRequest(token, 'information', `/accounts/${gbpId(id)}/locations`, { query: { readMask: 'name,title,storefrontAddress', pageSize: 100 } });
      return response.ok ? (response.body.locations || []).map(location => ({
        id: `accounts/${id}/${location.name}`, name: location.title,
        account: [location.storefrontAddress?.locality, location.storefrontAddress?.administrativeArea].filter(Boolean).join(', ') || account.accountName
      })) : [];
    }));
    return { status: 'ready', data: lists.flat() };
  }

  server.registerTool('get_marketing_dashboard', {
    title: 'Load Marketing Dashboard', description: 'Fetch live marketing reports for the selected accounts across GA4, Search Console, Google Ads, Merchant Center, Business Profile and CallRail. Default: last 28 days ending three days ago, compared with the previous equal period. Each source keeps its own definitions: GA4 users are period totals, GSC totals exclude query breakdowns, Ads and Merchant conversions keep their own attribution, CallRail counts calls by its account time zone.',
    inputSchema: inputs, annotations: { readOnlyHint: true }
  }, async raw => {
    const params = z.object(inputs).parse(raw);
    let range;
    try { range = dashboardRange(params); } catch (error) { return result({ error: error.message }, true); }
    const compare = params.compare !== false;
    const current = { startDate: range.startDate, endDate: range.endDate };
    const previous = { startDate: range.previousStartDate, endDate: range.previousEndDate };
    const sources = {};
    const tasks = [];
    const add = (key, promise) => tasks.push(promise.then(data => { sources[key] = data; }));

    if (params.propertyId) add('ga4', source(scopes.ga4, async token => {
      const run = (dimensions, metrics, dates = current, limit = 10, orderBy = 'sessions') => report(() => runGa4Report(token, {
        propertyId: params.propertyId, dateRanges: [dates], dimensions: dimensions.map(name => ({ name })),
        metrics: metrics.map(name => ({ name })), limit: String(limit),
        orderBys: dimensions[0] === 'date' ? [{ dimension: { dimensionName: 'date' } }] : [{ metric: { metricName: orderBy }, desc: true }]
      }), body => ({ rows: ga4Rows(body).map(row => row.date ? { ...row, date: compactDate(row.date) } : row), rowCount: body.rowCount || 0, metadata: body.metadata || {}, limited: (body.rowCount || 0) > limit }));
      const totals = ['sessions', 'activeUsers', 'newUsers', 'keyEvents', 'totalRevenue', 'engagementRate', 'averageSessionDuration'];
      const daily = ['sessions', 'activeUsers', 'keyEvents', 'totalRevenue'];
      const [t, c, d, dp, channels, pages, devices] = await Promise.all([
        run([], totals), compare ? run([], totals, previous) : null,
        run(['date'], daily, current, 366), compare ? run(['date'], daily, previous, 366) : null,
        run(['sessionDefaultChannelGroup'], ['sessions', 'keyEvents', 'engagementRate']),
        run(['landingPagePlusQueryString'], ['sessions', 'keyEvents', 'engagementRate']),
        run(['deviceCategory'], ['sessions'])
      ]);
      return { status: 'ready', account: params.propertyId, currency: t.data?.metadata?.currencyCode, timeZone: t.data?.metadata?.timeZone,
        totals: t, comparison: c, daily: d, dailyPrevious: dp, channels, pages, devices };
    }));

    if (params.siteUrl) add('search_console', source(scopes.search_console, async token => {
      const run = (dimensions, dates = current, rowLimit = 10) => report(() => querySearchConsole(token, {
        siteUrl: params.siteUrl, ...dates, dimensions, rowLimit, dataState: 'final', type: 'web', aggregationType: 'auto'
      }), body => ({ rows: (body.rows || []).map(row => ({ [dimensions[0] === 'date' ? 'date' : 'label']: row.keys?.[0] || '', clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position })), limited: (body.rows || []).length === rowLimit }));
      const [t, c, d, dp, queries, pages, devices] = await Promise.all([
        run([]), compare ? run([], previous) : null, run(['date'], current, 366), compare ? run(['date'], previous, 366) : null,
        run(['query']), run(['page']), run(['device'], current, 5)
      ]);
      return { status: 'ready', account: params.siteUrl, timeZone: 'America/Los_Angeles', totals: t, comparison: c, daily: d, dailyPrevious: dp, queries, pages, devices };
    }));

    if (params.customerId) add('google_ads', source(scopes.google_ads, async token => {
      const run = (kind, dates = current) => {
        const dimension = kind === 'daily' ? ', segments.date' : kind === 'campaigns' ? ', campaign.name' : '';
        const from = kind === 'campaigns' ? 'campaign' : 'customer';
        const order = kind === 'daily' ? 'segments.date ASC' : 'metrics.cost_micros DESC';
        const limit = kind === 'daily' ? 366 : 10;
        return report(() => queryGoogleAds(token, {
          customerId: params.customerId, loginCustomerId: params.loginCustomerId,
          query: `SELECT customer.currency_code, customer.time_zone, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value${dimension} FROM ${from} WHERE segments.date BETWEEN '${dates.startDate}' AND '${dates.endDate}' ORDER BY ${order} LIMIT ${limit}`
        }), body => ({ rows: (body.results || []).map(row => ({ [kind === 'daily' ? 'date' : 'label']: row.segments?.date || row.campaign?.name || '', currency: row.customer?.currencyCode, timeZone: row.customer?.timeZone,
          impressions: n(row.metrics?.impressions), clicks: n(row.metrics?.clicks), cost: n(row.metrics?.costMicros) / 1e6,
          conversions: n(row.metrics?.conversions), conversionValue: n(row.metrics?.conversionsValue) })), limited: Boolean(body.nextPageToken) || (body.results || []).length === limit }));
      };
      const [t, c, d, dp, campaigns] = await Promise.all([run('totals'), compare ? run('totals', previous) : null, run('daily'), compare ? run('daily', previous) : null, run('campaigns')]);
      const first = t.data?.rows?.[0];
      return { status: 'ready', account: params.customerId, currency: first?.currency, timeZone: first?.timeZone, totals: t, comparison: c, daily: d, dailyPrevious: dp, campaigns };
    }));

    if (params.merchantAccountId) add('merchant_center', source(scopes.merchant_center, async token => {
      const accountId = params.merchantAccountId.replace(/^accounts\//, '');
      const query = (q, transform) => report(() => searchMerchantReports(token, { accountId, query: q, pageSize: 1000 }), transform);
      const between = dates => `date BETWEEN '${dates.startDate}' AND '${dates.endDate}'`;
      // Merchant metrics are additive per day, so totals come from summing the daily rows.
      const daily = dates => query(`SELECT date, clicks, impressions, conversions, conversion_value FROM product_performance_view WHERE ${between(dates)}`,
        body => ({ rows: (body.results || []).map(merchantRow).sort((a, b) => a.date.localeCompare(b.date)) }));
      const [d, dp, products, methods, health] = await Promise.all([
        daily(current), compare ? daily(previous) : null,
        query(`SELECT offer_id, title, clicks, impressions, conversions FROM product_performance_view WHERE ${between(current)} ORDER BY clicks DESC LIMIT 10`, body => ({ rows: (body.results || []).map(merchantRow), limited: (body.results || []).length === 10 })),
        query(`SELECT marketing_method, clicks, impressions, conversions FROM product_performance_view WHERE ${between(current)}`, body => ({ rows: (body.results || []).map(row => ({ ...merchantRow(row), label: row.productPerformanceView?.marketingMethod === 'ADS' ? 'Shopping ads' : 'Free listings' })) })),
        report(() => getMerchantProductStatusSummary(token, { accountId, pageSize: 100 }), merchantHealth)
      ]);
      const totalsOf = r => r?.status === 'ready' ? { status: 'ready', data: { rows: [sumRows(r.data.rows, MERCHANT_KEYS)] } } : r;
      return { status: 'ready', account: accountId, totals: totalsOf(d), comparison: compare ? totalsOf(dp) : null, daily: d, dailyPrevious: dp, products, methods, health };
    }));

    if (params.gbpLocation && gbpEnabled) add('gbp', source(scopes.gbp, async token => {
      const [, accountId, , locationId] = params.gbpLocation.split('/');
      const performance = dates => report(() => gbpRequest(token, 'performance', `/locations/${gbpId(locationId)}:fetchMultiDailyMetricsTimeSeries`, { query: {
        dailyMetrics: GBP_DAILY_METRICS, ...gbpDate(dates.startDate, 'dailyRange.startDate'), ...gbpDate(dates.endDate, 'dailyRange.endDate')
      } }), body => ({ rows: gbpDailyRows(body) }));
      const [startYear, startMonth] = range.startDate.split('-').map(Number);
      const [endYear, endMonth] = range.endDate.split('-').map(Number);
      const [d, dp, reviews, keywords] = await Promise.all([
        performance(current), compare ? performance(previous) : null,
        report(() => gbpRequest(token, 'legacy', `/accounts/${gbpId(accountId)}/locations/${gbpId(locationId)}/reviews`, { query: { pageSize: 50, orderBy: 'updateTime desc' } }), body => {
          const list = body.reviews || [];
          return { averageRating: body.averageRating ?? null, totalReviewCount: body.totalReviewCount ?? null, sampleSize: list.length,
            unanswered: list.filter(r => !r.reviewReply).length,
            distribution: [5, 4, 3, 2, 1].map(stars => ({ stars, count: list.filter(r => STAR[r.starRating] === stars).length })),
            latest: list.slice(0, 6).map(r => ({ stars: STAR[r.starRating] || null, comment: (r.comment || '').slice(0, 280), reviewer: r.reviewer?.displayName || 'Google user', time: r.createTime, replied: Boolean(r.reviewReply) })) };
        }),
        report(() => gbpRequest(token, 'performance', `/locations/${gbpId(locationId)}/searchkeywords/impressions/monthly`, { query: {
          'monthlyRange.startMonth.year': startYear, 'monthlyRange.startMonth.month': startMonth, 'monthlyRange.endMonth.year': endYear, 'monthlyRange.endMonth.month': endMonth, pageSize: 100
        } }), body => ({ rows: (body.searchKeywordsCounts || []).map(k => ({ label: k.searchKeyword, impressions: n(k.insightsValue?.value || k.insightsValue?.threshold), threshold: !k.insightsValue?.value }))
          .sort((a, b) => b.impressions - a.impressions).slice(0, 10), months: `${range.startDate.slice(0, 7)} to ${range.endDate.slice(0, 7)}` }))
      ]);
      const totalsOf = r => r?.status === 'ready' ? { status: 'ready', data: { rows: [sumRows(r.data.rows, GBP_TOTAL_KEYS)] } } : r;
      return { status: 'ready', account: params.gbpLocation, totals: totalsOf(d), comparison: compare ? totalsOf(dp) : null, daily: d, dailyPrevious: dp, reviews, keywords };
    }));

    if (params.callrailAccountId && withCallRail) add('callrail', callrail(async token => {
      const accountId = params.callrailAccountId;
      const fields = 'total_calls,answered_calls,missed_calls,first_time_callers,average_duration';
      const window = dates => ({ start_date: dates.startDate, end_date: dates.endDate });
      const summary = dates => report(() => getCallRailCallSummary(token, { accountId, query: { ...window(dates), fields } }), body => ({ rows: [callrailRow(body.total_results)], timeZone: body.time_zone }));
      const series = dates => report(() => getCallRailCallTimeseries(token, { accountId, query: { ...window(dates), fields: 'total_calls,answered_calls,missed_calls,first_time_callers', interval: 'day' } }), body => ({ rows: (body.data || []).map(row => ({ date: row.date || row.key, ...callrailRow(row) })) }));
      const grouped = (groupBy, dates = current) => report(() => getCallRailCallSummary(token, { accountId, query: { ...window(dates), fields: 'total_calls,answered_calls,first_time_callers', group_by: groupBy } }),
        body => { const rows = (body.grouped_results || []).map(row => ({ label: row.key || '(none)', ...callrailRow(row) })).sort((a, b) => b.calls - a.calls); return { rows: rows.slice(0, 10), limited: rows.length > 10 }; });
      const [t, c, d, dp, sources, campaigns] = await Promise.all([summary(current), compare ? summary(previous) : null, series(current), compare ? series(previous) : null, grouped('source'), grouped('campaign')]);
      return { status: 'ready', account: accountId, timeZone: t.data?.timeZone, totals: t, comparison: c, daily: d, dailyPrevious: dp, sources, campaigns };
    }));

    await Promise.all(tasks);
    return result({ version: 2, fetchedAt: new Date().toISOString(), range, selection: params, sources, available: availableSources(),
      notes: ['Each source reports in its own time zone: GA4 by property, Google Ads by account, Search Console in Pacific time, CallRail by account.',
        'GA4 key events, Google Ads conversions and Merchant Center conversions use different attribution. Never add them together.',
        'Top-ten tables are partial breakdowns, not totals. Search Console omits anonymised queries.',
        'Business Profile keyword counts below 15 are shown as a threshold, not an exact number.',
        'The default range ends three days ago to allow for reporting delay. Recent days may still be revised.'] });
  });
}

function callrailRow(row = {}) {
  const calls = n(row.total_calls), answered = n(row.answered_calls);
  return { calls, answered, missed: n(row.missed_calls ?? (calls - answered)), firstTime: n(row.first_time_callers), averageDuration: n(row.average_duration), answerRate: calls ? answered / calls : 0 };
}
