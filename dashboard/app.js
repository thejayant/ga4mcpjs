import { HostBridge } from './bridge.js';
import { reveal, countUp, stopAll, slideIn, slideOut, fadeIn } from './motion.js';
import { el, trendChart, sparkline, rankedTable, shareBar, gauge } from './charts.js';
import { logo } from './logos.js';

const host = new HostBridge({ name: 'Marketer Companion', version: '2.0.0' }, { availableDisplayModes: ['fullscreen'] });
const $ = id => document.getElementById(id);
const STORE_KEY = 'marketer-companion.selection.v2';

/* ---------------- Formatting ---------------- */

const locale = undefined;
const fmt = {
  num: (value, axis) => {
    const v = Number(value) || 0;
    if (axis === true || Math.abs(v) >= 10000) return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
    return new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(v) < 10 && v % 1 ? 2 : 0 }).format(v);
  },
  dec: value => (Number(value) || 0).toFixed(1),
  pct: value => `${((Number(value) || 0) * 100).toFixed(1)}%`,
  pct0: value => `${Math.round((Number(value) || 0) * 100)}%`,
  ratio: value => `${(Number(value) || 0).toFixed(2)}×`,
  seconds: value => { const s = Math.round(Number(value) || 0); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; },
  stars: value => value ? `${Number(value).toFixed(1)} ★` : '—'
};
const moneyFormatter = currency => (value, axis) => {
  const v = Number(value) || 0;
  if (!currency) return fmt.num(v, axis === true);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, notation: axis === true || Math.abs(v) >= 100000 ? 'compact' : 'standard', maximumFractionDigits: axis === true || Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
  } catch { return `${currency} ${fmt.num(v, axis === true)}`; }
};
const toDate = value => new Date(`${value}T00:00:00Z`);
const dateLabel = (value, long) => toDate(value).toLocaleDateString(locale, long ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });
const addDays = (value, days) => new Date(+toDate(value) + days * 86400000).toISOString().slice(0, 10);
const monthSpan = r => {
  const name = value => toDate(`${value.slice(0, 7)}-01`).toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return r.startDate.slice(0, 7) === r.endDate.slice(0, 7) ? name(r.startDate) : `${name(r.startDate)} to ${name(r.endDate)}`;
};
const shortUrl = value => String(value || '').replace(/^https?:\/\/[^/]+/, '') || '/';

/* ---------------- Sources ---------------- */

const icon = (name, cls = 'logo') => logo(name, cls);

// name: the short label people know the product by; full: the product's own name.
// better: which direction is an improvement. 'neutral' for spend, where more is not good or bad by itself.
// hidden: KPI tiles that start switched off; Customize turns them on.
const SOURCES = {
  ga4: {
    name: 'GA4', full: 'Google Analytics 4', select: 'propertyId', pick: 'a GA4 property',
    kpis: [
      { key: 'sessions', label: 'Sessions', format: 'num', better: 'up' },
      { key: 'activeUsers', label: 'Active users', format: 'num', better: 'up' },
      { key: 'keyEvents', label: 'Key events', format: 'num', better: 'up' },
      { key: 'totalRevenue', label: 'Revenue', format: 'money', better: 'up' },
      { key: 'engagementRate', label: 'Engagement rate', format: 'pct', better: 'up' },
      { key: 'keyEventRate', label: 'Key events / session', format: 'pct', better: 'up', derive: r => r.sessions ? r.keyEvents / r.sessions : 0 },
      { key: 'newUsers', label: 'New users', format: 'num', better: 'up', hidden: true },
      { key: 'screenPageViews', label: 'Views', format: 'num', better: 'up', hidden: true },
      { key: 'bounceRate', label: 'Bounce rate', format: 'pct', better: 'down', hidden: true },
      { key: 'averageSessionDuration', label: 'Avg. session duration', format: 'seconds', better: 'up', hidden: true }
    ],
    trend: ['sessions', 'activeUsers', 'newUsers', 'keyEvents', 'totalRevenue', 'screenPageViews'],
    breakdowns: [['sessionDefaultChannelGroup', 'Channel group'], ['sessionSource', 'Source'], ['sessionMedium', 'Medium'], ['sessionSourceMedium', 'Source / medium'], ['sessionCampaignName', 'Campaign'],
      ['landingPagePlusQueryString', 'Landing page'], ['deviceCategory', 'Device'], ['country', 'Country'], ['city', 'City'], ['eventName', 'Event name'], ['newVsReturning', 'New vs returning']],
    filters: [
      { key: 'keyEvent', label: 'Key event', type: 'select', choices: source => [['', 'All key events'], ...(source?.facets?.keyEvents || []).map(e => [e.name, e.name])] },
      { key: 'channel', label: 'Channel group', type: 'suggest', suggest: () => GA4_CHANNELS, placeholder: 'Any channel' },
      { key: 'source', label: 'Source', type: 'suggest', suggest: source => source?.facets?.sources || [], placeholder: 'e.g. google' },
      { key: 'medium', label: 'Medium', type: 'suggest', suggest: source => source?.facets?.mediums || [], placeholder: 'e.g. cpc' },
      { key: 'campaign', label: 'Campaign contains', type: 'text', placeholder: 'Campaign name' },
      { key: 'landingPage', label: 'Landing page contains', type: 'text', placeholder: '/pricing' },
      { key: 'device', label: 'Device', type: 'select', choices: () => [['', 'All devices'], ['desktop', 'Desktop'], ['mobile', 'Mobile'], ['tablet', 'Tablet']] },
      { key: 'country', label: 'Country', type: 'text', placeholder: 'e.g. United States' }
    ]
  },
  search_console: {
    name: 'GSC', full: 'Google Search Console', select: 'siteUrl', pick: 'a Search Console site',
    kpis: [
      { key: 'clicks', label: 'Clicks', format: 'num', better: 'up' },
      { key: 'impressions', label: 'Impressions', format: 'num', better: 'up' },
      { key: 'ctr', label: 'Click-through rate', format: 'pct', better: 'up' },
      { key: 'position', label: 'Average position', format: 'dec', better: 'down' }
    ],
    trend: ['clicks', 'impressions', 'ctr', 'position'],
    breakdowns: [['query', 'Query'], ['page', 'Page'], ['country', 'Country'], ['device', 'Device'], ['searchAppearance', 'Search appearance']],
    filters: [
      { key: 'searchType', label: 'Search type', type: 'select', choices: () => [['', 'Web'], ['image', 'Image'], ['video', 'Video'], ['news', 'News']] },
      { key: 'query', label: 'Query', type: 'text', placeholder: 'brand name', match: 'queryMatch' },
      { key: 'page', label: 'Page URL', type: 'text', placeholder: '/blog/', match: 'pageMatch' },
      { key: 'country', label: 'Country (ISO-3)', type: 'text', placeholder: 'usa', pattern: '[A-Za-z]{3}' },
      { key: 'device', label: 'Device', type: 'select', choices: () => [['', 'All devices'], ['DESKTOP', 'Desktop'], ['MOBILE', 'Mobile'], ['TABLET', 'Tablet']] }
    ]
  },
  google_ads: {
    name: 'Google Ads', full: 'Google Ads', select: 'customerId', pick: 'a Google Ads account',
    kpis: [
      { key: 'cost', label: 'Spend', format: 'money', better: 'neutral' },
      { key: 'clicks', label: 'Clicks', format: 'num', better: 'up' },
      { key: 'conversions', label: 'Conversions', format: 'num', better: 'up' },
      { key: 'cpa', label: 'Cost / conversion', format: 'money', better: 'down', derive: r => r.conversions ? r.cost / r.conversions : 0 },
      { key: 'conversionValue', label: 'Conversion value', format: 'money', better: 'up' },
      { key: 'roas', label: 'ROAS', format: 'ratio', better: 'up', derive: r => r.cost ? r.conversionValue / r.cost : 0 },
      { key: 'impressions', label: 'Impressions', format: 'num', better: 'up', hidden: true },
      { key: 'ctr', label: 'CTR', format: 'pct', better: 'up', hidden: true, derive: r => r.impressions ? r.clicks / r.impressions : 0 },
      { key: 'cpc', label: 'Avg. CPC', format: 'money', better: 'down', hidden: true, derive: r => r.clicks ? r.cost / r.clicks : 0 },
      { key: 'conversionRate', label: 'Conversion rate', format: 'pct', better: 'up', hidden: true, derive: r => r.clicks ? r.conversions / r.clicks : 0 }
    ],
    trend: ['cost', 'clicks', 'impressions', 'conversions', 'conversionValue'],
    breakdowns: [['campaign', 'Campaign'], ['ad_group', 'Ad group'], ['keyword', 'Keyword'], ['search_term', 'Search term'], ['device', 'Device'], ['network', 'Network'], ['conversion_action', 'Conversion action'], ['day_of_week', 'Day of week']],
    filters: [
      { key: 'status', label: 'Campaign status', type: 'select', choices: () => [['', 'All statuses'], ['ENABLED', 'Enabled'], ['PAUSED', 'Paused']] },
      { key: 'channel', label: 'Campaign type', type: 'select', choices: () => [['', 'All types'], ['SEARCH', 'Search'], ['PERFORMANCE_MAX', 'Performance Max'], ['SHOPPING', 'Shopping'], ['DISPLAY', 'Display'], ['VIDEO', 'Video'], ['DEMAND_GEN', 'Demand Gen'], ['LOCAL_SERVICES', 'Local Services']] },
      { key: 'campaign', label: 'Campaign contains', type: 'text', placeholder: 'Brand' }
    ]
  },
  merchant_center: {
    name: 'Merchant Center', full: 'Google Merchant Center', select: 'merchantAccountId', pick: 'a Merchant Center account',
    kpis: [
      { key: 'clicks', label: 'Product clicks', format: 'num', better: 'up' },
      { key: 'impressions', label: 'Impressions', format: 'num', better: 'up' },
      { key: 'ctr', label: 'Click-through rate', format: 'pct', better: 'up', derive: r => r.impressions ? r.clicks / r.impressions : 0 },
      { key: 'conversions', label: 'Conversions', format: 'num', better: 'up' },
      { key: 'conversionValue', label: 'Conversion value', format: 'money', better: 'up', hidden: true }
    ],
    trend: ['clicks', 'impressions', 'conversions'],
    breakdowns: [['product', 'Product'], ['brand', 'Brand'], ['category_l1', 'Google category'], ['product_type_l1', 'Product type'], ['customer_country_code', 'Country'], ['marketing_method', 'Listing type']],
    filters: [
      { key: 'method', label: 'Listing type', type: 'select', choices: () => [['', 'Ads and free listings'], ['ADS', 'Shopping ads'], ['ORGANIC', 'Free listings']] },
      { key: 'country', label: 'Country (ISO-2)', type: 'text', placeholder: 'US', pattern: '[A-Za-z]{2}', upper: true }
    ]
  },
  gbp: {
    name: 'Business Profile', full: 'Google Business Profile', select: 'gbpLocation', pick: 'a Business Profile location',
    kpis: [
      { key: 'impressions', label: 'Profile views', format: 'num', better: 'up' },
      { key: 'actions', label: 'Customer actions', format: 'num', better: 'up' },
      { key: 'calls', label: 'Call clicks', format: 'num', better: 'up' },
      { key: 'websiteClicks', label: 'Website clicks', format: 'num', better: 'up' },
      { key: 'directions', label: 'Direction requests', format: 'num', better: 'up' },
      { key: 'conversations', label: 'Messages', format: 'num', better: 'up', hidden: true },
      { key: 'bookings', label: 'Bookings', format: 'num', better: 'up', hidden: true },
      { key: 'actionRate', label: 'Actions / view', format: 'pct', better: 'up', hidden: true, derive: r => r.impressions ? r.actions / r.impressions : 0 }
    ],
    trend: ['impressions', 'actions', 'calls', 'websiteClicks', 'directions']
  },
  callrail: {
    name: 'CallRail', full: 'CallRail', select: 'callrailAccountId', pick: 'a CallRail account',
    kpis: [
      { key: 'calls', label: 'Calls', format: 'num', better: 'up' },
      { key: 'firstTime', label: 'First-time callers', format: 'num', better: 'up' },
      { key: 'answerRate', label: 'Answer rate', format: 'pct', better: 'up' },
      { key: 'missed', label: 'Missed calls', format: 'num', better: 'down' },
      { key: 'averageDuration', label: 'Average duration', format: 'seconds', better: 'up' }
    ],
    trend: ['calls', 'firstTime', 'missed'],
    breakdowns: [['source', 'Source'], ['campaign', 'Campaign'], ['keywords', 'Keyword'], ['referrer', 'Referrer'], ['landing_page', 'Landing page'], ['company', 'Company']],
    filters: [
      { key: 'direction', label: 'Direction', type: 'select', choices: () => [['', 'All calls'], ['inbound', 'Inbound'], ['outbound', 'Outbound']] },
      { key: 'device', label: 'Caller device', type: 'select', choices: () => [['', 'All devices'], ['desktop', 'Desktop'], ['mobile', 'Mobile']] },
      { key: 'leadStatus', label: 'Lead status', type: 'select', choices: () => [['', 'Any status'], ['good_lead', 'Good lead'], ['not_a_lead', 'Not a lead'], ['not_scored', 'Not scored']] }
    ]
  }
};
const GA4_CHANNELS = ['Direct', 'Organic Search', 'Paid Search', 'Organic Social', 'Paid Social', 'Email', 'Referral', 'Affiliates', 'Display', 'Organic Video', 'Paid Video', 'Organic Shopping', 'Paid Shopping', 'Cross-network', 'Paid Other', 'SMS', 'Mobile Push Notifications', 'Audio', 'Unassigned'];
const MATCHES = [['contains', 'contains'], ['notContains', 'does not contain'], ['equals', 'is exactly'], ['includingRegex', 'matches regex'], ['excludingRegex', 'excludes regex']];
const LABEL = { sessions: 'Sessions', activeUsers: 'Active users', newUsers: 'New users', keyEvents: 'Key events', totalRevenue: 'Revenue', screenPageViews: 'Views', clicks: 'Clicks', impressions: 'Impressions', ctr: 'CTR', position: 'Avg. position',
  cost: 'Spend', conversions: 'Conversions', conversionValue: 'Conv. value', actions: 'Actions', calls: 'Calls', websiteClicks: 'Website clicks', directions: 'Directions', firstTime: 'First-time', missed: 'Missed' };

