// Test fixtures shaped like real API responses. Used only by tests and the
// local preview harness; the dashboard never falls back to them.
const day = (start, i) => new Date(+new Date(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
const wave = (i, base, swing, seed = 1) => Math.max(0, Math.round(base + swing * Math.sin(i / 3 + seed) + (i % 7 === 5 || i % 7 === 6 ? -base * 0.35 : 0)));

function ga4Body(params) {
  const dims = params.dimensions.map(d => d.name), metrics = params.metrics.map(m => m.name);
  const { startDate, endDate } = params.dateRanges[0];
  const prior = startDate < '2026-09-01';
  const scale = prior ? 0.88 : 1;
  const value = (metric, i = 0) => ({ sessions: wave(i, 120, 30) * scale, activeUsers: wave(i, 95, 22) * scale, newUsers: wave(i, 70, 15), keyEvents: wave(i, 6, 3) * (prior ? 1.2 : 1), totalRevenue: 0,
    engagementRate: 0.61, averageSessionDuration: 142 })[metric] ?? 0;
  let rows;
  if (!dims.length) {
    const days = (new Date(endDate) - new Date(startDate)) / 86400000 + 1;
    rows = [{ metricValues: metrics.map(m => ({ value: String(['engagementRate', 'averageSessionDuration'].includes(m) ? value(m) : Math.round(value(m) * days)) })) }];
  } else if (dims[0] === 'date') {
    const days = (new Date(endDate) - new Date(startDate)) / 86400000 + 1;
    rows = Array.from({ length: days }, (_, i) => ({ dimensionValues: [{ value: day(startDate, i).replace(/-/g, '') }], metricValues: metrics.map(m => ({ value: String(value(m, i)) })) }));
  } else {
    const pool = { sessionDefaultChannelGroup: ['Organic Search', 'Direct', 'Paid Search', 'Referral', 'AI Assistant', 'Organic Social'], landingPagePlusQueryString: ['/', '/carports', '/garages/residential', '/barns', '/financing?utm=x', '/contact'], deviceCategory: ['mobile', 'desktop', 'tablet'],
      sessionSource: ['google', '(direct)', 'bing', 'chatgpt.com', 'facebook.com'], sessionMedium: ['organic', '(none)', 'cpc', 'referral', 'social'], eventName: ['generate_lead', 'phone_call', 'form_submit'], country: ['United States', 'Canada'],
      defaultChannelGroup: ['Paid Search', 'Organic Search', 'Direct', 'Referral'], firstUserDefaultChannelGroup: ['Organic Search', 'Paid Search', 'Direct'], sourceMedium: ['google / cpc', 'google / organic', '(direct) / (none)'],
      campaignName: ['Search | Carports', 'PMax | All products', '(organic)'], pagePath: ['/', '/carports', '/garages'] };
    const labels = pool[dims[0]] || ['(not set)', 'a', 'b'];
    rows = labels.map((label, i) => ({ dimensionValues: dims.map((d, j) => ({ value: j ? (pool[d] || ['x'])[i % (pool[d] || ['x']).length] : label })),
      metricValues: metrics.map(m => ({ value: String(['engagementRate', 'bounceRate'].includes(m) ? 0.5 + i / 20 : Math.round(2000 / (i + 1))) })) }));
  }
  return { dimensionHeaders: dims.map(name => ({ name })), metricHeaders: metrics.map(name => ({ name })), rows, rowCount: rows.length, metadata: { currencyCode: 'USD', timeZone: 'America/Los_Angeles' } };
}

export function fixtureDeps(overrides = {}) {
  const calls = { ga4: [], ga4Batches: [], gsc: [], ads: [], merchant: [], gbp: [], callrail: [] };
  const deps = {
    req: {}, gbpEnabled: true,
    scopes: { ga4: 'ga4', search_console: 'gsc', google_ads: 'ads', merchant_center: 'merchant', gbp: 'gbp' },
    withVerifiedToolAuth: async (req, scopes, handler) => handler({ googleCredentials: { accessToken: 'test-only' } }),
    buildToolResult: (payload, isError = false) => ({ structuredContent: payload, isError }),
    listGa4Properties: async () => ({ ok: true, body: { accountSummaries: [{ displayName: 'Carport Direct', propertySummaries: [{ property: 'properties/269500556', displayName: 'Carport Direct GA4' }] }] } }),
    listSearchConsoleSites: async () => ({ ok: true, body: { siteEntry: [{ siteUrl: 'sc-domain:carportdirect.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://www.getcarports.com/', permissionLevel: 'siteOwner' }, { siteUrl: 'https://unverified.example/', permissionLevel: 'siteUnverifiedUser' }] } }),
    listGoogleAdsAccessibleCustomers: async () => ({ ok: true, body: { resourceNames: ['customers/2756458445'] } }),
    runGa4Report: async (token, params) => { calls.ga4.push(params); return { ok: true, body: ga4Body(params) }; },
    batchRunGa4Reports: async (token, params) => {
      calls.ga4Batches.push(params);
      for (const request of params.requests) calls.ga4.push({ ...request, propertyId: params.propertyId, batched: true });
      return { ok: true, body: { reports: params.requests.map(ga4Body) } };
    },
    querySearchConsole: async (token, params) => {
      calls.gsc.push(params);
      const prior = params.startDate < '2026-09-01';
      if (!params.dimensions.length) return { ok: true, body: { rows: [{ clicks: prior ? 2600 : 3140, impressions: prior ? 98000 : 121000, ctr: prior ? 0.0265 : 0.026, position: prior ? 14.2 : 12.8 }] } };
      if (params.dimensions[0] === 'date') {
        const days = (new Date(params.endDate) - new Date(params.startDate)) / 86400000 + 1;
        return { ok: true, body: { rows: Array.from({ length: days - 2 }, (_, i) => ({ keys: [day(params.startDate, i)], clicks: wave(i, prior ? 92 : 112, 25), impressions: wave(i, 4200, 900), ctr: 0.026, position: 13 })) } };
      }
      const labels = { query: ['carport direct', 'metal carports', 'carports near me', '24x30 metal building', 'garage kits'], page: ['https://www.carportdirect.com/', 'https://www.carportdirect.com/carports', 'https://www.carportdirect.com/garages'], device: ['MOBILE', 'DESKTOP', 'TABLET'], country: ['usa', 'can'], searchAppearance: ['AMP_BLUE_LINK', 'VIDEO'] }[params.dimensions[0]] || ['other'];
      return { ok: true, body: { rows: labels.map((label, i) => ({ keys: [label], clicks: Math.round(900 / (i + 1)), impressions: Math.round(30000 / (i + 1)), ctr: 0.03 / (i + 1), position: 3 + i * 2.4 })) } };
    },
    queryGoogleAds: async (token, params) => {
      calls.ads.push(params);
      const prior = /BETWEEN '2026-08/.test(params.query);
      const metrics = (scale = 1) => ({ impressions: String(Math.round(52000 * scale)), clicks: String(Math.round(1830 * scale)), costMicros: String(Math.round(4210e6 * scale)), conversions: (61.5 * scale * (prior ? 1.1 : 1)).toFixed(1), conversionsValue: 0 });
      const customer = { currencyCode: 'USD', timeZone: 'America/New_York' };
      if (/^SELECT segments\.date/.test(params.query)) return { ok: true, body: { results: Array.from({ length: 28 }, (_, i) => ({ customer, segments: { date: day(prior ? '2026-08-04' : '2026-09-01', i) }, metrics: metrics(wave(i, prior ? 90 : 100, 22, prior ? 2 : 1) / 2800) })) } };
      if (/segments\.device/.test(params.query)) return { ok: true, body: { results: ['MOBILE', 'DESKTOP', 'MOBILE'].map((device, i) => ({ segments: { device }, metrics: metrics(0.3 / (i + 1)) })) } };
      return { ok: true, body: { results: ['Search | Carports | Exact', 'PMax | All products', 'Search | Brand', 'Demand Gen | Retargeting'].map((name, i) => ({ customer, campaign: { name, status: 'ENABLED', advertisingChannelType: i === 1 ? 'PERFORMANCE_MAX' : 'SEARCH' }, adGroup: { name: `Ad group ${i + 1}` }, metrics: metrics(0.5 / (i + 1)) })) } };
    },
    listMerchantAccounts: async () => ({ ok: true, body: { accounts: [{ accountId: '121515117', accountName: 'Carport Direct', homePageUri: 'https://www.carportdirect.com/' }] } }),
    searchMerchantReports: async (token, params) => {
      calls.merchant.push(params);
      const prior = /BETWEEN '2026-08/.test(params.query);
      if (/SELECT date/.test(params.query)) return { ok: true, body: { results: Array.from({ length: 28 }, (_, i) => ({ productPerformanceView: { date: { year: 2026, month: prior ? 8 : 9, day: (prior ? 4 : 1) + i }, clicks: String(wave(i, prior ? 2 : 1, 1)), impressions: String(wave(i, 190, 40)), conversions: 0, conversionValue: { amountMicros: '0', currencyCode: '' } } })) } };
      if (/marketing_method/.test(params.query)) return { ok: true, body: { results: [{ productPerformanceView: { marketingMethod: 'ORGANIC', clicks: '39', impressions: '4087', conversions: 0 } }] } };
      return { ok: true, body: { results: [{ productPerformanceView: { offerId: '2820', title: '20x41 Vertical Roof Carport', clicks: '2', impressions: '80', conversions: 0 } }, { productPerformanceView: { offerId: '3225', title: '12x31 Residential Style Garage', clicks: '2', impressions: '26', conversions: 0 } }] } };
    },
    getMerchantProductStatusSummary: async () => ({ ok: true, body: { aggregateProductStatuses: [
      { name: 'accounts/1/aggregateProductStatuses/FREE_LOCAL_LISTINGS~US', reportingContext: 'FREE_LOCAL_LISTINGS', country: 'US', stats: { disapprovedCount: '455' }, itemLevelIssues: [{ code: 'local_stores_lack_inventory', severity: 'DISAPPROVED', description: 'Missing local inventory data', detail: 'Missing inventory data for products in your physical stores', productCount: '455' }] },
      { name: 'accounts/1/aggregateProductStatuses/REPORTING_CONTEXT_ENUM_UNSPECIFIED~US', country: 'US', stats: { disapprovedCount: '455' }, itemLevelIssues: [] },
      { name: 'accounts/1/aggregateProductStatuses/SHOPPING_ADS~US', reportingContext: 'SHOPPING_ADS', country: 'US', stats: { activeCount: '12', disapprovedCount: '455' }, itemLevelIssues: [
        { code: 'account_data_quality_availability_checkout_mismatch', severity: 'DISAPPROVED', description: 'Inaccurate checkout availability', detail: 'Ensure that products are accurately represented in terms of availability and shipping information', productCount: '455' },
        { code: 'image_link_broken', attribute: 'n:image_link', severity: 'DISAPPROVED', description: 'Unsupported image type [image_link]', detail: 'Use an image in the accepted format (JPEG, PNG, GIF)', productCount: '10' },
        { code: 'utf8_encoding_error', severity: 'NOT_IMPACTED', description: 'Invalid UTF-8 encoding [description]', detail: 'Use proper UTF-8 encoding for text and avoid double encoding', productCount: '28' }] }
    ] } }),
    gbpRequest: async (token, family, path, options = {}) => {
      calls.gbp.push({ family, path, options });
      if (path === '/accounts') return { ok: true, status: 200, body: { accounts: [{ name: 'accounts/100440815877307284290', accountName: 'Jayant Solanki' }] } };
      if (path.endsWith('/locations')) return { ok: true, status: 200, body: { locations: [{ name: 'locations/3300504517304202205', title: 'Metal Garage Central', storefrontAddress: { locality: 'Mount Airy', administrativeArea: 'NC' } }] } };
      if (path.includes('fetchMultiDailyMetricsTimeSeries')) {
        const start = `${options.query['dailyRange.startDate.year']}-${String(options.query['dailyRange.startDate.month']).padStart(2, '0')}-${String(options.query['dailyRange.startDate.day']).padStart(2, '0')}`;
        const prior = start < '2026-09-01';
        return { ok: true, status: 200, body: { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: options.query.dailyMetrics.map((metric, m) => ({ dailyMetric: metric, timeSeries: { datedValues: Array.from({ length: 28 }, (_, i) => {
          const [y, mo, d] = day(start, i).split('-').map(Number);
          const v = wave(i, (prior ? 9 : 11) / (m + 1), 3, m);
          return v ? { date: { year: y, month: mo, day: d }, value: String(v) } : { date: { year: y, month: mo, day: d } };
        }) } })) }] } };
      }
      if (path.includes('/reviews')) return { ok: true, status: 200, body: { averageRating: 4.6, totalReviewCount: 87, reviews: [
        { starRating: 'FIVE', comment: 'Great experience from quote to install. The crew was on time and the carport is solid.', reviewer: { displayName: 'Dana R.' }, createTime: '2026-09-21T15:00:00Z', reviewReply: { comment: 'Thank you!' } },
        { starRating: 'FOUR', comment: 'Good price, delivery took a week longer than promised.', reviewer: { displayName: 'Marcus T.' }, createTime: '2026-09-14T12:00:00Z' },
        { starRating: 'ONE', comment: 'Nobody called me back about my order.', reviewer: { displayName: 'K. Lee' }, createTime: '2026-09-02T09:00:00Z' },
        { starRating: 'FIVE', reviewer: { displayName: 'Sam' }, createTime: '2026-08-28T09:00:00Z', reviewReply: { comment: 'Thanks' } }] } };
      if (path.includes('searchkeywords')) return { ok: true, status: 200, body: { searchKeywordsCounts: [
        { searchKeyword: 'carport kit', insightsValue: { threshold: '15' } }, { searchKeyword: '2 car carport', insightsValue: { value: '96' } }, { searchKeyword: 'metal garage', insightsValue: { value: '241' } }, { searchKeyword: 'carports near me', insightsValue: { value: '57' } }] } };
      return { ok: false, status: 404, body: { error: { message: 'not found' } } };
    },
    withCallRail: async handler => handler('test-callrail-token'),
    listCallRailAccounts: async () => ({ ok: true, body: { accounts: [{ id: 'ACCd5d9a974d27b4400bb7b69240fdb7e11', name: 'Coast to Coast Carports' }, { id: 'ACCcd60e1949b284b5bbc9a1d7527d3691f', name: 'Boss Buildings ' }] } }),
    listCallRailCompanies: async (token, params) => ({ ok: true, body: { companies: params.accountId === 'ACCd5d9a974d27b4400bb7b69240fdb7e11' ? [{ id: 'COMgetcarports', name: 'Get Carports' }, { id: 'COMc2c', name: 'Coast to Coast Carports' }] : [] } }),
    getCallRailCallSummary: async (token, params) => {
      calls.callrail.push(params);
      const prior = params.query.start_date < '2026-09-01';
      if (params.query.group_by === 'source') return { ok: true, body: { grouped_results: [{ key: 'Google Ads', total_calls: 378, answered_calls: 372, first_time_callers: 306 }, { key: 'Google Organic', total_calls: 318, answered_calls: 296, first_time_callers: 216 }, { key: 'Google My Business', total_calls: 218, answered_calls: 170, first_time_callers: 101 }, { key: 'Direct', total_calls: 137, answered_calls: 127, first_time_callers: 80 }, { key: 'SearchGPT', total_calls: 14, answered_calls: 14, first_time_callers: 9 }] } };
      if (params.query.group_by === 'campaign') return { ok: true, body: { grouped_results: [{ key: 'Search | Carports', total_calls: 240, answered_calls: 236, first_time_callers: 190 }, { key: null, total_calls: 600, answered_calls: 540, first_time_callers: 400 }] } };
      return { ok: true, body: { time_zone: 'Eastern Time (US & Canada)', total_results: prior ? { total_calls: 1020, answered_calls: 960, missed_calls: 60, first_time_callers: 690, average_duration: 198 } : { total_calls: 1173, answered_calls: 1079, missed_calls: 94, first_time_callers: 767, average_duration: 209 } } };
    },
    getCallRailCallTimeseries: async (token, params) => {
      calls.callrail.push(params);
      const prior = params.query.start_date < '2026-09-01';
      return { ok: true, body: { data: Array.from({ length: 28 }, (_, i) => { const total = wave(i, prior ? 36 : 42, 14); const missed = Math.round(total * 0.08); return { key: day(params.query.start_date, i), date: day(params.query.start_date, i), total_calls: total, answered_calls: total - missed, missed_calls: missed, first_time_callers: Math.round(total * 0.65) }; }) } };
    },
    ...overrides
  };
  return { deps, calls };
}
