import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardRange, ga4Rows, report, registerDashboard, gbpDailyRows, merchantHealth, sumRows, DASHBOARD_URI } from './server.js';
import { fixtureDeps } from './fixtures.js';

test('equal previous period crosses month boundaries and rejects invalid ranges', () => {
  assert.deepEqual(dashboardRange({ startDate: '2026-09-01', endDate: '2026-09-28' }, new Date('2026-10-01')), {
    startDate: '2026-09-01', endDate: '2026-09-28', previousStartDate: '2026-08-04', previousEndDate: '2026-08-31', days: 28
  });
  for (const params of [{ startDate: '2026-09-30', endDate: '2026-09-01' }, { startDate: '2020-01-01' }, { endDate: '2026-10-01' }]) assert.throws(() => dashboardRange(params, new Date('2026-10-01')));
});
test('GA4 headers control metric mapping; failures never become empty successful reports', async () => {
  assert.deepEqual(ga4Rows({ dimensionHeaders: [{ name: 'date' }], metricHeaders: [{ name: 'sessions' }], rows: [{ dimensionValues: [{ value: '20260901' }], metricValues: [{ value: '52' }] }] }), [{ date: '20260901', sessions: 52 }]);
  assert.equal((await report(async () => ({ ok: false, status: 403, body: { error: { message: 'denied' } } }))).status, 'error');
  assert.equal((await report(async () => { throw new Error('network'); })).status, 'error');
});

function harness(overrides = {}) {
  const tools = {}, resources = {};
  const server = { registerTool(name, config, handler) { tools[name] = { config, handler }; }, registerResource(name, uri, config, handler) { resources[uri] = handler; } };
  const { deps, calls } = fixtureDeps(overrides);
  registerDashboard(server, deps);
  return { tools, resources, calls };
}
const load = (h, args) => h.tools.get_marketing_dashboard.handler({ startDate: '2026-09-01', endDate: '2026-09-28', ...args }).then(r => r.structuredContent);