/* ---------------- State ---------------- */

const OPTIONS_KEY = 'marketer-companion.options.v1';
const TILES_KEY = 'marketer-companion.tiles.v1';
const state = {
  view: 'overview', snapshot: null, accounts: null, available: Object.keys(SOURCES),
  selection: loadSelection(), preset: 28, compare: true, busy: false, connected: false, trendMetric: {},
  // Per-source breakdown, row limit and filters, sent to the server with every load.
  options: readStore(OPTIONS_KEY), tiles: readStore(TILES_KEY), customizing: false, loadingSource: null, filtersOpen: {}
};
function readStore(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable in this host */ } }
function loadSelection() { return readStore(STORE_KEY); }
function saveSelection() { writeStore(STORE_KEY, state.selection); }

// Options without empty values, so a cleared filter is dropped rather than sent as "".
function cleanOptions(key) {
  return Object.fromEntries(Object.entries(state.options[key] || {}).filter(([, value]) => value !== '' && value !== undefined && value !== null));
}
const FILTER_ONLY = ['breakdown', 'limit', 'queryMatch', 'pageMatch'];
const activeFilters = key => Object.keys(cleanOptions(key)).filter(name => !FILTER_ONLY.includes(name) && !(key === 'search_console' && name === 'searchType' && state.options[key][name] === 'web'));
const visibleKpis = key => SOURCES[key].kpis.filter(kpi => state.tiles[key] ? state.tiles[key].includes(kpi.key) : !kpi.hidden);

const formatter = (source, format) => format === 'money' ? moneyFormatter(currencyOf(source)) : fmt[format] || fmt.num;
function currencyOf(source) {
  return source?.currency || source?.totals?.data?.rows?.[0]?.currency || undefined;
}
const rowsOf = report => report?.status === 'ready' ? report.data.rows || [] : null;
const valueOf = (kpi, row) => row ? (kpi.derive ? kpi.derive(row) : Number(row[kpi.key]) || 0) : null;

function change(kpi, current, previous) {
  if (previous === null || previous === undefined) return null;
  if (!previous) return current ? { text: 'New', tone: 'neutral', ratio: null } : { text: 'No change', tone: 'neutral', ratio: 0 };
  const ratio = (current - previous) / Math.abs(previous);
  const sign = ratio > 0 ? '+' : '';
  const tone = Math.abs(ratio) < 0.005 || kpi.better === 'neutral' ? 'neutral' : (ratio > 0) === (kpi.better === 'up') ? 'good' : 'bad';
  return { text: `${sign}${(ratio * 100).toFixed(Math.abs(ratio) < 0.1 ? 1 : 0)}%`, tone, ratio };
}

/* ---------------- Account setup sheet ---------------- */

function status(text, tone = 'info') {
  const node = $('status');
  node.textContent = text;
  node.dataset.tone = tone;
  node.hidden = !text;
}

