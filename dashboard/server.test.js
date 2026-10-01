import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardRange, ga4Rows, report, registerDashboard, DASHBOARD_URI } from './server.js';

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
  const tools = {}, resources = {}, ga4Calls = [], gscCalls = [], adsCalls = [];
  const server = { registerTool(name, config, handler) { tools[name] = { config, handler }; }, registerResource(name, uri, config, handler) { resources[uri] = handler; } };
  const body = { metricHeaders: [{ name: 'sessions' }, { name: 'activeUsers' }], rows: [{ metricValues: [{ value: '100' }, { value: '70' }] }], metadata: { currencyCode: 'AED', timeZone: 'Asia/Dubai' } };
  registerDashboard(server, {
    req: {}, scopes: { ga4: 'ga4', search_console: 'gsc', google_ads: 'ads' },
    withVerifiedToolAuth: async (req, scopes, handler) => handler({ googleCredentials: { accessToken: 'test-only' } }),
    buildToolResult: (payload, isError = false) => ({ structuredContent: payload, isError }),
    listGa4Properties: async () => ({ ok: true, body: { accountSummaries: [{ displayName: 'Account', propertySummaries: [{ property: 'properties/123', displayName: 'Site' }] }] } }),
    listSearchConsoleSites: async () => ({ ok: true, body: { siteEntry: [{ siteUrl: 'sc-domain:example.com' }] } }),
    listGoogleAdsAccessibleCustomers: async () => ({ ok: false, status: 403, body: { error: { message: 'Ads unavailable' } } }),
    runGa4Report: async (token, params) => { ga4Calls.push(params); return { ok: true, body }; },
    querySearchConsole: async (token, params) => { gscCalls.push(params); return { ok: true, body: { rows: [{ clicks: 20, impressions: 100, position: 2, ctr: .2 }] } }; },
    queryGoogleAds: async (token, params) => { adsCalls.push(params); return { ok: true, body: { results: [{ customer: { currencyCode: 'AED', timeZone: 'Asia/Dubai' }, metrics: { costMicros: '12500000', conversions: '2.5', clicks: '8' } }] } }; },
    ...overrides
  });
  return { tools, resources, ga4Calls, gscCalls, adsCalls };
}
test('dashboard uses period user totals, unsegmented GSC totals and isolated failures', async () => {
  const h = harness();
  const accounts = (await h.tools.list_dashboard_accounts.handler()).structuredContent;
  assert.equal(accounts.ga4.data[0].id, 'properties/123');
  assert.equal(accounts.google_ads.status, 'error');
  const result = await h.tools.get_marketing_dashboard.handler({ propertyId: '123', siteUrl: 'sc-domain:example.com', startDate: '2026-09-01', endDate: '2026-09-28' });
  assert.equal(result.structuredContent.sources.ga4.totals.data.rows[0].activeUsers, 70);
  assert.deepEqual(h.ga4Calls[0].dimensions, []);
  assert.deepEqual(h.gscCalls[0].dimensions, []);
  assert.equal(h.gscCalls[0].dataState, 'final');
  assert.equal(h.ga4Calls.length, 5);
  assert.equal(h.gscCalls.length, 5);
});
test('Ads converts micros once, retains fractional conversions and MCC ID', async () => {
  const h = harness();
  const data = (await h.tools.get_marketing_dashboard.handler({ customerId: '1234567890', loginCustomerId: '9999999999', compare: false })).structuredContent;
  assert.equal(data.sources.google_ads.totals.data.rows[0].cost, 12.5);
  assert.equal(data.sources.google_ads.totals.data.rows[0].conversions, 2.5);
  assert.equal(h.adsCalls.length, 3);
  assert.equal(h.adsCalls[0].loginCustomerId, '9999999999');
  assert.match(h.adsCalls[0].query, /FROM customer/);
  assert.match(h.adsCalls[2].query, /FROM campaign/);
});
test('source scope denial does not discard other sources; no accounts means no upstream calls', async () => {
  const h = harness({ withVerifiedToolAuth: async (req, scopes, handler) => scopes[0] === 'gsc' ? { isError: true, structuredContent: { error_description: 'Missing scope' } } : handler({ googleCredentials: { accessToken: 'test-only' } }) });
  const data = (await h.tools.get_marketing_dashboard.handler({ propertyId: '123', siteUrl: 'sc-domain:example.com' })).structuredContent;
  assert.equal(data.sources.ga4.status, 'ready');
  assert.equal(data.sources.search_console.status, 'error');
  assert.equal(h.gscCalls.length, 0);
  const empty = harness();
  assert.deepEqual((await empty.tools.get_marketing_dashboard.handler({})).structuredContent.sources, {});
  assert.equal(empty.ga4Calls.length, 0);
});
test('registered resource is self-contained and opener declares both entrypoints', async () => {
  const h = harness();
  const resource = (await h.resources[DASHBOARD_URI]()).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.text, /Marketer Companion/);
  assert.ok(!resource.text.includes('/* APP_SCRIPT */'));
  assert.deepEqual(resource._meta['openai/ui'].availableDisplayModes, ['fullscreen']);
  assert.deepEqual(h.tools.open_marketing_dashboard.config._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.throws(() => h.tools.get_marketing_dashboard.config.inputSchema.startDate.parse('2026-02-30'));
});
