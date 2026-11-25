// The Connections page: where a signed-in user connects or disconnects extra platforms.
// It opens from a private link that ChatGPT/Claude gets from the manage_connections tool
// (an encrypted, 30-minute token naming the user), so there is no separate login and nothing
// is added to the app's own sign-in flow. Secrets are never shown back.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { layout } from "../pages.js";
import { PROVIDERS, publicConnection, baseProvider } from "./providers.js";
import { oauthReady, authorizeUrl, exchangeCode, STATE_TTL_MS, CALLBACK_PATH } from "./oauth.js";
import { PROFILE_FAMILIES, PROFILE_DEFAULTS, MAX_PROFILES, SLUG_PATTERN, buildProfile } from "./profiles.js";
import { ANIME_PATH, accountChoices, clarityChoices, page, platformChoices, youtubeChoices } from "./_page.js";
import { splitUserId } from "./_assistants.js";

// Anime.js for the page's motion, served from this server (no third-party request from a page that
// holds a private link). Missing file: the page still works, without animation.
const ANIME_FILE = "node_modules/animejs/dist/bundles/anime.umd.min.js";
function loadAnime() {
  const candidates = [path.join(process.cwd(), ANIME_FILE), new URL(`../../${ANIME_FILE}`, import.meta.url)];
  try { candidates.push(path.join(path.dirname(createRequire(import.meta.url).resolve("animejs/package.json")), "dist/bundles/anime.umd.min.js")); } catch { /* not resolvable here */ }
  for (const file of candidates) {
    try { return fs.readFileSync(file); } catch { /* try the next place */ }
  }
  return null;
}
const animeScript = loadAnime();

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