async function loadAccounts() {
  if (!state.connected) return;
  $('sheet-body').classList.add('loading');
  try {
    const result = await host.callServerTool('list_dashboard_accounts');
    if (result.isError) throw new Error(result.structuredContent?.error || 'Accounts could not be listed.');
    state.accounts = result.structuredContent;
    renderSheet();
  } catch (error) { status(error.message, 'error'); } finally { $('sheet-body').classList.remove('loading'); }
}

function renderSheet() {
  const body = $('sheet-body');
  body.replaceChildren();
  for (const key of state.available) {
    const config = SOURCES[key];
    const list = state.accounts?.[key];
    const field = el('div', undefined, 'field');
    const head = el('div', undefined, 'field-head');
    const title = el('label', undefined, 'field-label'); title.htmlFor = `pick-${key}`;
    title.append(icon(key, 'logo sm'), document.createTextNode(config.full));
    head.append(title);
    if (list?.status === 'ready') head.append(el('span', `${list.data.length} available`, 'field-count'));
    field.append(head);
    if (list?.status === 'error') {
      field.append(el('p', list.message, 'field-error'));
    } else {
      const items = list?.data || [];
      if (items.length > 8) {
        const search = el('input'); search.type = 'search'; search.placeholder = `Filter ${items.length} accounts`; search.className = 'field-filter';
        search.setAttribute('aria-label', `Filter ${config.full} accounts`);
        search.addEventListener('input', () => fill(select, items, state.selection[config.select], search.value));
        field.append(search);
      }
      const select = el('select'); select.id = `pick-${key}`; select.dataset.param = config.select;
      fill(select, items, state.selection[config.select], '', !list);
      field.append(select);
    }
    if (key === 'google_ads') {
      const mcc = el('input'); mcc.id = 'loginCustomerId'; mcc.placeholder = 'Manager (MCC) ID, if the account sits under one'; mcc.inputMode = 'numeric'; mcc.className = 'field-filter';
      mcc.value = state.selection.loginCustomerId || '';
      mcc.setAttribute('aria-label', 'Google Ads manager account ID');
      field.append(mcc);
    }
    body.append(field);
  }
}

function fill(select, items, selected, filter = '', loading = false) {
  const query = filter.trim().toLowerCase();
  select.replaceChildren(new Option(loading ? 'Loading…' : 'Not included', ''));
  for (const item of items) {
    if (query && !`${item.name} ${item.account || ''} ${item.id}`.toLowerCase().includes(query) && item.id !== selected) continue;
    select.add(new Option(item.account ? `${item.name} — ${item.account}` : item.name, item.id));
  }
  if (selected && ![...select.options].some(option => option.value === selected)) select.add(new Option(selected, selected));
  select.value = selected || '';
}

function openSheet() {
  const sheet = $('sheet');
  sheet.hidden = false;
  $('scrim').hidden = false;
  slideIn(sheet.querySelector('.sheet-panel'));
  fadeIn($('scrim'), { duration: 200 });
  if (!state.accounts) loadAccounts();
  setTimeout(() => sheet.querySelector('select, button')?.focus(), 60);
}
async function closeSheet() {
  if ($('sheet').hidden) return;
  await slideOut($('sheet').querySelector('.sheet-panel'));
  $('sheet').hidden = true;
  $('scrim').hidden = true;
}
function applySheet() {
  for (const select of document.querySelectorAll('#sheet-body select')) state.selection[select.dataset.param] = select.value || undefined;
  const mcc = $('loginCustomerId');
  if (mcc) state.selection.loginCustomerId = mcc.value.replace(/\D/g, '') || undefined;
  saveSelection();
  closeSheet();
  load();
}

/* ---------------- Loading ---------------- */

function range() {
  if (state.preset === 'custom') return { startDate: $('startDate').value, endDate: $('endDate').value };
  const end = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  return { startDate: addDays(end, -(state.preset - 1)), endDate: end };
}

function optionsArg(keys) {
  const options = {};
  for (const key of keys) { const o = cleanOptions(key); if (Object.keys(o).length) options[key] = o; }
  return Object.keys(options).length ? options : undefined;
}

// Reloads one source with its current options, keeping the rest of the dashboard as is.
async function loadSource(key) {
  const snap = state.snapshot;
  const config = SOURCES[key];
  if (!snap || !state.selection[config.select] || state.busy) return;
  const args = { startDate: snap.range.startDate, endDate: snap.range.endDate, compare: snap.selection.compare !== false, [config.select]: state.selection[config.select] };
  if (key === 'google_ads' && state.selection.loginCustomerId) args.loginCustomerId = state.selection.loginCustomerId;
  const options = optionsArg([key]);
  if (options) args.options = options;
  state.loadingSource = key;
  setBusy(true);
  status('');
  try {
    const result = await host.callServerTool('get_marketing_dashboard', args);
    if (result.isError) throw new Error(result.structuredContent?.error || 'This source could not be loaded.');
    const data = result.structuredContent;
    if (!data?.sources?.[key]) throw new Error('The source returned no data.');
    snap.sources[key] = data.sources[key];
    snap.selection = { ...snap.selection, options: { ...(snap.selection.options || {}), [key]: options?.[key] } };
    render();
    renderNav();
  } catch (error) {
    status(`${error.message} The previous ${config.name} view is unchanged.`, 'error');
  } finally { state.loadingSource = null; setBusy(false); }
}

function setOptions(key, patch, { reload = true } = {}) {
  state.options[key] = { ...(state.options[key] || {}), ...patch };
  writeStore(OPTIONS_KEY, state.options);
  if (reload) loadSource(key);
}

async function load() {
  const args = { ...range(), compare: state.compare };
  for (const [key, value] of Object.entries(state.selection)) if (value) args[key] = value;
  const options = optionsArg(state.available.filter(key => args[SOURCES[key].select]));
  if (options) args.options = options;
  const picked = state.available.some(key => args[SOURCES[key].select]);
  if (!picked) { status('Choose at least one account to build your dashboard.', 'info'); openSheet(); return; }
  if (!args.startDate || !args.endDate || args.startDate > args.endDate) { status('Choose a valid date range.', 'error'); return; }
  setBusy(true);
  status('');
  try {
    const result = await host.callServerTool('get_marketing_dashboard', args);
    if (result.isError) throw new Error(result.structuredContent?.error || 'The dashboard could not be loaded.');
    accept(result.structuredContent);
  } catch (error) {
    status(`${error.message} The last loaded view is unchanged.`, 'error');
  } finally { setBusy(false); }
}

function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle('busy', value);
  $('refresh').disabled = value || !state.connected;
  $('refresh').classList.toggle('spinning', value);
  if (value && !state.snapshot) renderSkeleton();
}

function accept(data) {
  if (!data?.sources) return;
  state.snapshot = data;
  if (data.available) state.available = data.available.filter(key => SOURCES[key]);
  if (state.view !== 'overview' && !data.sources[state.view]) state.view = 'overview';
  renderNav();
  render();
}

/* ---------------- Series helpers ---------------- */

function series(source, key) {
  const { range: r } = state.snapshot;
  const dates = Array.from({ length: r.days }, (_, i) => addDays(r.startDate, i));
  const index = rows => {
    const map = new Map();
    for (const row of rows || []) map.set(row.date, row);
    return map;
  };
  const value = row => {
    if (!row) return null;
    if (key === 'ctr' && row.ctr === undefined) return row.impressions ? row.clicks / row.impressions : 0;
    return Number(row[key]) || 0;
  };
  const current = index(rowsOf(source.daily));
  const previousRows = rowsOf(source.dailyPrevious);
  const previous = previousRows ? index(previousRows) : null;
  return {
    dates,
    current: dates.map(d => value(current.get(d))),
    previous: previous ? dates.map((_, i) => value(previous.get(addDays(r.previousStartDate, i)))) : null
  };
}

/* ---------------- Insights ---------------- */

