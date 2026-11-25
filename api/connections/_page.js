// The Connections page markup. Server-rendered and complete without JavaScript (every action is a
// plain form or link); _page-script.js adds motion with Anime.js (served from this server at
// ANIME_PATH): staggered entrances, a loading state for every action, an animated toast for each
// result, a confirm dialog for disconnects and a live countdown for the private link.
import { layout, escapeHtml } from "../pages.js";
import { PROVIDERS } from "./providers.js";
import { oauthReady } from "./oauth.js";
import { PROFILE_FAMILIES, PROFILE_PLATFORMS, PROFILE_DEFAULTS, MAX_PROFILES, profileUrl } from "./profiles.js";
import { BRAND_MARKS } from "./_brand-logos.js";
import { MARKS as PRODUCT_MARKS } from "../../dashboard/logos.js";
import { PAGE_SCRIPT } from "./_page-script.js";

export const ANIME_PATH = "/assets/anime-4.5.0.min.js";

// Short copy per platform: what it gives the assistant, its mark, and what the add button says.
const PLATFORM = {
  google_account: { logo: BRAND_MARKS.google, purpose: "Analytics, Search Console, Ads, Merchant Center and Business Profile.", products: ["ga4", "search_console", "google_ads", "merchant_center", "gbp"] },
  youtube: { logo: BRAND_MARKS.youtube, purpose: "Channel reports, video edits, playlists and live chat.", unit: "channels" },
  meta: { logo: BRAND_MARKS.meta, purpose: "Ad accounts, Facebook Pages and Instagram." },
  meta_account: { logo: BRAND_MARKS.meta, purpose: "Ad accounts, Facebook Pages and Instagram." },
  callrail_key: { logo: PRODUCT_MARKS.callrail, purpose: "Calls, sources and lead value.", add: "Add CallRail key", keyHint: "CallRail → Settings → API Keys" },
  bing_webmaster: { logo: BRAND_MARKS.bing, purpose: "Bing search clicks, queries and pages.", add: "Add API key", keyHint: "Bing Webmaster Tools → Settings → API access" },
  clarity: { logo: BRAND_MARKS.clarity, purpose: "Rage clicks, dead clicks, scroll depth and sessions.", unit: "projects", add: "Add a Clarity project", addMore: "Add another Clarity project", keyHint: "Project → Settings → Data Export → Generate new API token" }
};
// Shorter labels for long form fields; the full wording stays in the field's hint.
const FIELD_LABEL = { projectId: "Project ID (optional)", snapshots: "Keep daily snapshots for 14- and 28-day reports" };
const FIELD_HINT = { projectId: "From the address bar: clarity.microsoft.com/projects/view/<ID>/", snapshots: "Uses 1 of Clarity's 10 daily requests." };
// Order on the page: the Google sign-in first, then by how often people add them.
const ORDER = ["google_account", "youtube", "meta_account", "callrail_key", "clarity", "bing_webmaster"];

