// The Connections page: where a signed-in user connects or disconnects extra platforms.
// It opens from a private link that ChatGPT/Claude gets from the manage_connections tool
// (an encrypted, 30-minute token naming the user), so there is no separate login and nothing
// is added to the app's own sign-in flow. Secrets are never shown back.
import { layout, escapeHtml } from "../pages.js";
import { PROVIDERS, publicConnection } from "./providers.js";

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

function page(t, connections, { notice, error } = {}) {
  const cards = Object.entries(PROVIDERS).map(([id, provider]) => {
    const connected = connections[id];
    const action = `/connections/${id}?t=${encodeURIComponent(t)}`;
    const body = connected
      ? `<p class="status ok">Connected${connected.label ? ` · ${escapeHtml(connected.label)}` : ""}${connected.summary ? ` · ${escapeHtml(connected.summary)}` : ""}</p>
         <form method="post" action="${action}/disconnect"><button type="submit" class="secondary-btn">Disconnect</button></form>`
      : `<p>${escapeHtml(provider.help)} <a href="${escapeHtml(provider.helpUrl)}" target="_blank" rel="noopener">Open ${escapeHtml(provider.name)} ↗</a></p>
         <form method="post" action="${action}" class="connect-form">
           ${provider.fields.map(field => `<label>${escapeHtml(field.label)}${field.optional ? " <span>(optional)</span>" : ""}
             <input name="${field.key}" type="${field.secret ? "password" : "text"}" autocomplete="off" placeholder="${escapeHtml(field.placeholder || "")}" ${field.optional ? "" : "required"} maxlength="4000"></label>`).join("")}
           <button type="submit" class="cta">Connect ${escapeHtml(provider.name)}</button>
         </form>`;
    return `<div class="card"><span class="tag">${escapeHtml(provider.category)}</span><h3>${escapeHtml(provider.name)}</h3>${body}</div>`;
  }).join("\n");
  return layout("Connections", `
<style>
.status.ok{color:var(--accent);font-weight:600}
.connect-form{display:grid;gap:10px;margin-top:8px}
.connect-form label{display:grid;gap:4px;font-size:13.5px;font-weight:600;color:var(--ink)}
.connect-form label span{font-weight:400;color:var(--muted)}
.connect-form input{font:inherit;padding:9px 11px;border-radius:10px;border:1px solid var(--border);background:var(--page);color:var(--ink)}
.connect-form .cta{justify-self:start;border:0;cursor:pointer}
.secondary-btn{font:inherit;font-weight:600;padding:8px 14px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--ink);cursor:pointer}
.notice{padding:12px 14px;border-radius:12px;margin:14px 0;background:var(--surface);border:1px solid var(--border)}
.notice.error{border-color:#d03b3b;color:var(--ink)}
</style>
<h1>Your connections</h1>
<p class="lead">Connect more platforms to Marketer Companion. Keys are encrypted and only used to answer your requests. This private page link expires 30 minutes after it was created; ask your assistant for a new one any time.</p>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}${error ? `<p class="notice error">${escapeHtml(error)}</p>` : ""}
${cards}
<p>After connecting, go back to your chat and ask, for example, <em>“Show my Bing search queries”</em> or <em>“What do Clarity rage clicks say about my site?”</em></p>`);
}

export function registerConnectionRoutes(app, { store, seal, open }) {
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
    const done = PROVIDERS[req.query.connected]?.name;
    const removed = PROVIDERS[req.query.disconnected]?.name;
    send(res, 200, page(req.query.t, await current(link.userId), {
      notice: done ? `${done} is connected.` : removed ? `${removed} was disconnected and its key deleted.` : undefined,
      error: req.query.error ? String(req.query.error).slice(0, 200) : undefined
    }));
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
    await store.save(link.userId, req.params.provider, { credentials, summary: check.summary, meta: check.meta, connectedAt: Date.now() });
    back({ connected: req.params.provider });
  });

  app.post("/connections/:provider/disconnect", async (req, res) => {
    if (!store) return unavailable(res);
    const link = readLink(open, req.query.t);
    if (!link) return expired(res);
    if (!PROVIDERS[req.params.provider]) return res.status(404).send("Unknown platform");
    await store.remove(link.userId, req.params.provider);
    res.redirect(303, `/connections?t=${encodeURIComponent(req.query.t)}&disconnected=${req.params.provider}`);
  });
}