// Turns loaded reports into short, evidence-backed signals. Every line names its source and figures.
function insights() {
  const out = [];
  const sources = state.snapshot?.sources || {};
  const push = (tone, source, title, detail) => out.push({ tone, source, title, detail });
  for (const [key, source] of Object.entries(sources)) {
    const config = SOURCES[key];
    if (!config) continue;
    if (source.status === 'error') { push('serious', key, `${config.full} did not load`, source.message); continue; }
    const now = rowsOf(source.totals)?.[0], before = rowsOf(source.comparison)?.[0];
    if (now && before) {
      for (const kpi of config.kpis.slice(0, 4)) {
        const c = change(kpi, valueOf(kpi, now), valueOf(kpi, before));
        if (!c || c.ratio === null || Math.abs(c.ratio) < 0.15 || c.tone === 'neutral') continue;
        // Small counts swing wildly; a change needs volume behind it to be a signal.
        const base = kpi.format === 'num' ? Math.max(valueOf(kpi, now), valueOf(kpi, before)) : Infinity;
        if (base < 30) continue;
        if (kpi.derive && key === 'merchant_center' && Math.max(now.clicks, before.clicks) < 30) continue;
        const f = formatter(source, kpi.format);
        push(c.tone === 'good' ? 'good' : 'warning', key, `${kpi.label} ${c.ratio > 0 ? 'up' : 'down'} ${c.text.replace(/^[+-]/, '')}`, `${config.name}: ${f(valueOf(kpi, before))} → ${f(valueOf(kpi, now))} vs the previous period.`);
      }
    }
    if (key === 'merchant_center' && source.health?.status === 'ready') {
      const blocked = source.health.data.issues.filter(issue => issue.severity === 'DISAPPROVED');
      if (blocked.length) push('critical', key, `${fmt.num(blocked[0].products)} products disapproved`, `Top issue: ${blocked[0].label}. ${blocked.length > 1 ? `${blocked.length - 1} more disapproval reasons.` : ''}`.trim());
    }
    if (key === 'gbp' && source.reviews?.status === 'ready') {
      const reviews = source.reviews.data;
      if (reviews.unanswered) push('warning', key, `${reviews.unanswered} reviews without a reply`, `Out of the latest ${reviews.sampleSize}. Replies build trust and local ranking.`);
      if (reviews.averageRating && reviews.averageRating < 4) push('warning', key, `Rating is ${reviews.averageRating.toFixed(1)} stars`, `Across ${fmt.num(reviews.totalReviewCount)} reviews.`);
    }
    if (key === 'callrail' && now?.calls) {
      if (now.answerRate < 0.85) push('warning', key, `${fmt.pct0(1 - now.answerRate)} of calls missed`, `${fmt.num(now.missed)} of ${fmt.num(now.calls)} calls went unanswered.`);
    }
    if (key === 'google_ads' && now && before && now.cost > before.cost * 1.1 && now.conversions < before.conversions) {
      push('warning', key, 'Spend up, conversions down', `Spend rose ${change({ better: 'neutral' }, now.cost, before.cost).text} while conversions fell ${change({ better: 'up' }, now.conversions, before.conversions).text}.`);
    }
    if (key === 'ga4' && (source.totals?.data?.metadata?.subjectToThresholding || source.totals?.data?.metadata?.dataLossFromOtherRow)) {
      push('warning', key, 'GA4 applied thresholds', 'Some rows are withheld or grouped as (other). Small figures may be understated.');
    }
  }
  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]).slice(0, 6);
}

/* ---------------- Rendering ---------------- */

function renderNav() {
  const nav = $('nav');
  nav.replaceChildren();
  const sources = state.snapshot?.sources || {};
  const item = (key, label, full) => {
    const button = el('button', undefined, 'nav-item');
    button.type = 'button';
    button.dataset.view = key;
    button.title = full === label ? label : `${label} · ${full}`;
    // On narrow screens the tab shows only its logo, so the name must live on the button.
    button.setAttribute('aria-label', full === label ? label : `${label}, ${full}`);
    button.setAttribute('aria-current', String(state.view === key));
    const text = el('span', undefined, 'nav-text');
    text.append(el('span', label, 'nav-label'));
    if (full !== label) text.append(el('span', full, 'nav-sub'));
    button.append(icon(key, key === 'overview' ? 'logo mono' : 'logo'), text);
    if (key !== 'overview') {
      const filtered = activeFilters(key).length;
      if (filtered) button.append(el('span', String(filtered), 'nav-badge'));
      const dot = el('span', undefined, `nav-dot ${sources[key] ? sources[key].status : 'idle'}`);
      dot.title = sources[key] ? (sources[key].status === 'ready' ? 'Loaded' : 'Error') : 'Not selected';
      button.append(dot);
    }
    button.onclick = () => { if (state.view === key) return; state.view = key; state.customizing = false; renderNav(); render(); window.scrollTo?.({ top: 0 }); };
    nav.append(button);
  };
  item('overview', 'Overview', 'All channels');
  for (const key of state.available) item(key, SOURCES[key].name, SOURCES[key].full);
  fitHeader();
}

function header(title, subtitle) {
  const head = el('div', undefined, 'view-head');
  const text = el('div');
  text.append(el('h2', title, 'view-title'));
  if (subtitle) text.append(el('p', subtitle, 'view-sub'));
  head.append(text);
  return head;
}

function render() {
  stopAll();
  resetBalancers();
  const view = $('view');
  view.replaceChildren();
  view.classList.remove('skeleton-view');
  const snap = state.snapshot;
  if (!snap) return renderWelcome();
  $('period').textContent = `${dateLabel(snap.range.startDate)} – ${dateLabel(snap.range.endDate, true)}${snap.selection.compare !== false ? `  ·  vs ${dateLabel(snap.range.previousStartDate)} – ${dateLabel(snap.range.previousEndDate)}` : ''}`;
  if (state.view === 'overview') renderOverview(view);
  else renderSource(view, state.view);
  $('footer').replaceChildren(el('div', `Live data · loaded ${new Date(snap.fetchedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}`));
  for (const note of snap.notes || []) $('footer').append(el('div', note));
  // The range also sits under the title, for the one-row header where the bar has no room for it.
  view.querySelector('.view-head > div')?.append(el('p', $('period').textContent, 'view-period'));
  fitHeader();
  for (const grid of view.querySelectorAll('.tiles')) balance(grid, 150);
  for (const grid of view.querySelectorAll('.source-grid')) balance(grid, 290, 14);
  reveal(view.querySelectorAll('.reveal'));
  for (const node of view.querySelectorAll('[data-count]')) countUp(node, Number(node.dataset.count), node.formatFn, { delay: 120 });
  for (const node of view.querySelectorAll('.trend')) node.mount();
  for (const node of view.querySelectorAll('.spark')) node.drawIn?.();
  for (const node of view.querySelectorAll('.table-scroll, .share, .gauge')) node.animateIn?.();
}

function renderWelcome() {
  const view = $('view');
  const hero = el('section', undefined, 'welcome reveal');
  hero.append(el('div', 'Marketer Companion', 'eyebrow'), el('h2', 'Every channel, one living picture.'),
    el('p', 'Connect the accounts for one business: website, search, ads, products, local profile and calls. The overview finds what changed and what needs attention.'));
  const steps = el('ol', undefined, 'welcome-steps');
  for (const [title, text] of [['Pick your accounts', 'Choose a property, site or account per source. Skip any you do not use.'], ['Set the period', 'Last 7, 28 or 90 days, or a custom range, with the previous period for comparison.'], ['Read the signals', 'Biggest movers and issues surface first. Ask ChatGPT to dig into any view.']]) {
    const li = el('li'); li.append(el('strong', title), el('span', text)); steps.append(li);
  }
  const cta = el('button', 'Choose accounts', 'primary'); cta.type = 'button'; cta.onclick = openSheet;
  hero.append(steps, cta);
  view.append(hero);
  reveal(view.querySelectorAll('.reveal, .welcome-steps li'));
}

function renderSkeleton() {
  const view = $('view');
  view.replaceChildren();
  view.classList.add('skeleton-view');
  const tiles = el('div', undefined, 'tiles');
  for (let i = 0; i < 4; i++) tiles.append(el('div', undefined, 'tile skeleton'));
  view.append(el('div', undefined, 'skeleton line-lg'), tiles, el('div', undefined, 'panel skeleton tall'));
}

function statTile(source, kpi, now, before, spark, onClick) {
  const tile = el(onClick ? 'button' : 'div', undefined, 'tile reveal');
  if (onClick) { tile.type = 'button'; tile.onclick = onClick; }
  const f = formatter(source, kpi.format);
  tile.append(el('div', kpi.label, 'tile-label'));
  const value = el('div', undefined, 'tile-value');
  const current = valueOf(kpi, now);
  if (current === null) value.textContent = '—';
  else { value.dataset.count = String(current); value.formatFn = f; value.textContent = f(current); }
  tile.append(value);
  const foot = el('div', undefined, 'tile-foot');
  const c = before ? change(kpi, current, valueOf(kpi, before)) : null;
  if (c) {
    const chip = el('span', undefined, `delta ${c.tone}`);
    chip.append(el('span', c.ratio > 0 ? '↑' : c.ratio < 0 ? '↓' : '→', 'arrow'), document.createTextNode(c.text));
    chip.title = `Previous period: ${f(valueOf(kpi, before))}`;
    foot.append(chip, el('span', `from ${f(valueOf(kpi, before))}`, 'tile-prev'));
  } else foot.append(el('span', state.snapshot.selection.compare === false ? 'Comparison off' : 'No comparison', 'tile-prev'));
  tile.append(foot);
  if (spark) tile.append(spark);
  return tile;
}

