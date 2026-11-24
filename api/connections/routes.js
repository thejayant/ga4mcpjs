// The Connections page: where a signed-in user connects or disconnects extra platforms.
// It opens from a private link that ChatGPT/Claude gets from the manage_connections tool
// (an encrypted, 30-minute token naming the user), so there is no separate login and nothing
// is added to the app's own sign-in flow. Secrets are never shown back.
import { layout, escapeHtml } from "../pages.js";
import { PROVIDERS, publicConnection, baseProvider } from "./providers.js";
import { oauthReady, authorizeUrl, exchangeCode, STATE_TTL_MS, CALLBACK_PATH } from "./oauth.js";
import { PROFILE_FAMILIES, PROFILE_PLATFORMS, PROFILE_DEFAULTS, MAX_PROFILES, SLUG_PATTERN, buildProfile, profileUrl } from "./profiles.js";

export const LINK_TTL_MS = 30 * 60 * 1000;

export function connectionsLink(baseUrl, seal, userId) {
  const token = seal({ typ: "connections_link", userId, exp: Date.now() + LINK_TTL_MS });
  return { url: `${baseUrl}/connections?t=${encodeURIComponent(token)}`, expiresAt: new Date(Date.now() + LINK_TTL_MS).toISOString() };
}

function readLink(open, token) {
  try {
    const link = open(String(token || ""));
    return link?.typ === "connections_link" && link.userId && link.exp > Date.now() ? link : null;
  } catch {
    return null;
  }
}

// The accounts a profile can use per platform: the main sign-in's, or one added on this page.
const MULTI_FAMILY = { google_account: "google", meta_account: "meta", callrail_key: "callrail" };
const MAIN_LABELS = { google: "Main sign-in (the Google account you sign in with)", meta: "Main sign-in's Meta login", callrail: "Main sign-in's CallRail key" };
function accountChoices(connections, mainGoogle) {
  const labels = { ...MAIN_LABELS, ...(mainGoogle ? { google: `Main sign-in (${mainGoogle})` } : {}) };
  const choices = Object.fromEntries(Object.keys(PROFILE_FAMILIES).map(family => [family, [["main", labels[family]]]]));
  for (const connection of Object.values(connections)) {
    const family = MULTI_FAMILY[connection.provider];
    if (family) choices[family].push([connection.id, connection.label || connection.summary || connection.id]);
  }
  return choices;
}
// Checkbox platforms (YouTube has its own channel choice); a platform counts if any of its connections exists.
const platformChoices = connections => Object.keys(PROFILE_PLATFORMS).filter(id => id !== "youtube" && Object.values(connections).some(c => c.provider === id)).map(id => [id, PROVIDERS[id].name]);
const youtubeChoices = connections => Object.values(connections).filter(c => c.provider === "youtube").map(c => [c.id, c.label || "YouTube channel"]);

