import { App } from '@modelcontextprotocol/ext-apps';
import { gsap } from 'gsap';
const app = new App({ name: 'Marketer Companion', version: '0.1.0' }, { availableDisplayModes: ['fullscreen'] });
const $ = id => document.getElementById(id);
let snapshot, tab = 'ga4', busy = false, connected = false, filterDirty = false;
let motion;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function finishMotion() { motion?.revert(); motion = undefined; }
reducedMotion.addEventListener('change', finishMotion);
function animateView() {
  if (reducedMotion.matches) return;
  motion = gsap.context(() => {
    const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
    timeline.from('#view .section-title, #view .source-id', { y: 8, opacity: 0, duration: .3, stagger: .04 });
    timeline.from('#view .card', { y: 14, opacity: 0, duration: .42, stagger: .055, clearProps: 'transform,opacity' }, .08);
    timeline.from('#view > .panel, #view > .grid', { y: 12, opacity: 0, duration: .4, stagger: .08, clearProps: 'transform,opacity' }, .18);
    for (const line of document.querySelectorAll('#view .chart polyline')) {
      const length = line.getTotalLength();
      timeline.fromTo(line, { strokeDasharray: length, strokeDashoffset: length }, { strokeDashoffset: 0, duration: .8, clearProps: 'strokeDasharray,strokeDashoffset' }, .25);
    }
  }, $('view'));
}
window.addEventListener('pagehide', finishMotion);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
const num = value => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const pct = value => `${num(Number(value) * 100)}%`;
const dateLabel = value => new Date(`${value.length === 8 ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6)}` : value}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
function status(text) { $('status').textContent = text; }
function setBusy(value) { busy = value; for (const id of ['accounts', 'load']) $(id).disabled = value || !connected; $('analyse').disabled = value || !snapshot || filterDirty; }
function payload(result) { if (result.isError) throw new Error(result.structuredContent?.error || 'Unable to load. Check your connection.'); return result.structuredContent; }
function addOptions(id, source) {
  const select = $(id), selected = select.value;
  select.replaceChildren(new Option(`Choose ${id === 'siteUrl' ? 'a site' : id === 'propertyId' ? 'a property' : 'an account'}`, ''));
  if (source?.status === 'ready') for (const item of source.data) select.add(new Option(`${item.name}${item.account ? ` · ${item.account}` : ''}`, item.id));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}