function renderOverview(view) {
  const snap = state.snapshot;
  view.append(header('Overview', 'What moved across your channels, and what needs attention.'));
  const loaded = Object.entries(snap.sources).filter(([key]) => SOURCES[key]);
  if (!loaded.length) { view.append(el('div', 'No sources selected. Choose accounts to begin.', 'empty-card reveal')); return; }

  const list = insights();
  if (list.length) {
    const panel = el('section', undefined, 'panel signals reveal');
    panel.append(el('h3', 'Signals'));
    const ul = el('ul', undefined, 'signal-list');
    for (const signal of list) {
      const li = el('li', undefined, `signal ${signal.tone} reveal`);
      li.append(el('span', { critical: '!', serious: '!', warning: '▲', good: '✓' }[signal.tone], 'signal-icon'));
      const text = el('div');
      text.append(el('strong', signal.title), el('span', signal.detail, 'signal-detail'));
      const tag = el('button', SOURCES[signal.source].name, 'signal-source'); tag.type = 'button';
      tag.onclick = () => { state.view = signal.source; renderNav(); render(); };
      li.append(text, tag);
      ul.append(li);
    }
    panel.append(ul);
    view.append(panel);
  }

  const grid = el('div', undefined, 'source-grid');
  for (const [key, source] of loaded) {
    const config = SOURCES[key];
    const card = el('section', undefined, `source-card reveal ${source.status}`);
    const head = el('button', undefined, 'source-card-head'); head.type = 'button';
    head.append(icon(key), el('span', config.full, 'source-card-name'));
    if (activeFilters(key).length) head.append(el('span', 'Filtered', 'filtered-tag'));
    head.append(el('span', 'Open →', 'source-card-link'));
    head.onclick = () => { state.view = key; renderNav(); render(); };
    card.append(head);
    if (source.status === 'error') { card.append(el('p', source.message, 'field-error')); grid.append(card); continue; }
    const now = rowsOf(source.totals)?.[0], before = rowsOf(source.comparison)?.[0];
    const primary = config.kpis[0];
    const s = series(source, primary.key);
    card.append(statTile(source, primary, now, before, sparkline(s.current)));
    const mini = el('div', undefined, 'mini-stats');
    for (const kpi of config.kpis.slice(1, 3)) {
      const f = formatter(source, kpi.format);
      const value = valueOf(kpi, now);
      const c = before ? change(kpi, value, valueOf(kpi, before)) : null;
      const stat = el('div', undefined, 'mini');
      stat.append(el('span', kpi.label, 'mini-label'), el('strong', value === null ? '—' : f(value)));
      if (c) stat.append(el('span', c.text, `mini-delta ${c.tone}`));
      mini.append(stat);
    }
    card.append(mini);
    grid.append(card);
  }
  view.append(grid);
}

function panel(title, content, { wide = false, note } = {}) {
  const node = el('section', undefined, `panel reveal${wide ? ' wide' : ''}`);
  node.append(el('h3', title));
  node.append(content);
  if (note) node.append(el('p', note, 'panel-note'));
  return node;
}
const failed = report => el('div', report?.message || 'This report is unavailable.', 'inline-error');
function tableFrom(report, columns, note) {
  const rows = rowsOf(report);
  if (!rows) return failed(report);
  const wrap = el('div');
  wrap.append(rankedTable(rows, columns));
  if (report.data.limited || note) wrap.append(el('p', note || 'Top ten only, not a full total.', 'panel-note'));
  return wrap;
}