test('GA4 uses period user totals, normalises dates and loads the previous daily series', async () => {
  const h = harness();
  const data = await load(h, { propertyId: '269500556' });
  const ga4 = data.sources.ga4;
  assert.deepEqual(h.calls.ga4[0].dimensions, []);
  assert.equal(h.calls.ga4.length, 9);
  assert.equal(ga4.breakdown.data.rows[0].sessionDefaultChannelGroup, 'Organic Search');
  assert.deepEqual(ga4.facets.mediums.slice(0, 2), ['organic', '(none)']);
  assert.equal(ga4.facets.keyEvents[0].name, 'generate_lead');
  assert.ok(ga4.totals.data.rows[0].activeUsers > 0);
  assert.equal(ga4.daily.data.rows[0].date, '2026-09-01');
  assert.equal(ga4.dailyPrevious.data.rows[0].date, '2026-08-04');
  assert.equal(ga4.currency, 'USD');
});
test('Search Console totals are unsegmented and final', async () => {
  const h = harness();
  const data = await load(h, { siteUrl: 'sc-domain:carportdirect.com' });
  assert.deepEqual(h.calls.gsc[0].dimensions, []);
  assert.equal(h.calls.gsc[0].dataState, 'final');
  assert.equal(data.sources.search_console.daily.data.rows[0].date, '2026-09-01');
  assert.equal(data.sources.search_console.devices.data.rows.length, 3);
});
test('Ads converts micros once, keeps fractional conversions and the MCC ID', async () => {
  const h = harness();
  const data = await load(h, { customerId: '2756458445', loginCustomerId: '9999999999', compare: false });
  const ads = data.sources.google_ads;
  const daily = ads.daily.data.rows;
  assert.equal(ads.totals.data.rows[0].cost, daily.reduce((sum, row) => sum + row.cost, 0));
  assert.ok(daily.some(row => !Number.isInteger(row.conversions)));
  assert.equal(ads.comparison, null);
  assert.equal(h.calls.ads.length, 2, 'Basic Access: totals come from the daily query');
  assert.equal(h.calls.ads[0].loginCustomerId, '9999999999');
  assert.ok(h.calls.ads.some(call => /^SELECT segments\.date.* FROM customer /.test(call.query)));
  assert.ok(h.calls.ads.some(call => /^SELECT campaign\.name.* FROM campaign /.test(call.query)));
  assert.equal(ads.breakdown.data.rows[1].detail, 'Performance max · Enabled');
});
test('Ads campaign filters scope every query and escape LIKE wildcards; segment breakdowns fold', async () => {
  const h = harness();
  const data = await load(h, { customerId: '2756458445', options: { google_ads: { status: 'ENABLED', channel: 'SEARCH', campaign: '50%_off', breakdown: 'device' } } });
  for (const call of h.calls.ads) {
    assert.match(call.query, /campaign\.status = 'ENABLED' AND campaign\.advertising_channel_type = 'SEARCH' AND campaign\.name LIKE '%50\[%\]\[_\]off%'/);
  }
  assert.ok(h.calls.ads.some(call => /^SELECT segments\.date.* FROM campaign /.test(call.query)));
  assert.deepEqual(data.sources.google_ads.breakdown.data.rows.map(row => row.label), ['Mobile', 'Desktop']);
  const bad = harness();
  await assert.rejects(load(bad, { customerId: '1', options: { google_ads: { campaign: "x' OR 1=1" } } }));
  assert.equal(bad.calls.ads.length, 0);
});
test('GA4 filters apply to totals, a chosen key event keeps the keyEvents column, suggestions stay unfiltered', async () => {
  const h = harness();
  const data = await load(h, { propertyId: '1', options: { ga4: { medium: 'cpc', landingPage: '/carports', keyEvent: 'generate_lead', breakdown: 'sessionSource' } } });
  const totals = h.calls.ga4[0];
  assert.equal(totals.dimensionFilter.andGroup.expressions.length, 2);
  assert.ok(totals.metrics.some(m => m.name === 'keyEvents:generate_lead'));
  assert.ok('keyEvents' in data.sources.ga4.totals.data.rows[0]);
  const suggestions = h.calls.ga4.find(call => call.dimensions.length === 2);
  assert.equal(suggestions.dimensionFilter, undefined);
  const events = h.calls.ga4.find(call => call.dimensions[0]?.name === 'eventName');
  assert.deepEqual(events.metrics, [{ name: 'keyEvents' }]);
  assert.equal(data.sources.ga4.options.breakdown, 'sessionSource');
});
test('Search Console filters and search type reach every query', async () => {
  const h = harness();
  await load(h, { siteUrl: 'sc-domain:x.com', options: { search_console: { query: 'carport', queryMatch: 'notContains', country: 'USA', searchType: 'image', breakdown: 'page' } } });
  for (const call of h.calls.gsc) {
    assert.equal(call.type, 'image');
    assert.deepEqual(call.dimensionFilterGroups[0].filters, [{ dimension: 'query', operator: 'notContains', expression: 'carport' }, { dimension: 'country', operator: 'equals', expression: 'usa' }]);
  }
});
test('Merchant and CallRail filters reach their queries', async () => {
  const h = harness();
  const data = await load(h, { merchantAccountId: '1', callrailAccountId: 'ACC1', options: { merchant_center: { method: 'ADS', country: 'US', breakdown: 'brand' }, callrail: { device: 'mobile', breakdown: 'campaign' } } });
  for (const call of h.calls.merchant) assert.match(call.query, /marketing_method = 'ADS' AND customer_country_code = 'US'/);
  assert.ok(h.calls.merchant.some(call => /^SELECT brand,/.test(call.query)));
  assert.ok(h.calls.callrail.every(call => call.query.device === 'mobile'));
  assert.equal(data.sources.callrail.breakdown.data.rows[0].label, '(none)');
  assert.equal(data.sources.callrail.sources.data.rows[0].label, 'Google Ads');
});
test('Merchant totals are summed from daily rows and health folds duplicate contexts', async () => {
  const h = harness();
  const data = await load(h, { merchantAccountId: '121515117' });
  const merchant = data.sources.merchant_center;
  const daily = merchant.daily.data.rows;
  assert.equal(merchant.totals.data.rows[0].impressions, daily.reduce((sum, row) => sum + row.impressions, 0));
  assert.equal(merchant.methods.data.rows[0].label, 'Free listings');
  assert.equal(merchant.breakdown.data.rows[0].label, '20x41 Vertical Roof Carport');
  assert.deepEqual(merchant.health.data.contexts.map(c => c.context), ['FREE_LOCAL_LISTINGS', 'SHOPPING_ADS']);
  assert.equal(merchant.health.data.issues[0].severity, 'DISAPPROVED');
  assert.equal(merchant.health.data.issues.at(-1).severity, 'NOT_IMPACTED');
  assert.match(h.calls.merchant[0].query, /^SELECT date, clicks/);
});
test('GBP merges metric series per day and treats missing values as zero', () => {
  const rows = gbpDailyRows({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
    { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 20 }, value: '1' }, { date: { year: 2026, month: 9, day: 21 } }] } },
    { dailyMetric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 20 }, value: '4' }] } },
    { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 21 }, value: '2' }] } }] }] });
  assert.deepEqual(rows.map(r => [r.date, r.impressions, r.calls, r.actions]), [['2026-09-20', 5, 0, 0], ['2026-09-21', 0, 2, 2]]);
  assert.deepEqual(sumRows(rows, ['impressions', 'calls']), { impressions: 5, calls: 2 });
});
test('GBP view loads performance, reviews and sorted keywords for the chosen location', async () => {
  const h = harness();
  const data = await load(h, { gbpLocation: 'accounts/100440815877307284290/locations/3300504517304202205' });
  const gbp = data.sources.gbp;
  assert.equal(gbp.status, 'ready');
  assert.equal(gbp.reviews.data.unanswered, 2);
  assert.equal(gbp.reviews.data.averageRating, 4.6);
  assert.deepEqual(gbp.keywords.data.rows.map(k => k.label), ['metal garage', '2 car carport', 'carports near me', 'carport kit']);
  assert.equal(gbp.keywords.data.rows.at(-1).threshold, true);
  assert.ok(h.calls.gbp.some(call => call.path === '/locations/3300504517304202205:fetchMultiDailyMetricsTimeSeries'));
  assert.ok(h.calls.gbp.some(call => call.path === '/accounts/100440815877307284290/locations/3300504517304202205/reviews'));
});
test('GBP is skipped entirely when the feature is off', async () => {
  const h = harness({ gbpEnabled: false });
  const data = await load(h, { gbpLocation: 'accounts/1/locations/2' });
  assert.equal(data.sources.gbp, undefined);
  assert.equal(h.calls.gbp.length, 0);
  assert.equal(data.available.includes('gbp'), false);
});
test('CallRail summarises calls, answer rate and grouped sources', async () => {
  const h = harness();
  const data = await load(h, { callrailAccountId: 'ACCd5d9a974d27b4400bb7b69240fdb7e11' });
  const calls = data.sources.callrail;
  assert.equal(calls.totals.data.rows[0].calls, 1173);
  assert.equal(calls.totals.data.rows[0].answerRate, 1079 / 1173);
  assert.equal(calls.comparison.data.rows[0].calls, 1020);
  assert.equal(calls.sources.data.rows[0].label, 'Google Ads');
  assert.equal(calls.breakdown.data.rows[0].label, 'Google Ads');
  assert.equal(calls.daily.data.rows.length, 28);
});
test('CallRail without a connected token fails alone', async () => {
  const h = harness({ withCallRail: async () => ({ isError: true, structuredContent: { error_description: 'Connect your own CallRail API token.' } }) });
  const data = await load(h, { callrailAccountId: 'ACC1', propertyId: '1' });
  assert.equal(data.sources.callrail.status, 'error');
  assert.match(data.sources.callrail.message, /CallRail/);
  assert.equal(data.sources.ga4.status, 'ready');
});
test('account picker lists every source and keeps failures per source', async () => {
  const h = harness({ listGoogleAdsAccessibleCustomers: async () => ({ ok: false, status: 403, body: { error: { message: 'Ads unavailable' } } }) });
  const accounts = (await h.tools.list_dashboard_accounts.handler()).structuredContent;
  assert.equal(accounts.ga4.data[0].id, 'properties/269500556');
  assert.equal(accounts.google_ads.status, 'error');
  assert.equal(accounts.merchant_center.data[0].name, 'Carport Direct');
  assert.equal(accounts.gbp.data[0].id, 'accounts/100440815877307284290/locations/3300504517304202205');
  assert.equal(accounts.callrail.data[1].name, 'Boss Buildings');
});
test('scope denial does not discard other sources; no accounts means no upstream calls', async () => {
  const h = harness({ withVerifiedToolAuth: async (req, scopes, handler) => scopes[0] === 'gsc' ? { isError: true, structuredContent: { error_description: 'Missing scope' } } : handler({ googleCredentials: { accessToken: 'test-only' } }) });
  const data = await load(h, { propertyId: '123', siteUrl: 'sc-domain:example.com' });
  assert.equal(data.sources.ga4.status, 'ready');
  assert.equal(data.sources.search_console.status, 'error');
  assert.equal(h.calls.gsc.length, 0);
  const empty = harness();
  assert.deepEqual((await load(empty, {})).sources, {});
  assert.equal(empty.calls.ga4.length, 0);
});
test('merchant health ranks disapprovals before notices', () => {
  const health = merchantHealth({ aggregateProductStatuses: [{ reportingContext: 'SHOPPING_ADS', stats: {}, itemLevelIssues: [
    { code: 'a', severity: 'NOT_IMPACTED', productCount: '900' }, { code: 'b', severity: 'DISAPPROVED', productCount: '3' }] }] });
  assert.deepEqual(health.issues.map(i => i.code), ['b', 'a']);
});
test('registered resource is self-contained, versioned and the opener declares both entrypoints', async () => {
  const h = harness();
  const resource = (await h.resources[DASHBOARD_URI]()).contents[0];
  assert.equal(DASHBOARD_URI, 'ui://marketing/dashboard-v3.html');
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.text, /Marketer Companion/);
  assert.ok(!resource.text.includes('/* APP_SCRIPT */'));
  assert.ok(!/\bimport\s*\{/.test(resource.text), 'bundle must not contain module imports');
  assert.deepEqual(resource._meta['openai/ui'].availableDisplayModes, ['fullscreen']);
  assert.deepEqual(h.tools.open_marketing_dashboard.config._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.throws(() => h.tools.get_marketing_dashboard.config.inputSchema.startDate.parse('2026-02-30'));
  assert.throws(() => h.tools.get_marketing_dashboard.config.inputSchema.gbpLocation.parse('accounts/1/locations/../x'));
});