function profileForm(q, choices, platforms, profile, channels = []) {
  const youtubeValue = profile?.youtubeChannel || (profile?.platforms?.includes("youtube") ? "any" : "");
  const youtube = channels.length ? `<label>YouTube channel
      <select name="youtube_channel"><option value="">None</option>${channels.length > 1 ? `<option value="any"${youtubeValue === "any" ? " selected" : ""}>Any connected channel (asks which one)</option>` : ""}${channels.map(([value, label]) =>
        `<option value="${escapeHtml(value)}"${youtubeValue === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>` : "";
  const select = family => `<label>${PROFILE_FAMILIES[family]} account
      <select name="account_${family}"><option value="">None</option>${choices[family].map(([value, label]) =>
        `<option value="${escapeHtml(value)}"${profile?.accounts?.[family] === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>`;
  const defaults = Object.entries(PROFILE_DEFAULTS).flatMap(([family, fields]) => Object.entries(fields).map(([arg, field]) =>
    `<label>${escapeHtml(field.label)} <span>(optional)</span><input name="default_${family}_${arg}" value="${escapeHtml(profile?.defaults?.[family]?.[arg] || "")}" placeholder="${escapeHtml(field.placeholder)}" maxlength="300" autocomplete="off"></label>`)).join("");
  return `<form method="post" action="/connections/profiles/save${q}" class="connect-form">
      ${profile ? `<input type="hidden" name="slug" value="${escapeHtml(profile.slug)}">` : ""}
      <label>Name<input name="name" required maxlength="60" value="${escapeHtml(profile?.name || "")}" placeholder="Client A" autocomplete="off"></label>
      ${Object.keys(PROFILE_FAMILIES).map(select).join("")}
      ${youtube}
      ${platforms.length ? `<fieldset><legend>Also include</legend>${platforms.map(([id, name]) => `<label class="check"><input type="checkbox" name="platform" value="${id}"${profile?.platforms?.includes(id) ? " checked" : ""}> ${escapeHtml(name)}</label>`).join("")}</fieldset>` : ""}
      <details><summary>Default IDs, used when a request leaves them out</summary><div class="connect-form">${defaults}</div></details>
      <button type="submit" class="cta">${profile ? "Save changes" : "Create profile"}</button>
    </form>`;
}

function profilesSection(q, base, profiles, connections, mainGoogle) {
  const choices = accountChoices(connections, mainGoogle), platforms = platformChoices(connections), channels = youtubeChoices(connections);
  const known = new Set(Object.values(choices).flat().map(([value]) => value));
  const cards = profiles.map(profile => {
    const accounts = Object.entries(PROFILE_FAMILIES).filter(([family]) => profile.accounts?.[family]).map(([family, title]) => {
      const key = profile.accounts[family];
      const missing = !known.has(key);
      return `<li>${title}: ${escapeHtml(profile.accountLabels?.[family] || key)}${missing ? ` <strong class="warn">(disconnected: pick another account)</strong>` : ""}</li>`;
    });
    const extras = (profile.platforms || []).map(id => id === "youtube" && profile.youtubeChannel
      ? `<li>YouTube: ${escapeHtml(profile.accountLabels?.youtube || "channel")}${connections[profile.youtubeChannel] ? "" : ` <strong class="warn">(disconnected: pick another channel)</strong>`}</li>`
      : `<li>${escapeHtml(PROVIDERS[id]?.name || id)}</li>`);
    return `<div class="card"><span class="tag">Profile</span><h3>${escapeHtml(profile.name)}</h3>
      <ul class="plain">${accounts.concat(extras).join("")}</ul>
      <label class="url">Connector URL<input readonly value="${escapeHtml(profileUrl(base, profile.slug))}" onclick="this.select()"></label>
      <details><summary>Edit</summary>${profileForm(q, choices, platforms, profile, channels)}</details>
      <form method="post" action="/connections/profiles/${encodeURIComponent(profile.slug)}/delete${q}"><button type="submit" class="secondary-btn">Delete profile</button></form>
    </div>`;
  });
  return `<h2>Profiles</h2>
<p class="lead">A profile is one client: which Google, Meta and CallRail account to use, plus default IDs. Each profile has its own connector URL. In Claude, open Settings → Connectors → Add custom connector, paste the URL, name it after the client and sign in; then turn on that client's connector in a chat. Any other assistant that takes a remote MCP server URL works the same way. On your main connector, ask for a client by profile name, or compare clients side by side.</p>
${cards.join("\n")}
${profiles.length < MAX_PROFILES ? `<div class="card"><span class="tag">New</span><h3>New profile</h3>${profileForm(q, choices, platforms, null, channels)}</div>` : ""}`;
}

// The main sign-in is managed in the assistant (Claude, ChatGPT…), so it has no Disconnect button here.
const mainEntry = mainGoogle => `<div class="entry"><p class="status ok">Main sign-in${mainGoogle ? ` · ${escapeHtml(mainGoogle)}` : ""} · Analytics, Search Console, Ads, Merchant Center</p>
         <p class="muted">${mainGoogle ? "The account you signed in with in your assistant. To change it, reconnect there." : "The Google account you signed in with in your assistant. Reconnect there once to show its email here."}</p></div>`;

function page(t, connections, { notice, error, profiles = [], base = "", mainGoogle = null } = {}) {
  const q = `?t=${encodeURIComponent(t)}`;
  const entry = connected => `<div class="entry"><p class="status ${connected.expired ? "expired" : "ok"}">${connected.expired ? "Expired, connect again" : "Connected"}${connected.label ? ` · ${escapeHtml(connected.label)}` : ""}${connected.summary ? ` · ${escapeHtml(connected.summary)}` : ""}</p>
         <form method="post" action="/connections/${encodeURIComponent(connected.id)}/disconnect${q}"><button type="submit" class="secondary-btn">Disconnect</button></form></div>`;
  const cards = Object.entries(PROVIDERS).map(([id, provider]) => {
    // Providers with several accounts list each one, then always offer to add another.
    const mine = provider.multi ? Object.values(connections).filter(c => c.provider === id) : [];
    const connected = provider.multi ? null : connections[id];
    const action = `/connections/${id}${q}`;
    // A capped provider (YouTube: 5 channels) shows its count; at the cap the button only refreshes.
    const full = provider.maxConnections && mine.length >= provider.maxConnections;
    const count = provider.maxConnections && mine.length ? `<p class="muted">${mine.length} of ${provider.maxConnections} ${id === "youtube" ? "channels" : "connections"} connected.${full ? " Disconnect one to add another; signing in again with a connected one refreshes it." : ""}</p>` : "";
    const body = connected
      ? entry(connected)
      : (id === "google_account" ? mainEntry(mainGoogle) : "") + mine.map(entry).join("") + count + (provider.oauth
        ? oauthReady(provider)
          ? `<p>${escapeHtml(provider.help)}</p><a class="cta" href="/connections/${id}/start?t=${encodeURIComponent(t)}">${escapeHtml(full ? "Refresh a connected channel" : provider.oauth.buttonLabel || `Connect ${provider.name}`)}</a>`
          : `<p>${escapeHtml(provider.name)} isn’t set up on this server yet.</p>`
      : `<p>${escapeHtml(provider.help)} <a href="${escapeHtml(provider.helpUrl)}" target="_blank" rel="noopener">Open ${escapeHtml(provider.name)} ↗</a></p>
         <form method="post" action="${action}" class="connect-form">
           ${provider.fields.map(field => `<label>${escapeHtml(field.label)}${field.optional ? " <span>(optional)</span>" : ""}
             <input name="${field.key}" type="${field.secret ? "password" : "text"}" autocomplete="off" placeholder="${escapeHtml(field.placeholder || "")}" ${field.optional ? "" : "required"} maxlength="4000"></label>`).join("")}
           <button type="submit" class="cta">${provider.multi ? "Add" : "Connect"} ${escapeHtml(provider.name)}</button>
         </form>`);
    return `<div class="card"><span class="tag">${escapeHtml(provider.category)}</span><h3>${escapeHtml(provider.name)}</h3>${body}</div>`;
  }).join("\n");
  return layout("Connections", `
<style>
.status.ok{color:var(--accent);font-weight:600}
.status.expired{color:#d03b3b;font-weight:600}
.entry{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)}
.entry p{margin:0}
.connect-form{display:grid;gap:10px;margin-top:8px}
.connect-form label{display:grid;gap:4px;font-size:13.5px;font-weight:600;color:var(--ink)}
.connect-form label span{font-weight:400;color:var(--muted)}
.connect-form input{font:inherit;padding:9px 11px;border-radius:10px;border:1px solid var(--border);background:var(--page);color:var(--ink)}
.connect-form .cta{justify-self:start;border:0;cursor:pointer}
.secondary-btn{font:inherit;font-weight:600;padding:8px 14px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--ink);cursor:pointer}
.notice{padding:12px 14px;border-radius:12px;margin:14px 0;background:var(--surface);border:1px solid var(--border)}
.notice.error{border-color:#d03b3b;color:var(--ink)}
.connect-form select{font:inherit;padding:9px 11px;border-radius:10px;border:1px solid var(--border);background:var(--page);color:var(--ink)}
.connect-form fieldset{border:1px solid var(--border);border-radius:10px;padding:8px 12px;display:grid;gap:6px}
.connect-form label.check{display:flex;gap:8px;align-items:center;font-weight:400}
.card details summary{cursor:pointer;font-weight:600;margin:6px 0}
.url{display:grid;gap:4px;font-size:13.5px;font-weight:600;margin:8px 0}
.url input{font:13px/1.4 ui-monospace,monospace;padding:9px 11px;border-radius:10px;border:1px solid var(--border);background:var(--page);color:var(--ink);width:100%}
.plain{margin:6px 0;padding-left:18px}
.warn{color:#d03b3b}
.muted{color:var(--muted);font-size:13.5px;margin:0;flex-basis:100%}
</style>
<h1>Your connections</h1>
<p class="lead">Connect more platforms to Marketer Companion. Keys are encrypted and only used to answer your requests. This private page link expires 30 minutes after it was created; ask your assistant for a new one any time.</p>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}${error ? `<p class="notice error">${escapeHtml(error)}</p>` : ""}
${cards}
${profilesSection(q, base, profiles, connections, mainGoogle)}
<p>After connecting, go back to your chat and ask, for example, <em>“Show my Bing search queries”</em> or <em>“What do Clarity rage clicks say about my site?”</em> With extra Google, Meta or CallRail accounts, just name the property, site, ad account or company: your assistant uses whichever account can see it.</p>`);
}

export function registerConnectionRoutes(app, { store, seal, open, baseUrl }) {
  const send = (res, status, html) => res.status(status).set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer").type("html").send(html);
  const expired = res => send(res, 401, layout("Link expired", `<h1>This link has expired</h1><p class="lead">Ask your assistant to “manage my connections” for a new private link.</p>`));
  const unavailable = res => send(res, 503, layout("Connections", `<h1>Connections aren’t set up yet</h1><p class="lead">This server has no connection store configured. Contact the server owner.</p>`));

  async function current(userId) {
    const ids = await store.list(userId);
    const entries = await Promise.all(ids.map(async id => [id, publicConnection(id, await store.get(userId, id))]));
    return Object.fromEntries(entries.filter(([, value]) => value));
  }

  app.get("/connections", async (req, res) => {
    if (!store) return unavailable(res);
    const link = readLink(open, req.query.t);
    if (!link) return expired(res);
    const done = PROVIDERS[baseProvider(req.query.connected)]?.name;
    const removed = PROVIDERS[baseProvider(req.query.disconnected)]?.name;
    const saved = req.query.profile_saved ? String(req.query.profile_saved).slice(0, 60) : null;
    const deleted = req.query.profile_deleted ? String(req.query.profile_deleted).slice(0, 60) : null;
    const info = await store.getAccountInfo(link.userId);
    send(res, 200, page(req.query.t, await current(link.userId), {
      profiles: await store.listProfiles(link.userId), base: baseUrl(req), mainGoogle: info?.googleEmail || null,
      notice: req.query.refreshed && done === "YouTube" ? "This YouTube channel was already connected, so its sign-in was refreshed instead of adding another. To add a different channel, pick it in Google’s chooser (or “Use another account” for a channel on another Google account)."
        : req.query.refreshed && done ? `This ${done} was already connected, so its sign-in was refreshed instead of adding another. To add a different account, choose “Use another account” in Google’s account picker.`
        : req.query.main ? "That’s your main sign-in, which is already connected. To add a different account, choose “Use another account” in Google’s account picker."
        : done ? `${done} is connected.` : removed ? `${removed} was disconnected and its key deleted.`
        : saved ? `Profile “${saved}” saved. Copy its connector URL into your assistant.` : deleted ? `Profile “${deleted}” deleted. Remove its connector from your assistant too.` : undefined,
      error: req.query.error ? String(req.query.error).slice(0, 200) : undefined
    }));
  });

  // Profiles. Registered before /connections/:provider so "profiles" is never read as a platform.
  app.post("/connections/profiles/save", async (req, res) => {
    if (!store) return unavailable(res);
    const link = readLink(open, req.query.t);
    if (!link) return expired(res);
    const back = params => res.redirect(303, `/connections?t=${encodeURIComponent(req.query.t)}&${new URLSearchParams(params)}`);
    const body = req.body || {};
    const slug = String(body.slug || "");
    if (slug && !SLUG_PATTERN.test(slug)) return back({ error: "That profile no longer exists." });
    const existing = slug ? await store.getProfile(link.userId, slug) : null;
    if (slug && !existing) return back({ error: "That profile no longer exists." });
    if (!existing && (await store.listProfiles(link.userId)).length >= MAX_PROFILES) return back({ error: `You can have up to ${MAX_PROFILES} profiles.` });
    const connections = await current(link.userId);
    const choices = accountChoices(connections, (await store.getAccountInfo(link.userId))?.googleEmail);
    const input = {
      name: body.name, platforms: body.platform, youtubeChannel: body.youtube_channel,
      accounts: Object.fromEntries(Object.keys(PROFILE_FAMILIES).map(family => [family, body[`account_${family}`]])),
      defaults: Object.fromEntries(Object.entries(PROFILE_DEFAULTS).map(([family, fields]) => [family, Object.fromEntries(Object.keys(fields).map(arg => [arg, body[`default_${family}_${arg}`]]))]))
    };
    const built = buildProfile(input, {
      accountOptions: Object.fromEntries(Object.entries(choices).map(([family, list]) => [family, list.map(([value]) => value)])),
      labels: Object.fromEntries(Object.entries(choices).map(([family, list]) => [family, Object.fromEntries(list.map(([value, label]) => [value, value === "main" ? "Main sign-in" : label]))])),
      platformOptions: platformChoices(connections).map(([id]) => id),
      youtubeOptions: youtubeChoices(connections),
      existing
    });
    if (built.error) return back({ error: built.error });
    await store.saveProfile(link.userId, built.profile);
    back({ profile_saved: built.profile.name });
  });

  app.post("/connections/profiles/:slug/delete", async (req, res) => {
    if (!store) return unavailable(res);
    const link = readLink(open, req.query.t);
    if (!link) return expired(res);
    const slug = String(req.params.slug);
    const profile = SLUG_PATTERN.test(slug) ? await store.getProfile(link.userId, slug) : null;
    if (profile) await store.removeProfile(link.userId, slug);
    res.redirect(303, `/connections?t=${encodeURIComponent(req.query.t)}&${new URLSearchParams(profile ? { profile_deleted: profile.name } : { error: "That profile no longer exists." })}`);
  });

  app.post("/connections/:provider", async (req, res) => {
    if (!store) return unavailable(res);
    const link = readLink(open, req.query.t);
    if (!link) return expired(res);
    const provider = PROVIDERS[req.params.provider];
    if (!provider) return res.status(404).send("Unknown platform");
    const back = params => res.redirect(303, `/connections?t=${encodeURIComponent(req.query.t)}&${new URLSearchParams(params)}`);
    const credentials = Object.fromEntries(provider.fields.map(field => [field.key, String(req.body?.[field.key] ?? "").trim()]).filter(([, value]) => value));
    const missing = provider.fields.find(field => !field.optional && !credentials[field.key]);
    if (missing) return back({ error: `${missing.label} is required.` });
    let check;
    try { check = await provider.verify(credentials); } catch { check = { ok: false, message: `${provider.name} could not be reached. Try again.` }; }
    if (!check.ok) return back({ error: check.message });
    const id = provider.multi ? `${req.params.provider}:${provider.instance(credentials)}` : req.params.provider;
    await store.save(link.userId, id, { credentials, label: check.label, summary: check.summary, meta: check.meta, connectedAt: Date.now() });
    back({ connected: req.params.provider });
  });

  // Sign-in platforms: send the user to the platform's consent screen. The state carries the
  // private link, so the return lands back on this user's Connections page.
  app.get("/connections/:provider/start", (req, res) => {
    if (!store) return unavailable(res);
    const link = readLink(open, req.query.t);
    if (!link) return expired(res);
    const provider = PROVIDERS[req.params.provider];
    if (!provider?.oauth || !oauthReady(provider)) return res.status(404).send("This platform can’t be connected by sign-in here.");
    const state = seal({ typ: "connections_oauth", provider: req.params.provider, t: String(req.query.t), exp: Date.now() + STATE_TTL_MS });
    res.set("Cache-Control", "no-store").redirect(302, authorizeUrl(provider, { redirectUri: `${baseUrl(req)}${CALLBACK_PATH}`, state }));
  });

  app.get(CALLBACK_PATH, async (req, res) => {
    if (!store) return unavailable(res);
    let state;
    try { state = open(String(req.query.state || "")); } catch { state = null; }
    if (state?.typ !== "connections_oauth" || !(state.exp > Date.now())) return expired(res);
    const link = readLink(open, state.t);
    if (!link) return expired(res);
    const providerId = state.provider, provider = PROVIDERS[providerId];
    const back = params => res.redirect(303, `/connections?t=${encodeURIComponent(state.t)}&${new URLSearchParams(params)}`);
    if (!provider?.oauth) return back({ error: "Unknown platform." });
    if (req.query.error) return back({ error: req.query.error === "access_denied" ? `${provider.name} wasn’t connected: access was not granted.` : `${provider.name} sign-in failed (${String(req.query.error).slice(0, 80)}).` });
    try {
      const oauth = await exchangeCode(provider, String(req.query.code || ""), `${baseUrl(req)}${CALLBACK_PATH}`);
      const described = provider.describe ? await provider.describe(oauth.accessToken) : { ok: true };
      if (!described.ok) return back({ error: described.message });
      const id = provider.multi ? `${providerId}:${described.instance}` : providerId;
      // The main sign-in is already connected; adding it again would only duplicate it.
      const mainGoogle = providerId === "google_account" ? (await store.getAccountInfo(link.userId))?.googleEmail : null;
      if (mainGoogle && described.label && mainGoogle.toLowerCase() === String(described.label).toLowerCase()) return back({ main: "1" });
      // A channel connected before several were allowed is stored as plain "youtube"; the same
      // channel signing in again moves to its own ID (and profiles follow it).
      const legacy = providerId === "youtube" ? await store.get(link.userId, "youtube") : null;
      const legacySame = Boolean(legacy && described.meta?.channelId && legacy.meta?.channelId === described.meta.channelId);
      const existed = provider.multi && (legacySame || Boolean(await store.get(link.userId, id)));
      if (!existed && provider.maxConnections) {
        const count = (await store.list(link.userId)).filter(other => other === providerId || other.startsWith(`${providerId}:`)).length;
        if (count >= provider.maxConnections) return back({ error: `You can connect up to ${provider.maxConnections} ${providerId === "youtube" ? "YouTube channels" : `${provider.name} accounts`}. Disconnect one to add another.` });
      }
      await store.save(link.userId, id, { oauth, label: described.label, summary: described.summary, meta: described.meta, connectedAt: Date.now() });
      if (legacySame) {
        await store.remove(link.userId, "youtube");
        for (const profile of await store.listProfiles(link.userId)) {
          if (profile.youtubeChannel === "youtube") await store.saveProfile(link.userId, { ...profile, youtubeChannel: id });
        }
      }
      back({ connected: providerId, ...(existed ? { refreshed: "1" } : {}) });
    } catch (error) {
      back({ error: `${provider.name} couldn’t be connected: ${String(error.message).slice(0, 160)}` });
    }
  });

  app.post("/connections/:provider/disconnect", async (req, res) => {
    if (!store) return unavailable(res);
    const link = readLink(open, req.query.t);
    if (!link) return expired(res);
    const id = String(req.params.provider);
    if (!PROVIDERS[baseProvider(id)]) return res.status(404).send("Unknown platform");
    await store.remove(link.userId, id);
    res.redirect(303, `/connections?t=${encodeURIComponent(req.query.t)}&disconnected=${encodeURIComponent(baseProvider(id))}`);
  });
}