function renderSource(view, key) {
  const config = SOURCES[key];
  const source = state.snapshot.sources[key];
  if (!source) {
    view.append(header(config.full));
    const empty = el('div', undefined, 'empty-card reveal');
    empty.append(icon(key, 'logo lg'), el('p', `Add ${config.pick} to see this view.`));
    const pick = el('button', 'Choose accounts', 'primary'); pick.type = 'button'; pick.onclick = openSheet; empty.append(pick);
    view.append(empty);
    return;
  }
  const accountName = state.accounts?.[key]?.data?.find(item => item.id === source.account)?.name || source.account;
  const head = header(config.full, `${accountName}${source.timeZone ? ` · ${source.timeZone}` : ''}${currencyOf(source) ? ` · ${currencyOf(source)}` : ''}`);
  head.querySelector('.view-title').prepend(icon(key, 'logo title-logo'));
  const customize = el('button', state.customizing ? 'Done' : 'Customize', 'btn'); customize.type = 'button';
  customize.setAttribute('aria-expanded', String(state.customizing));
  customize.onclick = () => { state.customizing = !state.customizing; render(); };
  head.append(customize);
  view.append(head);
  if (config.filters) view.append(filterBar(key, source));
  if (source.status === 'error') { view.append(el('div', source.message, 'inline-error reveal')); return; }

  const now = rowsOf(source.totals)?.[0], before = rowsOf(source.comparison)?.[0];
  if (state.customizing) view.append(customizer(key));
  if (!now) view.append(failed(source.totals));
  else {
    const tiles = el('div', undefined, 'tiles');
    const kpis = visibleKpis(key);
    for (const kpi of kpis) {
      const label = kpi.key === 'keyEvents' && source.options?.keyEvent ? { ...kpi, label: `Key events: ${source.options.keyEvent}` } : kpi;
      tiles.append(statTile(source, label, now, before));
    }
    if (!kpis.length) tiles.append(el('p', 'No metrics selected. Use Customize to pick some.', 'empty-note'));
    view.append(tiles);
  }

  // Trend with a metric switcher; the previous period is drawn as a muted dashed line.
  const trendKey = state.trendMetric[key] && config.trend.includes(state.trendMetric[key]) ? state.trendMetric[key] : config.trend[0];
  const trendPanel = el('section', undefined, 'panel wide reveal');
  const trendHead = el('div', undefined, 'panel-head');
  trendHead.append(el('h3', 'Trend'));
  const switcher = el('div', undefined, 'segmented');
  switcher.setAttribute('role', 'radiogroup'); switcher.setAttribute('aria-label', 'Metric to chart');
  for (const metric of config.trend) {
    const chip = el('button', LABEL[metric] || metric); chip.type = 'button';
    chip.setAttribute('role', 'radio'); chip.setAttribute('aria-checked', String(metric === trendKey));
    chip.onclick = () => { state.trendMetric[key] = metric; render(); };
    switcher.append(chip);
  }
  trendHead.append(switcher);
  trendPanel.append(trendHead);
  if (!rowsOf(source.daily)) trendPanel.append(failed(source.daily));
  else {
    const s = series(source, trendKey);
    const format = ['totalRevenue', 'cost', 'conversionValue'].includes(trendKey) ? moneyFormatter(currencyOf(source)) : trendKey === 'ctr' ? fmt.pct : trendKey === 'position' ? fmt.dec : fmt.num;
    trendPanel.append(trendChart({ ...s, label: LABEL[trendKey] || trendKey, format, dateFormat: dateLabel, previousLabel: 'Previous period' }));
    const legend = el('div', undefined, 'legend');
    legend.append(legendItem('current', `${LABEL[trendKey]} · this period`));
    if (s.previous) legend.append(legendItem('previous', 'Previous period'));
    trendPanel.append(legend);
    if (trendKey === 'position') trendPanel.append(el('p', 'Lower is better for average position.', 'panel-note'));
  }
  view.append(trendPanel);

  const grid = el('div', undefined, 'panels');
  const money = moneyFormatter(currencyOf(source));
  grid.append(breakdownPanel(key, source));
  const gscColumns = label => [{ key: 'label', label, format: label === 'Page' ? shortUrl : undefined }, { key: 'clicks', label: 'Clicks', format: fmt.num, bar: true }, { key: 'impressions', label: 'Impr.', format: fmt.num }, { key: 'ctr', label: 'CTR', format: fmt.pct }, { key: 'position', label: 'Pos.', format: fmt.dec }];
  if (key === 'ga4') {
    grid.append(panel('Devices', rowsOf(source.devices) ? shareBar(rowsOf(source.devices).map(row => ({ label: row.deviceCategory, value: row.sessions })), fmt.num) : failed(source.devices), { note: 'Share of sessions.' }));
    if (source.pages) grid.append(panel('Top landing pages', tableFrom(source.pages, [{ key: 'landingPagePlusQueryString', label: 'Page', format: shortUrl }, { key: 'sessions', label: 'Sessions', format: fmt.num, bar: true }, { key: 'activeUsers', label: 'Users', format: fmt.num }, { key: 'keyEvents', label: keyLabel(source), format: fmt.num }, { key: 'engagementRate', label: 'Engaged', format: fmt.pct0 }])));
  }
  if (key === 'search_console') {
    grid.append(panel('Devices', rowsOf(source.devices) ? shareBar(rowsOf(source.devices).map(row => ({ label: row.label.charAt(0) + row.label.slice(1).toLowerCase(), value: row.clicks })), fmt.num) : failed(source.devices), { note: 'Share of clicks.' }));
    if (source.pages) grid.append(panel('Top pages', tableFrom(source.pages, gscColumns('Page'))));
    if (source.queries) grid.append(panel('Top queries', tableFrom(source.queries, gscColumns('Query'))));
  }
  if (key === 'merchant_center') {
    const health = source.health;
    if (health?.status === 'ready') {
      const contexts = health.data.contexts;
      const box = el('div', undefined, 'health');
      for (const context of contexts) {
        const total = context.active + context.pending + context.disapproved;
        const row = el('div', undefined, 'health-row');
        row.append(el('span', context.context.replaceAll('_', ' ').toLowerCase(), 'health-name'));
        row.append(shareBar([{ label: 'Approved', value: context.active, tone: 'tone-good' }, { label: 'Pending', value: context.pending, tone: 'tone-warning' }, { label: 'Disapproved', value: context.disapproved, tone: 'tone-critical' }].filter(part => part.value), fmt.num));
        row.dataset.total = total;
        box.append(row);
      }
      if (!contexts.length) box.append(el('p', 'No product status reported.', 'empty-note'));
      grid.append(panel('Product status by destination', box));
      const issues = el('ul', undefined, 'issue-list');
      for (const issue of health.data.issues) {
        const li = el('li', undefined, `issue ${issue.severity === 'DISAPPROVED' ? 'critical' : issue.severity === 'DEMOTED' ? 'warning' : 'info'}`);
        li.append(el('span', issue.severity === 'DISAPPROVED' ? 'Disapproved' : issue.severity === 'DEMOTED' ? 'Limited' : 'Notice', 'issue-tag'));
        const text = el('div'); text.append(el('strong', issue.label), el('span', issue.detail, 'issue-detail'));
        li.append(text, el('span', `${fmt.num(issue.products)} products`, 'issue-count'));
        issues.append(li);
      }
      grid.append(panel('Issues to fix', health.data.issues.length ? issues : el('p', 'No item issues reported.', 'empty-note')));
    } else grid.append(panel('Product status', failed(health)));
    grid.append(panel('Free listings vs Shopping ads', rowsOf(source.methods) ? shareBar(rowsOf(source.methods).map(row => ({ label: row.label, value: row.clicks, slot: row.label === 'Free listings' ? 0 : 1 })), fmt.num) : failed(source.methods), { note: 'Share of product clicks.' }));
  }
  if (key === 'gbp') {
    const reviews = source.reviews;
    if (reviews?.status === 'ready') {
      const r = reviews.data;
      const box = el('div', undefined, 'reviews');
      const score = el('div', undefined, 'review-score');
      score.append(el('strong', r.averageRating ? r.averageRating.toFixed(1) : '—'), el('span', '★'.repeat(Math.round(r.averageRating || 0)).padEnd(5, '☆'), 'stars'), el('span', `${fmt.num(r.totalReviewCount || 0)} reviews · ${r.unanswered} unanswered of latest ${r.sampleSize}`, 'review-meta'));
      box.append(score);
      const dist = r.distribution.map(d => ({ label: `${d.stars} ★`, count: d.count }));
      box.append(rankedTable(dist, [{ key: 'label', label: 'Rating' }, { key: 'count', label: 'Reviews', format: fmt.num, bar: true }]));
      grid.append(panel('Reviews', box, { note: 'Distribution covers the latest reviews loaded.' }));
      const latest = el('ul', undefined, 'review-list');
      for (const review of r.latest) {
        const li = el('li');
        li.append(el('div', `${'★'.repeat(review.stars || 0)}${'☆'.repeat(5 - (review.stars || 0))}`, 'stars'));
        li.append(el('p', review.comment || 'No written comment.', review.comment ? 'review-text' : 'review-text muted'));
        li.append(el('span', `${review.reviewer} · ${review.time ? dateLabel(review.time.slice(0, 10)) : ''}${review.replied ? ' · replied' : ' · awaiting reply'}`, 'review-meta'));
        latest.append(li);
      }
      grid.append(panel('Latest reviews', r.latest.length ? latest : el('p', 'No reviews yet.', 'empty-note')));
    } else grid.append(panel('Reviews', failed(reviews)));
    const totals = now || {};
    grid.append(panel('Where customers found you', shareBar([{ label: 'Search · mobile', value: totals.searchMobile || 0, slot: 0 }, { label: 'Search · desktop', value: totals.searchDesktop || 0, slot: 1 }, { label: 'Maps · mobile', value: totals.mapsMobile || 0, slot: 2 }, { label: 'Maps · desktop', value: totals.mapsDesktop || 0, slot: 3 }].filter(part => part.value), fmt.num), { note: 'Share of profile views by Google surface and device.' }));
    grid.append(panel('What customers did', shareBar([{ label: 'Calls', value: totals.calls || 0, slot: 0 }, { label: 'Website', value: totals.websiteClicks || 0, slot: 1 }, { label: 'Directions', value: totals.directions || 0, slot: 2 }, { label: 'Messages', value: totals.conversations || 0, slot: 3 }, { label: 'Bookings', value: totals.bookings || 0, slot: 4 }].filter(part => part.value), fmt.num)));
    const keywords = rowsOf(source.keywords);
    grid.append(panel('Search keywords', keywords ? rankedTable(keywords, [{ key: 'label', label: 'Keyword' }, { key: 'impressions', label: 'Impressions', format: (v, row) => row.threshold ? `< ${v}` : fmt.num(v), bar: true }]) : failed(source.keywords), { wide: true, note: keywords ? `Monthly data, ${monthSpan(state.snapshot.range)}. Counts below 15 are shown as a threshold.` : undefined }));
  }
  if (key === 'callrail') {
    const rate = now?.answerRate || 0;
    const answered = el('div', undefined, 'answer');
    const g = gauge(rate, 'Answer rate');
    const caption = el('div', undefined, 'answer-caption');
    caption.append(el('strong', fmt.pct0(rate)), el('span', `${fmt.num(now?.answered || 0)} answered · ${fmt.num(now?.missed || 0)} missed`));
    answered.append(g, caption);
    grid.append(panel('Answer rate', answered));
    if (source.options?.breakdown !== 'source') grid.append(panel('Calls by source', rowsOf(source.sources) ? shareBar(rowsOf(source.sources).slice(0, 6).map((row, i) => ({ label: row.label, value: row.calls, slot: i })), fmt.num) : failed(source.sources), { note: 'Top sources by calls.' }));
  }
  closeGaps(grid);
  view.append(grid);
}

/* ---------------- Filters, breakdowns and customisation ---------------- */

const keyLabel = source => source?.options?.keyEvent ? `Key events: ${source.options.keyEvent}` : 'Key events';
const choiceLabel = (filter, source, value) => (filter.choices?.(source) || []).find(([v]) => v === value)?.[1] || value;