export function registerConnectionRoutes(app, { store, seal, open, baseUrl }) {
  const send = (res, status, html) => res.status(status).set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer").type("html").send(html);
  const expired = res => send(res, 401, layout("Link expired", `<h1>This link has expired</h1><p class="lead">Ask your assistant to “manage my connections” for a new private link.</p>`));
  const unavailable = res => send(res, 503, layout("Connections", `<h1>Connections aren’t set up yet</h1><p class="lead">This server has no connection store configured. Contact the server owner.</p>`));

  async function current(userId) {
    const ids = await store.list(userId);
    const entries = await Promise.all(ids.map(async id => [id, publicConnection(id, await store.get(userId, id))]));
    return Object.fromEntries(entries.filter(([, value]) => value));
  }

  app.get(ANIME_PATH, (req, res) => {
    if (!animeScript) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=31536000, immutable").type("application/javascript").send(animeScript);
  });

  app.get("/connections", async (req, res) => {
    if (!store) return unavailable(res);
    const link = readLink(open, req.query.t);
    if (!link) return expired(res);
    const connectedId = req.query.connected ? baseProvider(req.query.connected) : null;
    const done = PROVIDERS[connectedId]?.name;
    const removed = PROVIDERS[baseProvider(req.query.disconnected)]?.name;
    const saved = req.query.profile_saved ? String(req.query.profile_saved).slice(0, 60) : null;
    const deleted = req.query.profile_deleted ? String(req.query.profile_deleted).slice(0, 60) : null;
    const failedOn = PROVIDERS[req.query.p] ? String(req.query.p) : null;
    const text = req.query.error ? String(req.query.error).slice(0, 200)
      : req.query.refreshed && connectedId === "youtube" ? "This YouTube channel was already connected, so its sign-in was refreshed instead of adding another. To add a different channel, pick it in Google’s chooser (or “Use another account” for a channel on another Google account)."
      : req.query.refreshed && connectedId === "clarity" ? "This Clarity token was already connected, so its details were updated instead of adding another. To add another project, generate a token in that project."
      : req.query.refreshed && done ? `This ${done} was already connected, so its sign-in was refreshed instead of adding another. To add a different account, choose “Use another account” in Google’s account picker.`
      : req.query.main ? "That’s your main sign-in, which is already connected. To add a different account, choose “Use another account” in Google’s account picker."
      : done ? `${done} is connected.` : removed ? `${removed} was disconnected and its key deleted.`
      : saved ? `Profile “${saved}” saved. Copy its connector URL into your assistant.` : deleted ? `Profile “${deleted}” deleted. Remove its connector from your assistant too.` : null;
    const kind = req.query.error ? "error" : req.query.refreshed || req.query.main ? "info" : "success";
    const info = await store.getAccountInfo(link.userId);
    // Connections are kept per assistant; ones made before that wait to be moved to one of them.
    const who = splitUserId(link.userId);
    const earlier = who ? (await store.list(who.account)).length + (await store.listProfiles(who.account)).length : 0;
    const moved = req.query.moved !== undefined ? Number(req.query.moved) || 0 : null;
    const message = moved !== null ? `Moved ${moved} connection${moved === 1 ? "" : "s"} to ${who?.name || "this assistant"}. Other assistants no longer see them.` : text;
    send(res, 200, page(req.query.t, await current(link.userId), {
      profiles: await store.listProfiles(link.userId), base: baseUrl(req), mainGoogle: info?.googleEmail || null,
      linkExpiresAt: new Date(link.exp).toISOString(), assistant: who?.name || null, earlier,
      toast: message ? { kind: moved !== null ? "success" : kind, text: message, provider: req.query.error ? failedOn : connectedId && !req.query.main ? connectedId : null } : null
    }));
  });

  // Moves connections made before they were kept per assistant into this assistant's store.
  // Registered before /connections/:provider so "claim" is never read as a platform.
  app.post("/connections/claim", async (req, res) => {
    if (!store) return unavailable(res);
    const link = readLink(open, req.query.t);
    if (!link) return expired(res);
    const who = splitUserId(link.userId);
    if (!who) return res.redirect(303, `/connections?t=${encodeURIComponent(req.query.t)}`);
    const moved = await store.moveUser(who.account, link.userId);
    res.redirect(303, `/connections?t=${encodeURIComponent(req.query.t)}&moved=${moved}`);
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
      name: body.name, platforms: body.platform, youtubeChannel: body.youtube_channel, clarityProject: body.clarity_project,
      accounts: Object.fromEntries(Object.keys(PROFILE_FAMILIES).map(family => [family, body[`account_${family}`]])),
      defaults: Object.fromEntries(Object.entries(PROFILE_DEFAULTS).map(([family, fields]) => [family, Object.fromEntries(Object.keys(fields).map(arg => [arg, body[`default_${family}_${arg}`]]))]))
    };
    const built = buildProfile(input, {
      accountOptions: Object.fromEntries(Object.entries(choices).map(([family, list]) => [family, list.map(([value]) => value)])),
      labels: Object.fromEntries(Object.entries(choices).map(([family, list]) => [family, Object.fromEntries(list.map(([value, label]) => [value, value === "main" ? "Main sign-in" : label]))])),
      platformOptions: platformChoices(connections).map(([id]) => id),
      youtubeOptions: youtubeChoices(connections),
      clarityOptions: clarityChoices(connections),
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
    // A checkbox is stored as "on" or "off", so an unticked box is told apart from an older record without it.
    const credentials = Object.fromEntries(provider.fields.map(field => [field.key, field.checkbox ? (req.body?.[field.key] ? "on" : "off") : String(req.body?.[field.key] ?? "").trim()]).filter(([, value]) => value));
    const missing = provider.fields.find(field => !field.optional && !credentials[field.key]);
    if (missing) return back({ error: `${missing.label} is required.` });
    let check;
    try { check = await provider.verify(credentials); } catch { check = { ok: false, message: `${provider.name} could not be reached. Try again.` }; }
    if (!check.ok) return back({ error: check.message });
    const id = provider.multi ? `${req.params.provider}:${provider.instance(credentials)}` : req.params.provider;
    const existed = provider.multi && Boolean(await store.get(link.userId, id));
    if (!existed && provider.maxConnections) {
      const count = (await store.list(link.userId)).filter(other => other === req.params.provider || other.startsWith(`${req.params.provider}:`)).length;
      if (count >= provider.maxConnections) return back({ error: `You can connect up to ${provider.maxConnections} ${provider.name} ${req.params.provider === "clarity" ? "projects" : "accounts"}. Disconnect one to add another.` });
    }
    await store.save(link.userId, id, { credentials, label: check.label, summary: check.summary, meta: check.meta, connectedAt: Date.now() });
    await provider.afterSave?.({ store, userId: link.userId, id, credentials });
    back({ connected: req.params.provider, ...(existed ? { refreshed: "1" } : {}) });
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
    const back = params => res.redirect(303, `/connections?t=${encodeURIComponent(state.t)}&${new URLSearchParams(params.error && PROVIDERS[state.provider] ? { ...params, p: state.provider } : params)}`);
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
