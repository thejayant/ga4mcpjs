// Picks the accounts that belong to one business, so people don't have to choose six
// dropdowns. Names are reduced to a "core" (getcarports.com, Get_Carports_GA4 and
// "Get Carports" all become "getcarports") and compared. Pure functions; no DOM.

const STOP = new Set(['ga4', 'ga', 'ua', 'analytics', 'google', 'property', 'site', 'website', 'web', 'app', 'stream', 'account',
  'inc', 'llc', 'ltd', 'co', 'corp', 'company', 'the', 'and', 'www', 'http', 'https', 'sc', 'domain', 'com', 'net', 'org', 'io',
  'us', 'uk', 'in', 'ca', 'au', 'biz', 'info', 'main', 'official', 'new', 'old', 'prod', 'production', 'live', 'store', 'shop']);

export function tokens(text) {
  return String(text || '')
    .replace(/^sc-domain:/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token && !STOP.has(token) && !/^\d+$/.test(token));
}
const core = text => tokens(text).join('');

// 100 = same business core; 80 = one core contains the other; up to 60 for shared words.
export function similarity(a, b) {
  const x = core(a), y = core(b);
  if (x.length < 4 || y.length < 4) return 0;
  if (x === y) return 100;
  if (x.includes(y) || y.includes(x)) return 80;
  const ta = tokens(a).filter(token => token.length >= 4), tb = new Set(tokens(b).filter(token => token.length >= 4));
  const shared = ta.filter(token => tb.has(token)).length;
  return shared ? Math.round(60 * shared / Math.max(ta.length, tb.size)) : 0;
}

// Text that identifies an account: its name plus the website or place it belongs to.
const label = item => `${item.name || ''} ${item.account || ''} ${String(item.id || '').startsWith('sc-domain:') || /^https?:/.test(item.id) ? item.id : ''}`;
const MATCH = 60;

// Best account in a list for a business name, or null when nothing is a confident match.
export function bestMatch(items, hint) {
  let best = null, bestScore = 0;
  for (const item of items) {
    const score = Math.max(similarity(hint, item.name), similarity(hint, item.account), similarity(hint, item.id), similarity(hint, label(item)));
    if (score > bestScore || (score === bestScore && best && String(item.name).length < String(best.name).length)) { best = item; bestScore = score; }
  }
  return bestScore >= MATCH ? best : null;
}

/**
 * accounts: { [source]: { status, data: [{ id, name, account }] } }; params: { [source]: selection key }.
 * With a hint (a business name or website), picks the matching account per source. A source's
 * only account is used without a match just when its accounts carry no names to compare (Google
 * Ads lists bare customer IDs); a named account that doesn't match belongs to another business.
 * Without a hint, picks a source's account only when it is the only one.
 * Returns { selection, matched: [source] }.
 */
export function autoSelect(accounts, params, hint) {
  const selection = {}, matched = [];
  for (const [source, param] of Object.entries(params)) {
    const list = accounts?.[source]?.status === 'ready' ? accounts[source].data : [];
    if (!list.length) continue;
    const nameless = list.every(item => !tokens(`${item.name || ''} ${item.account || ''}`).length);
    const pick = hint ? bestMatch(list, hint) || (list.length === 1 && nameless ? list[0] : null) : list.length === 1 ? list[0] : null;
    if (pick) { selection[param] = pick.id; matched.push(source); }
  }
  return { selection, matched };
}

// The business name an already chosen account stands for, used to fill in its siblings.
export const hintFrom = item => item ? (String(item.id).startsWith('sc-domain:') || /^https?:/.test(item.id) ? item.id : item.name) : '';