function filterBar(key, source) {
  const config = SOURCES[key];
  const current = state.options[key] || {};
  const box = el('section', undefined, 'panel filter-panel reveal');
  const top = el('div', undefined, 'panel-head');
  top.append(el('h3', 'Filters'));
  const chips = el('div', undefined, 'chips');
  for (const name of activeFilters(key)) {
    const filter = config.filters.find(f => f.key === name);
    if (!filter) continue;
    const value = current[name];
    const match = filter.match && current[filter.match] && current[filter.match] !== 'contains' ? ` ${MATCHES.find(([v]) => v === current[filter.match])?.[1] || ''}` : '';
    const chip = el('button', undefined, 'chip'); chip.type = 'button';
    chip.setAttribute('aria-label', `Remove filter ${filter.label}`);
    chip.append(el('span', `${filter.label}${match}: `, 'chip-key'), el('strong', filter.type === 'select' ? choiceLabel(filter, source, value) : value), el('span', '×', 'chip-x'));
    chip.onclick = () => setOptions(key, { [name]: '' });
    chips.append(chip);
  }
  if (!chips.children.length) chips.append(el('span', 'Showing all data', 'chips-empty'));
  const open = Boolean(state.filtersOpen[key]);
  const toggle = el('button', open ? 'Hide' : activeFilters(key).length ? 'Edit filters' : 'Add filters', 'btn'); toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.onclick = () => { state.filtersOpen[key] = !open; render(); };
  top.append(chips, toggle);
  box.append(top);
  if (!open) { box.classList.add('collapsed'); return box; }

  const form = el('form', undefined, 'filter-grid');
  form.noValidate = false;
  for (const filter of config.filters) {
    const field = el('label', undefined, 'filter-field');
    field.append(el('span', filter.label, 'filter-label'));
    const value = current[filter.key] || '';
    let control;
    if (filter.type === 'select') {
      control = el('select');
      for (const [v, text] of filter.choices(source)) control.add(new Option(text, v));
      if (value && ![...control.options].some(option => option.value === value)) control.add(new Option(value, value));
      control.value = value;
    } else {
      control = el('input');
      control.type = 'text';
      control.value = value;
      control.placeholder = filter.placeholder || '';
      control.maxLength = 120;
      control.autocomplete = 'off';
      if (filter.pattern) control.pattern = filter.pattern;
      if (filter.type === 'suggest') {
        const list = el('datalist'); list.id = `dl-${key}-${filter.key}`;
        for (const option of filter.suggest(source)) list.append(new Option(option));
        control.setAttribute('list', list.id);
        field.append(list);
      }
    }
    control.name = filter.key;
    if (filter.match) {
      const row = el('span', undefined, 'filter-match');
      const operator = el('select'); operator.name = filter.match; operator.setAttribute('aria-label', `${filter.label} match`);
      for (const [v, text] of MATCHES) operator.add(new Option(text, v));
      operator.value = current[filter.match] || 'contains';
      row.append(operator, control);
      field.append(row);
    } else field.append(control);
    form.append(field);
  }
  const actions = el('div', undefined, 'filter-actions');
  const apply = el('button', 'Apply filters', 'primary small'); apply.type = 'submit';
  const clear = el('button', 'Clear all', 'btn'); clear.type = 'button';
  clear.disabled = !activeFilters(key).length;
  clear.onclick = () => setOptions(key, Object.fromEntries(config.filters.flatMap(f => [[f.key, ''], ...(f.match ? [[f.match, '']] : [])])));
  actions.append(clear, apply);
  form.append(actions);
  form.onsubmit = event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const patch = {};
    for (const filter of config.filters) {
      let value = form.elements[filter.key].value.trim();
      if (filter.upper) value = value.toUpperCase();
      patch[filter.key] = value;
      if (filter.match) patch[filter.match] = value ? form.elements[filter.match].value : '';
    }
    state.filtersOpen[key] = false;
    setOptions(key, patch);
  };
  box.append(form);
  return box;
}

function customizer(key) {
  const config = SOURCES[key];
  const shown = new Set(visibleKpis(key).map(kpi => kpi.key));
  const box = el('section', undefined, 'panel customizer reveal');
  const top = el('div', undefined, 'panel-head');
  top.append(el('h3', 'Metrics to show'));
  const reset = el('button', 'Reset to default', 'btn'); reset.type = 'button';
  reset.onclick = () => { delete state.tiles[key]; writeStore(TILES_KEY, state.tiles); render(); };
  top.append(reset);
  box.append(top);
  const list = el('div', undefined, 'toggle-list');
  for (const kpi of config.kpis) {
    const toggle = el('button', kpi.label, 'toggle'); toggle.type = 'button';
    toggle.setAttribute('aria-pressed', String(shown.has(kpi.key)));
    toggle.onclick = () => {
      if (shown.has(kpi.key)) shown.delete(kpi.key); else shown.add(kpi.key);
      state.tiles[key] = config.kpis.map(k => k.key).filter(k => shown.has(k));
      writeStore(TILES_KEY, state.tiles);
      render();
    };
    list.append(toggle);
  }
  box.append(list, el('p', 'Saved on this device. Trend metrics are picked on the chart.', 'panel-note'));
  return box;
}

function breakdownColumns(key, source) {
  const money = moneyFormatter(currencyOf(source));
  const orDash = f => v => v === null || v === undefined ? '—' : f(v);
  const dimension = source.options?.breakdown;
  const label = SOURCES[key].breakdowns?.find(([v]) => v === dimension)?.[1] || 'Item';
  if (key === 'ga4') return [{ key: 'label', label, format: dimension === 'landingPagePlusQueryString' ? shortUrl : undefined }, { key: 'sessions', label: 'Sessions', format: fmt.num, bar: true }, { key: 'activeUsers', label: 'Users', format: fmt.num },
    { key: 'keyEvents', label: keyLabel(source), format: fmt.num }, { key: 'keyEventRate', label: 'Key event rate', format: fmt.pct }, { key: 'totalRevenue', label: 'Revenue', format: money }, { key: 'engagementRate', label: 'Engaged', format: fmt.pct0 }];
  if (key === 'search_console') return [{ key: 'label', label, format: dimension === 'page' ? shortUrl : undefined }, { key: 'clicks', label: 'Clicks', format: fmt.num, bar: true }, { key: 'impressions', label: 'Impr.', format: fmt.num }, { key: 'ctr', label: 'CTR', format: fmt.pct }, { key: 'position', label: 'Pos.', format: fmt.dec }];
  if (key === 'google_ads') {
    if (dimension === 'conversion_action') return [{ key: 'label', label }, { key: 'conversions', label: 'Conversions', format: fmt.num, bar: true }, { key: 'conversionValue', label: 'Conv. value', format: money }, { key: 'allConversions', label: 'All conv.', format: fmt.num }];
    return [{ key: 'label', label }, { key: 'cost', label: 'Spend', format: money, bar: true }, { key: 'impressions', label: 'Impr.', format: fmt.num }, { key: 'clicks', label: 'Clicks', format: fmt.num }, { key: 'ctr', label: 'CTR', format: orDash(fmt.pct) },
      { key: 'cpc', label: 'Avg. CPC', format: orDash(money) }, { key: 'conversions', label: 'Conv.', format: fmt.num }, { key: 'cpa', label: 'Cost / conv.', format: orDash(money) }, { key: 'conversionValue', label: 'Conv. value', format: money }, { key: 'roas', label: 'ROAS', format: orDash(fmt.ratio) }];
  }
  if (key === 'merchant_center') return [{ key: 'label', label }, { key: 'clicks', label: 'Clicks', format: fmt.num, bar: true }, { key: 'impressions', label: 'Impr.', format: fmt.num }, { key: 'ctr', label: 'CTR', format: orDash(fmt.pct) }, { key: 'conversions', label: 'Conv.', format: fmt.num }, { key: 'conversionValue', label: 'Conv. value', format: money }];
  return [{ key: 'label', label }, { key: 'calls', label: 'Calls', format: fmt.num, bar: true }, { key: 'answered', label: 'Answered', format: fmt.num }, { key: 'firstTime', label: 'First-time', format: fmt.num }, { key: 'answerRate', label: 'Answer rate', format: fmt.pct0 }, { key: 'averageDuration', label: 'Avg. duration', format: fmt.seconds }];
}

// Derived columns are computed per row so sorting works on them too.
function breakdownRows(key, source) {
  const dimension = source.options?.breakdown;
  return (rowsOf(source.breakdown) || []).map(row => {
    if (key === 'ga4') return { ...row, label: row[dimension] ?? '', keyEventRate: row.sessions ? row.keyEvents / row.sessions : 0 };
    if (key === 'google_ads') return { ...row, ctr: row.impressions ? row.clicks / row.impressions : null, cpc: row.clicks ? row.cost / row.clicks : null, cpa: row.conversions ? row.cost / row.conversions : null, roas: row.cost ? row.conversionValue / row.cost : null };
    if (key === 'merchant_center') return { ...row, ctr: row.impressions ? row.clicks / row.impressions : null };
    return row;
  });
}

function breakdownPanel(key, source) {
  const config = SOURCES[key];
  if (!config.breakdowns || !source.breakdown) return el('div', undefined, 'hidden-slot');
  const node = el('section', undefined, 'panel wide reveal');
  const head = el('div', undefined, 'panel-head');
  const title = el('div', undefined, 'panel-title');
  title.append(el('h3', 'Breakdown'));
  const picker = el('select', undefined, 'inline-select');
  picker.setAttribute('aria-label', 'Break down by');
  for (const [value, text] of config.breakdowns) picker.add(new Option(`by ${text}`, value));
  picker.value = source.options?.breakdown || config.breakdowns[0][0];
  picker.onchange = () => setOptions(key, { breakdown: picker.value });
  title.append(picker);
  head.append(title);
  const rowsSwitch = el('div', undefined, 'segmented');
  rowsSwitch.setAttribute('role', 'radiogroup'); rowsSwitch.setAttribute('aria-label', 'Rows to show');
  const limit = Number(state.options[key]?.limit) || 10;
  for (const count of [10, 25, 50]) {
    const chip = el('button', `Top ${count}`); chip.type = 'button';
    chip.setAttribute('role', 'radio'); chip.setAttribute('aria-checked', String(count === limit));
    chip.onclick = () => { if (count !== limit) setOptions(key, { limit: count }); };
    rowsSwitch.append(chip);
  }
  head.append(rowsSwitch);
  node.append(head);
  const rows = rowsOf(source.breakdown);
  if (!rows) node.append(failed(source.breakdown));
  else {
    node.append(rankedTable(breakdownRows(key, source), breakdownColumns(key, source)));
    node.append(el('p', `${source.breakdown.data.limited ? `Top ${limit} rows only, not a full total. ` : ''}Click a column to sort.${key === 'google_ads' && source.options?.breakdown === 'conversion_action' ? ' Conversion actions report conversion metrics only.' : ''}`, 'panel-note'));
  }
  return node;
}