async function accounts() {
  setBusy(true); status('Finding accounts available to your connection…');
  try {
    const data = payload(await app.callServerTool({ name: 'list_dashboard_accounts', arguments: {} }));
    for (const [id, source] of [['propertyId', 'ga4'], ['siteUrl', 'search_console'], ['customerId', 'google_ads']]) addOptions(id, data[source]);
    const errors = Object.entries(data).filter(([, value]) => value.status === 'error').map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value.message}`);
    status(errors.length ? errors.join('\n') : 'Accounts connected. Select matching accounts for the website you want to review.');
  } catch (error) { status(error.message); } finally { setBusy(false); }
}
function filters() {
  const args = { startDate: $('startDate').value, endDate: $('endDate').value, compare: $('compare').checked };
  for (const id of ['propertyId', 'siteUrl', 'customerId', 'loginCustomerId']) if ($(id).value.trim()) args[id] = $(id).value.trim();
  return args;
}
async function load() {
  const args = filters();
  if (!args.propertyId && !args.siteUrl && !args.customerId) return status('Select at least one account.');
  if (!args.startDate || !args.endDate) return status('Select a start and end date.');
  setBusy(true); status('Loading live reports and period comparisons…');
  try {
    accept(payload(await app.callServerTool({ name: 'get_marketing_dashboard', arguments: args })));
    status(`Updated ${new Date(snapshot.fetchedAt).toLocaleString()}. ${snapshot.range.startDate} to ${snapshot.range.endDate}.`);
  } catch (error) { status(`${error.message} The last loaded view is unchanged.`); } finally { setBusy(false); }
}
function accept(data) {
  if (!data?.sources) return;
  snapshot = data; filterDirty = false;
  $('startDate').value = data.range.startDate; $('endDate').value = data.range.endDate;
  $('compare').checked = data.selection.compare !== false;
  for (const id of ['propertyId', 'siteUrl', 'customerId']) {
    const value = data.selection[id] || '';
    if (value && ![...$(id).options].some(option => option.value === value)) $(id).add(new Option(value, value));
    $(id).value = value;
  }
  $('loginCustomerId').value = data.selection.loginCustomerId || '';
  if (!snapshot.sources[tab]) tab = Object.keys(snapshot.sources)[0] || 'ga4';
  render();
}
function warning(message) { return el('div', message, 'error'); }
function rows(report) { return report?.status === 'ready' ? report.data.rows : null; }
function panel(title, report, columns) {
  const node = el('section', undefined, 'panel'); node.append(el('h3', title));
  const data = rows(report);
  if (!data) { node.append(warning(report?.message || 'Report unavailable.')); return node; }
  if (!data.length) { node.append(el('p', 'No activity returned for this period.')); return node; }
  const scroll = el('div', undefined, 'table-scroll'), table = el('table'), head = el('tr');
  for (const [, label] of columns) head.append(el('th', label));
  const thead = el('thead'); thead.append(head); table.append(thead);
  const tbody = el('tbody');
  for (const row of data) { const tr = el('tr'); for (const [key, , formatter] of columns) tr.append(el('td', formatter ? formatter(row[key]) : String(row[key] ?? '—'))); tbody.append(tr); }
  table.append(tbody); scroll.append(table); node.append(scroll);
  node.append(el('p', report.data.limited ? 'Top results only. This table does not represent the full source total.' : 'Breakdown values may differ from totals because of source reporting rules.', 'source-note'));
  return node;
}
function chart(title, report, key, color = '#258c78') {
  const node = el('section', undefined, 'panel'); node.append(el('h3', title));
  const data = rows(report);
  if (!data) { node.append(warning(report?.message || 'Trend unavailable.')); return node; }
  if (!data.length) { node.append(el('p', 'No daily activity returned.')); return node; }
  const width = 900, height = 210, pad = 25, maximum = Math.max(...data.map(row => Number(row[key] || 0)), 1);
  const dateKey = tab === 'ga4' ? 'date' : 'label';
  const time = value => +new Date(`${value.length === 8 ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6)}` : value}T00:00:00Z`);
  const first = time(data[0][dateKey]), last = time(data.at(-1)[dateKey]);
  const points = data.map(row => `${pad + (time(row[dateKey]) - first) / Math.max(last - first, 1) * (width - 2 * pad)},${height - pad - Number(row[key] || 0) / maximum * (height - 2 * pad)}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${title}, ${data.length} reporting days, maximum ${num(maximum)}.`);
  const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('points', points); line.setAttribute('fill', 'none'); line.setAttribute('stroke', color); line.setAttribute('stroke-width', '3'); svg.append(line);
  node.append(el('div', `Peak daily value: ${num(Math.max(...data.map(row => Number(row[key] || 0))))}`, 'status'));
  node.append(svg);
  const labels = el('div', undefined, 'chart-labels'); labels.append(el('span', dateLabel(data[0][dateKey])), el('span', dateLabel(data.at(-1)[dateKey]))); node.append(labels);
  const details = el('details'), summary = el('summary', 'View daily values'); details.append(summary);
  details.append(panel('Daily values', report, [[dateKey, 'Date', dateLabel], [key, title, num]])); node.append(details);
  return node;
}
function render() {
  finishMotion();
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  const view = $('view'); view.setAttribute('aria-labelledby', `tab-${tab}`); view.replaceChildren();
  const source = snapshot?.sources[tab];
  if (!source) { view.append(el('div', 'Select this source and load the dashboard to see its reports.', 'empty')); return; }
  if (source.status === 'error') { view.append(warning(source.message)); return; }
  const names = { ga4: 'Website performance', search_console: 'Organic search performance', google_ads: 'Google Ads performance' };
  view.append(el('h2', names[tab], 'section-title'), el('p', source.account, 'source-id'));
  const totals = rows(source.totals), prev = rows(source.comparison), total = totals?.[0] || {}, previous = prev?.[0] || {};
  const currency = tab === 'google_ads' ? total.currency : source.totals?.data?.metadata?.currencyCode;
  const money = value => currency ? `${currency} ${num(value)}` : num(value);
  const fields = tab === 'ga4' ? [['sessions', 'Sessions', num], ['activeUsers', 'Active users', num], ['keyEvents', 'Key events', num], ['totalRevenue', 'Revenue', money]] : tab === 'search_console' ? [['clicks', 'Clicks', num], ['impressions', 'Impressions', num], ['ctr', 'Click-through rate', pct], ['position', 'Average position', num]] : [['cost', 'Spend', money], ['clicks', 'Clicks', num], ['conversions', 'Ads conversions', num], ['conversionValue', 'Conversion value', money]];
  if (!totals) view.append(warning(source.totals?.message || 'Totals unavailable.'));
  else {
    const cards = el('div', undefined, 'cards');
    for (const [key, label, formatter] of fields) {
      const card = el('div', undefined, 'card'); card.append(el('div', label, 'eyebrow'), el('div', tab === 'search_console' && key === 'position' && !totals.length ? '—' : formatter(total[key] || 0), 'value'));
      let change = 'Comparison off';
      if (source.comparison) { const before = previous[key], after = total[key] || 0; change = !prev ? 'Comparison unavailable' : before ? `${after >= before ? '+' : ''}${num((after - before) / before * 100)}% vs previous period` : 'No previous activity'; }
      card.append(el('div', change, 'delta')); cards.append(card);
    }
    view.append(cards);
  }
  const metadata = source.totals?.data?.metadata;
  if (metadata?.subjectToThresholding || metadata?.dataLossFromOtherRow) view.append(warning('GA4 reports thresholding or data loss from the “other” row. Interpret these figures with care.'));
  const grid = el('div', undefined, 'grid');
  if (tab === 'ga4') { view.append(chart('Sessions over time', source.daily, 'sessions')); grid.append(panel('Acquisition channels', source.channels, [['sessionDefaultChannelGroup', 'Channel'], ['sessions', 'Sessions', num], ['keyEvents', 'Key events', num]]), panel('Top landing pages', source.pages, [['landingPagePlusQueryString', 'Landing page'], ['sessions', 'Sessions', num], ['keyEvents', 'Key events', num]])); }
  if (tab === 'search_console') { view.append(chart('Search clicks over time', source.daily, 'clicks', '#497dbe')); grid.append(panel('Top search queries', source.queries, [['label', 'Query'], ['clicks', 'Clicks', num], ['impressions', 'Impressions', num], ['position', 'Position', num]]), panel('Top organic pages', source.pages, [['label', 'Page'], ['clicks', 'Clicks', num], ['impressions', 'Impressions', num]])); }
  if (tab === 'google_ads') { view.append(chart('Daily ad spend', source.daily, 'cost', '#9b6acb')); grid.append(panel('Campaign performance', source.campaigns, [['label', 'Campaign'], ['cost', 'Spend', money], ['clicks', 'Clicks', num], ['conversions', 'Conversions', num]])); }
  view.append(grid);
  $('footer').replaceChildren(el('div', `Loaded ${new Date(snapshot.fetchedAt).toLocaleString()} · ${snapshot.range.startDate}–${snapshot.range.endDate}${snapshot.selection.compare !== false ? ` · Compared with ${snapshot.range.previousStartDate}–${snapshot.range.previousEndDate}` : ''}`));
  for (const note of snapshot.notes || []) $('footer').append(el('div', note));
  animateView();
}
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => { tab = button.dataset.tab; render(); };
$('accounts').onclick = accounts; $('load').onclick = load;
for (const input of document.querySelectorAll('.controls input,.controls select')) input.addEventListener('change', () => { filterDirty = true; $('analyse').disabled = true; if (snapshot) status('Filters changed. Load the dashboard to apply them.'); });
$('analyse').onclick = async () => {
  if (!snapshot || filterDirty || busy) return;
  try {
    await app.updateModelContext({ content: [{ type: 'text', text: JSON.stringify({ range: snapshot.range, fetchedAt: snapshot.fetchedAt, source: tab, report: snapshot.sources[tab], notes: snapshot.notes }) }] });
    const response = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: `Analyse the ${tab.replaceAll('_', ' ')} dashboard view I selected. Compare the periods, explain the strongest signals, and suggest three practical actions. Distinguish evidence from hypotheses and flag source errors.` }] });
    if (response.isError) throw new Error('Host rejected message');
  } catch { status('Chat context could not be sent. Try asking ChatGPT to analyse the loaded dashboard.'); }
};
app.ontoolresult = result => {
  const data = result.structuredContent;
  if (data?.defaults && !snapshot) { $('startDate').value = data.defaults.startDate; $('endDate').value = data.defaults.endDate; }
  accept(data);
};
app.onhostcontextchanged = context => { if (context.theme) document.body.dataset.theme = context.theme; };
async function start() {
  const end = new Date(Date.now() - 3 * 86400000), start = new Date(+end - 27 * 86400000);
  $('startDate').value = start.toISOString().slice(0,10); $('endDate').value = end.toISOString().slice(0,10);
  if (window.parent === window) return;
  try {
    await app.connect(); connected = true;
    const context = app.getHostContext(); if (context?.theme) document.body.dataset.theme = context.theme;
    if (context?.displayMode !== 'fullscreen' && context?.availableDisplayModes?.includes('fullscreen')) await app.requestDisplayMode({ mode: 'fullscreen' });
    await accounts();
  } catch { status('This host could not connect the dashboard. Reopen it from your plugin after deploying the server update.'); }
}
start();