/* ---------------- Icons (24px line icons, currentColor) ---------------- */
const path = d => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICON = {
  check: path('<path d="M20 6 9 17l-5-5"/>'),
  x: path('<path d="M18 6 6 18M6 6l12 12"/>'),
  plus: path('<path d="M12 5v14M5 12h14"/>'),
  lock: path('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  key: path('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2"/>'),
  unlink: path('<path d="m18.84 12.25 1.72-1.71a4.84 4.84 0 0 0-6.84-6.84l-1.72 1.71M5.17 11.75l-1.71 1.71a4.84 4.84 0 0 0 6.84 6.84l1.71-1.71M8 2v3M2 8h3M16 22v-3M22 16h-3"/>'),
  copy: path('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  refresh: path('<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>'),
  alert: path('<path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>'),
  external: path('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  user: path('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  layers: path('<path d="m12 2 10 5-10 5L2 7l10-5Z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>'),
  edit: path('<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  trash: path('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>')
};
const logoImg = (src, cls = "logo") => src ? `<img class="${cls}" src="${src}" alt="" decoding="async">` : `<span class="${cls} mono">${ICON.layers}</span>`;

/* ---------------- Accounts a profile can use ---------------- */
const MULTI_FAMILY = { google_account: "google", meta_account: "meta", callrail_key: "callrail" };
const MAIN_LABELS = { google: "Main sign-in (the Google account you sign in with)", meta: "Main sign-in's Meta login", callrail: "Main sign-in's CallRail key" };
export function accountChoices(connections, mainGoogle) {
  const labels = { ...MAIN_LABELS, ...(mainGoogle ? { google: `Main sign-in (${mainGoogle})` } : {}) };
  const choices = Object.fromEntries(Object.keys(PROFILE_FAMILIES).map(family => [family, [["main", labels[family]]]]));
  for (const connection of Object.values(connections)) {
    const family = MULTI_FAMILY[connection.provider];
    if (family) choices[family].push([connection.id, connection.label || connection.summary || connection.id]);
  }
  return choices;
}
// Checkbox platforms (YouTube and Clarity have their own one-of choice); a platform counts if any connection exists.
const OWN_SELECT = new Set(["youtube", "clarity"]);
export const platformChoices = connections => Object.keys(PROFILE_PLATFORMS).filter(id => !OWN_SELECT.has(id) && Object.values(connections).some(c => c.provider === id)).map(id => [id, PROVIDERS[id].name]);
export const youtubeChoices = connections => Object.values(connections).filter(c => c.provider === "youtube").map(c => [c.id, c.label || "YouTube channel"]);
export const clarityChoices = connections => Object.values(connections).filter(c => c.provider === "clarity").map(c => [c.id, c.label || "Clarity project"]);

/* ---------------- Platform cards ---------------- */
function accountRow(q, connection, { main = false } = {}) {
  const name = escapeHtml(connection.label || PROVIDERS[connection.provider]?.name || "Connected");
  const meta = connection.summary ? `<span class="acct-meta">${escapeHtml(connection.summary)}</span>` : "";
  const state = connection.expired ? `<span class="chip warn">${ICON.alert}Expired</span>` : main ? `<span class="chip">Main</span>` : "";
  const action = main ? "" : `<form method="post" action="/connections/${encodeURIComponent(connection.id)}/disconnect${q}" class="acct-form" data-confirm="Disconnect ${name}?" data-confirm-detail="Your assistant stops using it and its saved key or sign-in is deleted. You can add it again any time.">
      <button type="submit" class="icon-btn" aria-label="Disconnect ${name}" title="Disconnect">${ICON.unlink}</button></form>`;
  return `<li class="acct${connection.expired ? " expired" : ""}"><span class="dot" aria-hidden="true"></span><div class="acct-text"><strong>${name}</strong>${meta}</div>${state}${action}</li>`;
}

function keyForm(q, id, provider, { full, count }) {
  const copy = PLATFORM[id] || {};
  const fields = provider.fields.map(field => field.checkbox
    ? `<label class="check"><input type="checkbox" name="${field.key}" value="on"${field.checked ? " checked" : ""}><span>${escapeHtml(FIELD_LABEL[field.key] || field.label)}${FIELD_HINT[field.key] ? `<small>${escapeHtml(FIELD_HINT[field.key])}</small>` : ""}</span></label>`
    : `<label class="field"><span>${escapeHtml(FIELD_LABEL[field.key] || field.label)}${field.optional && !FIELD_LABEL[field.key] ? ' <em>optional</em>' : ""}</span>
        <input name="${field.key}" type="${field.secret ? "password" : "text"}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(field.placeholder || "")}" ${field.optional ? "" : "required"} maxlength="4000">
        ${FIELD_HINT[field.key] ? `<small>${escapeHtml(FIELD_HINT[field.key])}</small>` : ""}</label>`).join("");
  const label = count && copy.addMore ? copy.addMore : copy.add || `Connect ${provider.name}`;
  if (full) return `<p class="note">${ICON.alert}Limit reached. Disconnect one to add another.</p>`;
  return `<details class="keyform">
      <summary class="btn ${count ? "ghost" : "primary"}">${ICON.key}<span>${escapeHtml(label)}</span></summary>
      <form method="post" action="/connections/${id}${q}" class="form" data-loading="Checking…">
        ${fields}
        <p class="where">${ICON.key}<span>Where to find it: ${escapeHtml(copy.keyHint || provider.name)}. <a href="${escapeHtml(provider.helpUrl)}" target="_blank" rel="noopener">Open ${escapeHtml(provider.name)}${ICON.external}</a></span></p>
        <button type="submit" class="btn primary">${ICON.check}<span>Save and connect</span></button>
      </form>
    </details>`;
}

function platformCard(q, t, id, provider, connections, mainGoogle) {
  const copy = PLATFORM[id] || {};
  const mine = provider.multi ? Object.values(connections).filter(c => c.provider === id) : connections[id] ? [connections[id]] : [];
  const main = id === "google_account" ? [{ id: "main", provider: id, label: mainGoogle ? `Main sign-in · ${mainGoogle}` : "Main sign-in", summary: mainGoogle ? "The account you signed in with in your assistant. To change it, reconnect there." : "The Google account you signed in with in your assistant. Reconnect there once to show its email here." }] : [];
  const total = mine.length + main.length;
  const full = Boolean(provider.maxConnections && mine.length >= provider.maxConnections);
  const unit = copy.unit || "connections";
  const status = total ? `<span class="badge ok">${ICON.check}${provider.multi || main.length ? `${total} connected` : "Connected"}</span>` : `<span class="badge off">Not connected</span>`;
  const meter = provider.maxConnections && mine.length
    ? `<div class="meter" role="img" aria-label="${mine.length} of ${provider.maxConnections} ${unit} connected"><span style="--fill:${Math.round(mine.length / provider.maxConnections * 100)}%"></span></div>
       <p class="count">${mine.length} of ${provider.maxConnections} ${unit} connected.${full ? " Disconnect one to add another; signing in again with a connected one refreshes it." : ""}</p>` : "";
  let action;
  if (provider.oauth) {
    action = oauthReady(provider)
      ? `<a class="btn ${total ? "ghost" : "primary"}" href="/connections/${id}/start?t=${encodeURIComponent(t)}" data-redirect="${escapeHtml(provider.name)}">${full ? ICON.refresh : ICON.plus}<span>${escapeHtml(full ? "Refresh a connected channel" : provider.oauth.buttonLabel || `Connect ${provider.name}`)}</span></a>`
      : `<p class="note">${ICON.alert}${escapeHtml(provider.name)} isn’t set up on this server yet.</p>`;
  } else {
    action = provider.multi || !mine.length ? keyForm(q, id, provider, { full, count: mine.length }) : "";
  }
  const products = copy.products ? `<div class="products" aria-label="Includes">${copy.products.map(name => logoImg(PRODUCT_MARKS[name], "mini")).join("")}</div>` : "";
  return `<article class="pcard${total ? " is-on" : ""}" id="p-${id}" data-provider="${id}">
    <div class="pcard-head">
      <span class="tile">${logoImg(copy.logo)}</span>
      <div class="pcard-title"><div class="title-row"><h3>${escapeHtml(provider.name)}</h3>${status}</div><p>${escapeHtml(copy.purpose || provider.help)}</p>${products}</div>
    </div>
    ${total ? `<ul class="accts">${main.map(row => accountRow(q, row, { main: true })).join("")}${mine.map(row => accountRow(q, row)).join("")}</ul>` : ""}
    ${meter}
    <div class="pcard-foot">${action}</div>
    ${provider.help ? `<details class="disclose"><summary>Details</summary><p>${escapeHtml(provider.help)}</p></details>` : ""}
  </article>`;
}

/* ---------------- Profiles ---------------- */
function oneOfSelect({ name, title, anyLabel, options, value }) {
  if (!options.length) return "";
  return `<label class="field"><span>${title}</span>
      <select name="${name}"><option value="">None</option>${options.length > 1 ? `<option value="any"${value === "any" ? " selected" : ""}>${anyLabel}</option>` : ""}${options.map(([id, label]) =>
        `<option value="${escapeHtml(id)}"${value === id ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>`;
}

function profileForm(q, choices, platforms, profile, channels = [], clarityProjects = []) {
  const youtube = oneOfSelect({ name: "youtube_channel", title: "YouTube channel", anyLabel: "Any connected channel (asks which one)", options: channels,
    value: profile?.youtubeChannel || (profile?.platforms?.includes("youtube") ? "any" : "") });
  const clarity = oneOfSelect({ name: "clarity_project", title: "Microsoft Clarity project", anyLabel: "Any connected project (asks which one)", options: clarityProjects,
    value: profile?.clarityProject || (profile?.platforms?.includes("clarity") ? "any" : "") });
  const select = family => `<label class="field"><span>${PROFILE_FAMILIES[family]} account</span>
      <select name="account_${family}"><option value="">None</option>${choices[family].map(([value, label]) =>
        `<option value="${escapeHtml(value)}"${profile?.accounts?.[family] === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>`;
  const defaults = Object.entries(PROFILE_DEFAULTS).flatMap(([family, fields]) => Object.entries(fields).map(([arg, field]) =>
    `<label class="field"><span>${escapeHtml(field.label)}</span><input name="default_${family}_${arg}" value="${escapeHtml(profile?.defaults?.[family]?.[arg] || "")}" placeholder="${escapeHtml(field.placeholder)}" maxlength="300" autocomplete="off" spellcheck="false"></label>`)).join("");
  return `<form method="post" action="/connections/profiles/save${q}" class="form" data-loading="Saving…">
      ${profile ? `<input type="hidden" name="slug" value="${escapeHtml(profile.slug)}">` : ""}
      <label class="field"><span>Client name</span><input name="name" required maxlength="60" value="${escapeHtml(profile?.name || "")}" placeholder="Client A" autocomplete="off"></label>
      <div class="form-grid">${Object.keys(PROFILE_FAMILIES).map(select).join("")}${youtube}${clarity}</div>
      ${platforms.length ? `<fieldset><legend>Also include</legend>${platforms.map(([id, name]) => `<label class="check"><input type="checkbox" name="platform" value="${id}"${profile?.platforms?.includes(id) ? " checked" : ""}><span>${escapeHtml(name)}</span></label>`).join("")}</fieldset>` : ""}
      <details class="disclose"><summary>Default IDs (optional), used when a request leaves them out</summary><div class="form-grid">${defaults}</div></details>
      <button type="submit" class="btn primary">${profile ? ICON.check : ICON.plus}<span>${profile ? "Save changes" : "Create profile"}</span></button>
    </form>`;
}

function profilesSection(q, base, profiles, connections, mainGoogle) {
  const choices = accountChoices(connections, mainGoogle), platforms = platformChoices(connections), channels = youtubeChoices(connections), clarityProjects = clarityChoices(connections);
  const known = new Set(Object.values(choices).flat().map(([value]) => value));
  const cards = profiles.map(profile => {
    const rows = Object.entries(PROFILE_FAMILIES).filter(([family]) => profile.accounts?.[family]).map(([family, title]) => {
      const missing = !known.has(profile.accounts[family]);
      return `<li>${logoImg(family === "google" ? BRAND_MARKS.google : family === "meta" ? BRAND_MARKS.meta : PRODUCT_MARKS.callrail, "mini")}<span>${title}: ${escapeHtml(profile.accountLabels?.[family] || profile.accounts[family])}</span>${missing ? `<span class="chip warn">${ICON.alert}Disconnected: pick another account</span>` : ""}</li>`;
    });
    const extras = (profile.platforms || []).map(id => {
      const pinned = id === "youtube" ? profile.youtubeChannel : id === "clarity" ? profile.clarityProject : null;
      const logo = { youtube: BRAND_MARKS.youtube, clarity: BRAND_MARKS.clarity, bing_webmaster: BRAND_MARKS.bing }[id];
      const label = pinned ? `${PROVIDERS[id]?.name}: ${profile.accountLabels?.[id] || "set"}` : PROVIDERS[id]?.name || id;
      return `<li>${logoImg(logo, "mini")}<span>${escapeHtml(label)}</span>${pinned && !connections[pinned] ? `<span class="chip warn">${ICON.alert}Disconnected: pick another</span>` : ""}</li>`;
    });
    const url = profileUrl(base, profile.slug);
    return `<article class="profile" data-slug="${escapeHtml(profile.slug)}">
      <div class="profile-head"><span class="avatar" aria-hidden="true">${escapeHtml(profile.name.trim().slice(0, 1).toUpperCase())}</span><h3>${escapeHtml(profile.name)}</h3></div>
      <ul class="uses">${rows.concat(extras).join("")}</ul>
      <div class="url"><label for="u-${escapeHtml(profile.slug)}">Connector URL</label>
        <div class="url-row"><input id="u-${escapeHtml(profile.slug)}" readonly value="${escapeHtml(url)}" onclick="this.select()"><button type="button" class="btn ghost copy" data-copy="${escapeHtml(url)}">${ICON.copy}<span>Copy</span></button></div></div>
      <div class="profile-actions">
        <details class="disclose edit"><summary>${ICON.edit}Edit</summary>${profileForm(q, choices, platforms, profile, channels, clarityProjects)}</details>
        <form method="post" action="/connections/profiles/${encodeURIComponent(profile.slug)}/delete${q}" data-confirm="Delete the profile ${escapeHtml(profile.name)}?" data-confirm-detail="Its connector URL stops working. Remove that connector from your assistant too." data-confirm-action="Delete profile">
          <button type="submit" class="btn text danger">${ICON.trash}<span>Delete profile</span></button></form>
      </div>
    </article>`;
  });
  return `<section class="section" id="profiles" aria-labelledby="profiles-title">
  <div class="section-head"><h2 id="profiles-title">Profiles</h2><p>A profile is one client: which accounts to use, plus default IDs. Each profile gets its own connector URL.</p></div>
  <ol class="steps">
    <li><span>1</span>Create a profile</li>
    <li><span>2</span>Copy its connector URL</li>
    <li><span>3</span>In Claude: Settings → Connectors → Add custom connector</li>
  </ol>
  <div class="profiles">${cards.join("\n")}
  ${profiles.length < MAX_PROFILES ? `<article class="profile new"><div class="profile-head"><span class="avatar" aria-hidden="true">${ICON.plus}</span><h3>New profile</h3></div>${profileForm(q, choices, platforms, null, channels, clarityProjects)}</article>` : ""}</div>
</section>`;
}

/* ---------------- Page ---------------- */
// `toast` is { kind: "success" | "error" | "info", text, provider? } for the result of the last action.
export function page(t, connections, { toast, profiles = [], base = "", mainGoogle = null, linkExpiresAt = null } = {}) {
  const q = `?t=${encodeURIComponent(t)}`;
  const ids = [...ORDER.filter(id => PROVIDERS[id]), ...Object.keys(PROVIDERS).filter(id => !ORDER.includes(id))];
  const accountCount = Object.keys(connections).length + 1;
  const platformCount = ids.filter(id => id === "google_account" || Object.values(connections).some(c => c.provider === id)).length;
  const toastIcon = toast?.kind === "error" ? ICON.x : toast?.kind === "success" ? ICON.check : ICON.alert;
  return layout("Connections", `
<style>${STYLES}</style>
<script>if (!matchMedia("(prefers-reduced-motion: reduce)").matches) { document.documentElement.classList.add("pre"); setTimeout(() => document.documentElement.classList.remove("pre"), 2500); }</script>
<div class="cx">
  <section class="hero">
    <div><h1>Connections</h1><p class="lead">Link the accounts your assistant can use. Keys are encrypted and never shown again.</p></div>
    <p class="expiry" ${linkExpiresAt ? `data-expires="${linkExpiresAt}"` : ""}>${ICON.lock}<span>Private link<span class="left">, valid for 30 minutes</span></span></p>
  </section>
  <dl class="stats">
    <div><dt>Accounts</dt><dd data-count="${accountCount}">${accountCount}</dd></div>
    <div><dt>Platforms</dt><dd data-count="${platformCount}">${platformCount}</dd></div>
    <div><dt>Profiles</dt><dd data-count="${profiles.length}">${profiles.length}</dd></div>
  </dl>
  <section class="section" aria-labelledby="platforms-title">
    <div class="section-head"><h2 id="platforms-title">Platforms</h2><p>Add as many accounts as you manage. Your assistant picks the one that can see what you ask about.</p></div>
    <div class="grid">${ids.map(id => platformCard(q, t, id, PROVIDERS[id], connections, mainGoogle)).join("\n")}</div>
  </section>
  ${profilesSection(q, base, profiles, connections, mainGoogle)}
  <p class="tip">${ICON.check}<span>Done? Go back to your chat and ask, for example, “Show my Bing search queries” or “Which pages get the most rage clicks?”</span></p>
</div>
${toast ? `<div class="toast ${toast.kind}" role="${toast.kind === "error" ? "alert" : "status"}" data-provider="${escapeHtml(toast.provider || "")}"><span class="toast-icon">${toastIcon}</span><p>${escapeHtml(toast.text)}</p><button type="button" class="icon-btn toast-close" aria-label="Dismiss">${ICON.x}</button></div>` : ""}
<dialog class="confirm" aria-labelledby="confirm-title"><form method="dialog"><span class="confirm-icon">${ICON.unlink}</span><h3 id="confirm-title"></h3><p class="confirm-detail"></p>
  <div class="confirm-actions"><button value="cancel" class="btn ghost">Keep it</button><button value="ok" class="btn danger-fill">Disconnect</button></div></form></dialog>
<div class="redirect" aria-hidden="true"><div class="redirect-box"><span class="tile big"></span><div class="dots"><i></i><i></i><i></i></div><p>Opening <b></b>…</p></div></div>
<script src="${ANIME_PATH}" defer></script>
<script>${PAGE_SCRIPT}</script>`);
}

/* ---------------- Styles ---------------- */
const STYLES = `
main{max-width:1080px}
.pre .cx>*,.pre .toast{opacity:0}
body{--ok:#1f8f53;--ok-soft:color-mix(in srgb,var(--ok) 12%,transparent);--bad:#d03b3b;--bad-soft:color-mix(in srgb,var(--bad) 12%,transparent);--warn:#b7791f;--ring:color-mix(in srgb,var(--accent) 35%,transparent);--r:18px}
@media (prefers-color-scheme:dark){body{--ok:#3ccf7f;--bad:#ff6b6b;--warn:#f0b44c}}
.ico{width:18px;height:18px;flex:none}
.hero{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 24px;margin:4px 0 18px}
.hero h1{font-size:34px;margin:0 0 6px}
.hero .lead{margin:0;max-width:560px}
.expiry{display:inline-flex;align-items:center;gap:8px;margin:0;padding:7px 12px;border-radius:999px;background:var(--surface);border:1px solid var(--border);font-size:13px;font-weight:600;color:var(--ink-2);font-variant-numeric:tabular-nums}
.expiry .ico{width:15px;height:15px;color:var(--accent)}
.expiry.soon{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.expiry.soon .ico{color:var(--warn)}
.expiry.over{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,transparent)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 30px}
.stats div{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 18px}
.stats dt{font-size:12.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.stats dd{margin:2px 0 0;font-size:28px;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.section{margin:0 0 34px}
.section-head h2{margin:0 0 4px}
.section-head p{margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;align-items:start}
.pcard{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;display:flex;flex-direction:column;gap:12px;transition:border-color .25s,box-shadow .25s,transform .25s}
.pcard:hover{box-shadow:0 10px 30px -18px rgba(0,0,0,.35);transform:translateY(-1px)}
.pcard.is-on{border-color:color-mix(in srgb,var(--ok) 30%,var(--border))}
.pcard.flash{box-shadow:0 0 0 4px var(--ring)}
.pcard-head{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start}
.title-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 10px}
.tile{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;background:var(--page);border:1px solid var(--border)}
.tile.big{width:64px;height:64px;border-radius:18px}
.logo{width:28px;height:28px;object-fit:contain}
.tile.big .logo{width:40px;height:40px}
.logo.mono{color:var(--muted)}
.pcard-title h3{margin:0;font-size:16.5px}
.pcard-title p{margin:2px 0 0;font-size:13.5px;line-height:1.45}
.products{display:flex;gap:6px;margin-top:8px}
.mini{width:18px;height:18px;object-fit:contain;flex:none}
.badge{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-size:12px;font-weight:700;padding:4px 9px;border-radius:999px}
.badge .ico{width:13px;height:13px;stroke-width:3}
.badge.ok{color:var(--ok);background:var(--ok-soft)}
.badge.off{color:var(--muted);background:var(--page);border:1px solid var(--border)}
.accts{list-style:none;margin:0;padding:0;border-top:1px solid var(--border)}
.acct{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);margin:0}
.acct .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none;box-shadow:0 0 0 3px var(--ok-soft)}
.acct.expired .dot{background:var(--warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 15%,transparent)}
.acct-text{flex:1;min-width:0;display:flex;flex-direction:column}
.acct-text strong{font-size:14px;color:var(--ink);overflow-wrap:anywhere}
.acct-meta{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.acct-form{margin:0}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--page);border:1px solid var(--border);color:var(--ink-2);white-space:nowrap}
.chip .ico{width:12px;height:12px}
.chip.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.icon-btn{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer;transition:background .2s,color .2s,border-color .2s}
.icon-btn:hover,.icon-btn:focus-visible{color:var(--bad);background:var(--bad-soft);border-color:color-mix(in srgb,var(--bad) 25%,transparent)}
.meter{height:6px;border-radius:99px;background:var(--page);border:1px solid var(--border);overflow:hidden}
.meter span{display:block;height:100%;width:var(--fill);transform-origin:left;border-radius:inherit;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 60%,#7bdcb5))}
.count{margin:-4px 0 0;font-size:12.5px;color:var(--muted)}
.pcard-foot{display:flex;flex-direction:column;gap:10px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:14px;font-weight:650;padding:10px 16px;border-radius:12px;border:1px solid transparent;cursor:pointer;text-decoration:none;transition:transform .15s,background .2s,box-shadow .2s,opacity .2s;user-select:none;align-self:flex-start;list-style:none}
.btn::-webkit-details-marker{display:none}
.btn:active{transform:scale(.97)}
.btn.primary{background:var(--accent);color:#fff;box-shadow:0 6px 18px -10px var(--accent)}
.btn.primary:hover{filter:brightness(1.06)}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--border)}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent)}
.btn.text{padding:8px 10px;background:none;color:var(--ink-2)}
.btn.danger{color:var(--bad)}
.btn.danger-fill{background:var(--bad);color:#fff}
.btn.busy{pointer-events:none;opacity:.85}
.btn .spin{width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;flex:none}
.btn:focus-visible,.icon-btn:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:none;box-shadow:0 0 0 3px var(--ring)}
.keyform{display:flex;flex-direction:column;gap:12px}
.keyform[open]>summary.ghost{border-color:var(--accent);color:var(--accent)}
.form{display:grid;gap:12px;margin-top:2px}
.form>.btn{justify-self:start}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.field{display:grid;gap:5px;font-size:13px;font-weight:650;color:var(--ink)}
.field em{font-style:normal;font-weight:500;color:var(--muted)}
.field small,.check small{display:block;font-weight:400;color:var(--muted);font-size:12px}
.field input,.field select{font:inherit;font-size:14px;padding:10px 12px;border-radius:11px;border:1px solid var(--border);background:var(--page);color:var(--ink);width:100%;min-width:0;transition:border-color .2s,box-shadow .2s}
.field input:hover,.field select:hover{border-color:color-mix(in srgb,var(--accent) 40%,var(--border))}
.check{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;font-weight:500;color:var(--ink)}
.check input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--accent);flex:none}
fieldset{border:1px solid var(--border);border-radius:12px;padding:10px 14px;display:grid;gap:8px;margin:0}
legend{font-size:13px;font-weight:650;padding:0 4px}
.where{display:flex;gap:8px;align-items:flex-start;margin:0;font-size:12.5px;color:var(--muted)}
.where .ico{width:15px;height:15px;margin-top:2px}
.where a{display:inline-flex;align-items:center;gap:3px;font-weight:600}
.where a .ico{width:13px;height:13px;margin:0}
.note{display:flex;gap:8px;align-items:center;margin:0;font-size:13px;color:var(--warn)}
.disclose>summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--muted);display:inline-flex;align-items:center;gap:6px;list-style:none}
.disclose>summary::-webkit-details-marker{display:none}
.disclose>summary .ico{width:15px;height:15px}
.disclose>summary:hover{color:var(--accent)}
.disclose p{font-size:13px;margin:8px 0 0}
.steps{list-style:none;padding:0;margin:0 0 16px;display:flex;flex-wrap:wrap;gap:10px}
.steps li{display:flex;align-items:center;gap:8px;margin:0;padding:7px 14px 7px 7px;border-radius:999px;background:var(--surface);border:1px solid var(--border);font-size:13.5px;font-weight:600;color:var(--ink)}
.steps li span{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;font-size:12.5px}
.profiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;align-items:start}
.profile{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;display:flex;flex-direction:column;gap:12px}
.profile.new{border-style:dashed}
.profile-head{display:flex;align-items:center;gap:10px}
.profile h3{margin:0;font-size:16.5px}
.avatar{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 55%,#2a6df4))}
.avatar .ico{width:18px;height:18px}
.uses{list-style:none;margin:0;padding:0;display:grid;gap:7px}
.uses li{display:flex;align-items:center;gap:8px;margin:0;font-size:13.5px;flex-wrap:wrap}
.url label{display:block;font-size:12.5px;font-weight:650;margin-bottom:5px}
.url-row{display:flex;gap:8px}
.url-row input{flex:1;min-width:0;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 11px;border-radius:11px;border:1px solid var(--border);background:var(--page);color:var(--ink)}
.copy.done{color:var(--ok);border-color:var(--ok)}
.profile-actions{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px}
.profile-actions .edit{flex:1 1 100%}
.profile-actions .edit[open]>summary{margin-bottom:10px}
.tip{display:flex;gap:10px;align-items:flex-start;padding:14px 16px;border-radius:var(--r);background:var(--ok-soft);color:var(--ink)}
.tip .ico{color:var(--ok);margin-top:3px}
.toast{position:fixed;left:0;right:0;margin:0 auto;bottom:24px;z-index:20;display:flex;align-items:center;gap:12px;width:min(560px,calc(100vw - 32px));padding:12px 12px 12px 14px;border-radius:16px;background:var(--surface);border:1px solid var(--border);box-shadow:0 24px 60px -20px rgba(0,0,0,.45)}
.toast p{margin:0;flex:1;color:var(--ink);font-size:14px;font-weight:550}
.toast-icon{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;flex:none;color:#fff}
.toast-icon .ico{width:18px;height:18px;stroke-width:3}
.toast.success .toast-icon{background:var(--ok)}
.toast.error .toast-icon{background:var(--bad)}
.toast.info .toast-icon{background:var(--accent)}
.toast.error{border-color:color-mix(in srgb,var(--bad) 45%,transparent)}
.toast-close:hover{color:var(--ink);background:var(--page);border-color:var(--border)}
.confirm{border:1px solid var(--border);border-radius:22px;padding:0;background:var(--surface);color:var(--ink);width:min(420px,calc(100vw - 32px));box-shadow:0 40px 80px -30px rgba(0,0,0,.5)}
.confirm::backdrop{background:rgba(10,10,10,.45);backdrop-filter:blur(3px)}
.confirm form{padding:24px;display:grid;gap:8px;justify-items:start}
.confirm h3{margin:6px 0 0;font-size:18px}
.confirm p{margin:0;font-size:14px}
.confirm-icon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;color:var(--bad);background:var(--bad-soft)}
.confirm-actions{display:flex;gap:8px;justify-self:end;margin-top:12px}
.redirect{position:fixed;inset:0;z-index:30;display:none;place-items:center;background:color-mix(in srgb,var(--page) 82%,transparent);backdrop-filter:blur(6px)}
.redirect.on{display:grid}
.redirect-box{display:grid;justify-items:center;gap:14px;text-align:center}
.redirect p{margin:0;font-weight:650;color:var(--ink)}
.dots{display:flex;gap:7px}
.dots i{width:9px;height:9px;border-radius:50%;background:var(--accent)}
@media (max-width:560px){.hero h1{font-size:28px}.stats dd{font-size:22px}.grid,.profiles{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.pcard,.btn,.icon-btn{transition:none}}
`;