// Picks a column count that fills every row evenly (6 tiles → 3+3 or 6, never 4+2),
// within the widest layout the container allows. Re-runs when the container resizes.
const balancers = new Set();
function balance(grid, minWidth, gap = 12) {
  const fit = () => {
    const items = grid.children.length;
    if (!items || !grid.isConnected) return;
    const max = Math.max(1, Math.min(items, Math.floor((grid.clientWidth + gap) / (minWidth + gap))));
    const rows = Math.ceil(items / max);
    grid.style.gridTemplateColumns = `repeat(${Math.ceil(items / rows)}, minmax(0, 1fr))`;
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(grid);
  balancers.add(observer);
}
function resetBalancers() { for (const observer of balancers) observer.disconnect(); balancers.clear(); }

// Below desktop width, put tabs, date controls and actions on one bar when they fit;
// otherwise the date controls drop to a second row. Measured, not guessed, because the
// open tab's label and a custom date range change the widths.
// Tries, in order: one row with the open tab's name, one row with logos only (the page
// title still names the view), then two rows.
let activeLabelWidth = 90;
function fitHeader() {
  const app = document.querySelector('.app');
  const width = window.innerWidth;
  if (width > 1100 || width <= 620) { app.classList.remove('one-row', 'tight'); return; }
  const active = $('nav').querySelector('[aria-current=true]');
  if (active && !app.classList.contains('tight')) activeLabelWidth = active.offsetWidth - 44;
  const logosOnly = $('nav').scrollWidth - (active ? active.offsetWidth - 44 : 0);
  // Brand, side paddings and gaps between the three groups.
  const fixed = document.querySelector('.brand').offsetWidth + document.querySelector('.controls').scrollWidth + document.querySelector('.actions').scrollWidth + 110;
  const labelled = fixed + logosOnly + activeLabelWidth <= width;
  const compact = fixed + logosOnly <= width;
  app.classList.toggle('one-row', compact);
  app.classList.toggle('tight', compact && !labelled);
}

// A lone half-width panel at the end of a two-column grid takes the full row instead.
function closeGaps(grid) {
  const halves = [...grid.children].filter(node => node.classList.contains('panel') && !node.classList.contains('wide'));
  if (halves.length % 2) halves.at(-1).classList.add('wide');
}

function legendItem(kind, text) {
  const item = el('span', undefined, 'legend-item');
  item.append(el('span', undefined, `legend-key ${kind}`), document.createTextNode(text));
  return item;
}

/* ---------------- Ask ChatGPT ---------------- */

function summaryFor(key) {
  const snap = state.snapshot;
  const pick = key === 'overview' ? Object.keys(snap.sources) : [key];
  const out = { range: snap.range, compare: snap.selection.compare !== false, signals: insights(), sources: {} };
  for (const name of pick) {
    const source = snap.sources[name], config = SOURCES[name];
    if (!source || !config) continue;
    if (source.status === 'error') { out.sources[name] = { error: source.message }; continue; }
    const now = rowsOf(source.totals)?.[0], before = rowsOf(source.comparison)?.[0];
    const kpis = Object.fromEntries(config.kpis.map(kpi => [kpi.key, { current: valueOf(kpi, now), previous: before ? valueOf(kpi, before) : null }]));
    const tables = {};
    for (const [field, report] of Object.entries(source)) if (report?.status === 'ready' && Array.isArray(report.data?.rows) && !['totals', 'comparison', 'daily', 'dailyPrevious'].includes(field)) tables[field] = report.data.rows.slice(0, 8);
    if (source.health?.status === 'ready') tables.productIssues = source.health.data.issues.slice(0, 6);
    if (source.reviews?.status === 'ready') tables.reviews = { ...source.reviews.data, latest: source.reviews.data.latest.slice(0, 3) };
    out.sources[name] = { account: source.account, currency: currencyOf(source), filters: source.options || {}, kpis, tables };
  }
  return out;
}

async function ask() {
  if (!state.snapshot || state.busy) return;
  const label = state.view === 'overview' ? 'cross-channel overview' : `${SOURCES[state.view].full} view`;
  const summary = JSON.stringify(summaryFor(state.view));
  let prompt = `Analyse the ${label} on my marketing dashboard for ${state.snapshot.range.startDate} to ${state.snapshot.range.endDate}. Compare with the previous period, explain the three strongest signals with their figures, and suggest three practical next actions. Separate evidence from hypotheses, and say where a source failed or its attribution differs.${state.view !== 'overview' && activeFilters(state.view).length ? ' The view is filtered; the filters are listed in the data.' : ''}`;
  // Model context is optional: hosts that refuse it still get the data inline with the prompt.
  try { await host.updateModelContext({ content: [{ type: 'text', text: summary }] }); }
  catch { prompt += `\n\nDashboard data (JSON):\n${summary}`; }
  try {
    await host.sendMessage(prompt);
    status('Sent to ChatGPT. The analysis appears in the conversation.', 'info');
  } catch (error) {
    status(`Could not send to ChatGPT (${error.message}). Ask it to analyse the loaded dashboard instead.`, 'error');
  }
}

/* ---------------- Controls ---------------- */

function setPreset(value) {
  state.preset = value;
  for (const button of document.querySelectorAll('[data-preset]')) button.setAttribute('aria-checked', String(String(value) === button.dataset.preset));
  $('custom-range').hidden = value !== 'custom';
  fitHeader();
  if (value !== 'custom' && state.snapshot) load();
}

function applyTheme(theme) { if (theme) document.documentElement.dataset.theme = theme; }

function wire() {
  window.addEventListener('resize', fitHeader);
  for (const button of document.querySelectorAll('[data-preset]')) button.onclick = () => setPreset(button.dataset.preset === 'custom' ? 'custom' : Number(button.dataset.preset));
  $('apply-custom').onclick = load;
  $('compare').onchange = () => { state.compare = $('compare').checked; if (state.snapshot) load(); };
  // Sandboxed hosts can block plain links, so ask the host to open them; fall back to a new tab.
  for (const link of document.querySelectorAll('.credit-link')) link.onclick = event => {
    if (!state.connected) return;
    event.preventDefault();
    host.openLink(link.href).catch(() => window.open(link.href, '_blank', 'noopener'));
  };
  $('accounts').onclick = openSheet;
  $('refresh').onclick = load;
  $('ask').onclick = ask;
  $('sheet-close').onclick = closeSheet;
  $('sheet-cancel').onclick = closeSheet;
  $('sheet-apply').onclick = applySheet;
  $('scrim').onclick = closeSheet;
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
  const end = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  $('endDate').value = end; $('startDate').value = addDays(end, -27);
  $('endDate').max = end; $('startDate').max = end;
}

let opened = false;
host.ontoolresult = result => {
  const data = result.structuredContent;
  if (data?.sources && !Array.isArray(data.sources)) return accept(data);
  if (!Array.isArray(data?.sources)) return;
  // Result of open_marketing_dashboard: which sources this server offers, plus any accounts the model preselected.
  state.available = data.sources.filter(key => SOURCES[key]);
  renderNav();
  const preset = Object.fromEntries(Object.entries(data.selection || {}).filter(([, value]) => value));
  if (Object.keys(preset).length) {
    state.selection = preset;
    saveSelection();
    if (state.connected && !opened) { opened = true; closeSheet(); load(); }
  }
};
host.onhostcontextchanged = context => applyTheme(context.theme);

async function start() {
  wire();
  renderNav();
  renderWelcome();
  if (!host.embedded) { status('Open this dashboard from ChatGPT to connect your accounts.', 'info'); return; }
  try {
    await host.connect();
    state.connected = true;
    $('refresh').disabled = false;
    applyTheme(host.hostContext.theme);
    const context = host.hostContext;
    if (context.displayMode !== 'fullscreen' && context.availableDisplayModes?.includes('fullscreen')) host.requestDisplayMode('fullscreen').catch(() => {});
    // The opener's tool result can arrive just after connecting; give it a moment before asking the user.
    await new Promise(resolve => setTimeout(resolve, 350));
    if (opened) { loadAccounts(); return; }
    opened = true;
    const remembered = Object.values(SOURCES).some(config => state.selection[config.select]);
    if (remembered) { load(); loadAccounts(); } else openSheet();
  } catch {
    status('This host could not connect the dashboard. Reopen it from ChatGPT.', 'error');
  }
}
start();
