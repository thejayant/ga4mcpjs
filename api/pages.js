// Public pages a ChatGPT plugin listing needs: an install guide for end users, the
// privacy policy and terms the plugin manifest links to, and OpenAI's domain
// verification challenge. Static HTML; nothing here reads user data.

import { buildPluginZip } from "../plugin/zip.js";

const OWNER = "Jayant Solanki";
const OWNER_SITE = "https://thejayant.in";
const UPDATED = "1 October 2026";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function contact() {
  const email = process.env.SUPPORT_EMAIL;
  return email
    ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
    : `the contact details on <a href="${OWNER_SITE}">thejayant.in</a>`;
}

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Marketer Companion</title>
<style>
:root{color-scheme:light;--page:#f6f6f3;--surface:#fff;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;--border:rgba(11,11,11,.1);--accent:#1f8f53;--code:#f1f0ec}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink-2:#c3c2b7;--muted:#898781;--border:rgba(255,255,255,.1);--accent:#3ccf7f;--code:#232321}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 20px 64px}
header{display:flex;align-items:center;gap:12px;margin-bottom:28px}
header svg{width:40px;height:40px;flex:none}
header a{color:inherit;text-decoration:none;font-weight:700}
nav.links{margin-left:auto;display:flex;gap:14px;font-size:13.5px}
nav.links a{font-weight:500;color:var(--ink-2)}
h1{font-size:30px;letter-spacing:-.6px;line-height:1.15;margin:0 0 8px}
h2{font-size:19px;margin:34px 0 8px}
h3{font-size:16px;margin:22px 0 6px}
p,li{color:var(--ink-2)}
a{color:var(--accent)}
.lead{font-size:16.5px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px 20px;margin:14px 0}
.card h3{margin-top:0}
.tag{display:inline-block;font-size:11.5px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:var(--accent);margin-bottom:4px}
ol,ul{padding-left:22px}
li{margin:4px 0}
code{background:var(--code);padding:2px 6px;border-radius:6px;font-size:13.5px;word-break:break-all}
.copy{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--code);border-radius:12px;padding:10px 12px;margin:10px 0}
.copy code{background:none;padding:0;flex:1;min-width:0;white-space:pre-wrap}
.jump{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 6px}
.jump a{border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:5px 12px;font-size:13.5px;font-weight:600;text-decoration:none}
h2[id]{scroll-margin-top:16px}
.copy button{border:0;background:var(--accent);color:#fff;font:inherit;font-weight:600;font-size:13px;padding:6px 12px;border-radius:8px;cursor:pointer}
.needs{font-size:14.5px}
.pick{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:10px 0 8px}
.pick-option{display:flex;flex-direction:column;gap:2px;padding:18px 20px;border-radius:16px;border:2px solid var(--border);background:var(--surface);color:var(--ink);text-decoration:none;transition:border-color .2s,transform .2s}
.pick-option strong{font-size:19px}
.pick-option span{font-size:13.5px;color:var(--ink-2)}
.pick-option:hover{border-color:var(--accent);transform:translateY(-1px)}
.pick-option[aria-selected=true]{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
body[data-app=claude] #chatgpt,body[data-app=chatgpt] #claude{display:none}
.app{scroll-margin-top:16px}
.steps{list-style:none;padding:0;margin:16px 0;display:grid;gap:12px}
.step{display:grid;grid-template-columns:36px 1fr;gap:14px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:16px 18px}
.step p{margin:4px 0}
.num{width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;display:grid;place-items:center}
.cta{display:inline-block;margin:10px 0 4px;padding:12px 22px;border-radius:12px;background:var(--accent);color:#fff;font-weight:700;font-size:16px;text-decoration:none}
.cta:hover{filter:brightness(1.08)}
.cta.secondary{background:transparent;color:var(--accent);border:2px solid var(--accent);font-size:15px;padding:9px 18px}
.field{margin:12px 0 0;font-weight:600;color:var(--ink)}
.hint{font-size:13.5px}
.more{margin:14px 0;border:1px solid var(--border);border-radius:14px;background:var(--surface);padding:12px 18px}
.more summary{cursor:pointer;font-weight:600}
.more[open] summary{margin-bottom:8px}
.dev{margin-top:36px}
footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}
</style></head><body><main>
<header><svg viewBox="0 0 600 600" aria-hidden="true"><rect width="600" height="600" rx="150" fill="#25bd63"/><path d="M162 293h62l43-128 78 250 40-122h60" fill="none" stroke="#fff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/></svg>
<a href="/install">Marketer Companion</a>
<nav class="links"><a href="/install">Install</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></header>
${body}
<footer>Marketer Companion is built by <a href="${OWNER_SITE}">${OWNER}</a>. It is not affiliated with or endorsed by OpenAI, Google, Meta or CallRail.</footer>
</main></body></html>`;
}

// A command or URL with a copy button. Copies the text exactly as shown.
const copyBlock = (text) => `<div class="copy"><code>${escapeHtml(text)}</code><button type="button" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent).then(()=>{this.textContent='Copied';setTimeout(()=>{this.textContent='Copy'},1600)})">Copy</button></div>`;

const PRODUCTION_URL = "https://ga4mcpjs.vercel.app";
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

// The address people paste into AI tools. Those tools only accept public HTTPS, so the
// page never shows http:// or a local address: it uses PUBLIC_BASE_URL when set, otherwise
// this deployment's host over HTTPS, and the production URL when running locally.
export function publicBaseUrl(baseUrl) {
  const configured = process.env.PUBLIC_BASE_URL;
  const url = new URL(configured || baseUrl);
  if (!configured && LOOPBACK.includes(url.hostname)) return PRODUCTION_URL;
  url.protocol = "https:";
  return url.origin;
}

// A big call-to-action link styled as a button.
const button = (href, text, { primary = true, download = false } = {}) => `<a class="cta${primary ? "" : " secondary"}" href="${escapeHtml(href)}"${download ? " download" : ' target="_blank" rel="noopener"'}>${text}</a>`;
const step = (n, body) => `<li class="step"><span class="num">${n}</span><div>${body}</div></li>`;

// Claude opens its "Add custom connector" box with the name and address filled in, or the
// directory listing once there is one. Organization owners get the org-wide form.
export function claudeInstallLink(site, { organization = false } = {}) {
  if (!organization && process.env.CLAUDE_DIRECTORY_URL) return process.env.CLAUDE_DIRECTORY_URL;
  const query = `connectorName=${encodeURIComponent("Marketer Companion")}&connectorUrl=${encodeURIComponent(`${site}/mcp`)}`;
  return `https://claude.ai/${organization ? "admin-settings" : "customize"}/connectors?modal=add-custom-connector&${query}`;
}

// The install guide is written for people who have never added an integration: pick your
// app, then follow a few numbered steps. Developer setups sit in a collapsed section.
function installPage(baseUrl) {
  const site = publicBaseUrl(baseUrl);
  const mcpUrl = `${site}/mcp`;
  const name = "marketer-companion";
  const display = "Marketer Companion";
  const claudeLink = claudeInstallLink(site);
  const claudeOrgLink = claudeInstallLink(site, { organization: true });
  const claudeListed = Boolean(process.env.CLAUDE_DIRECTORY_URL);
  // Only advertise the ChatGPT directory once the listing is actually live.
  const chatgptListed = process.env.PLUGIN_DIRECTORY_LIVE === "true";
  const zipUrl = `${site}/download/plugin.zip`;
  const ask = "Open my marketing dashboard";
  const claudeAdminNote = `Hi! Could you add Marketer Companion to our Claude organization? It is a read-only marketing reporting connector. This link opens the form with everything filled in: ${claudeOrgLink}  (Guide: ${site}/install#claude)`;
  const chatgptAdminNote = `Hi! Could you add Marketer Companion to our ChatGPT workspace? Download the plugin file from ${zipUrl}, then go to Workspace settings → Plugins → Add → Upload plugin, and set it to Available. It is a read-only marketing reporting plugin. (Guide: ${site}/install#chatgpt)`;
  const prompt = `Add the remote MCP server "${name}" at ${mcpUrl} (HTTP transport, OAuth sign-in) to your MCP settings, then start the sign-in so I can connect my Google account.`;

  return layout("Install", `
<h1>Add Marketer Companion to your AI assistant</h1>
<p class="lead">See your GA4, Search Console, Google Ads, Merchant Center, Business Profile and CallRail numbers by asking in chat. Setup takes about two minutes and needs no technical knowledge.</p>
<p class="needs">You need: the Google account that can see your marketing data.</p>

<h2 class="pick-title">Which app do you use?</h2>
<div class="pick" role="tablist">
  <a class="pick-option" href="#claude" data-app="claude" role="tab"><strong>Claude</strong><span>claude.ai or the Claude desktop app</span></a>
  <a class="pick-option" href="#chatgpt" data-app="chatgpt" role="tab"><strong>ChatGPT</strong><span>chatgpt.com or the ChatGPT desktop app</span></a>
</div>

<section class="app" id="claude">
<h2>Add it to Claude</h2>
<ol class="steps">
${step(1, `<p>Click the button. Claude opens with everything filled in${claudeListed ? "" : " (sign in first if Claude asks)"}.</p>${button(claudeLink, claudeListed ? "Open Marketer Companion in Claude" : "Add to Claude")}`)}
${step(2, `<p>Click <strong>${claudeListed ? "Connect" : "Add"}</strong>${claudeListed ? "" : `, then <strong>Connect</strong> next to Marketer Companion`}.</p>`)}
${step(3, `<p>Choose your Google account and click <strong>Allow</strong>. If you are asked about CallRail and don't use it, click <strong>Skip</strong>.</p>`)}
${step(4, `<p>Start a new chat and type:</p>${copyBlock(ask)}<p class="hint">Tip: name your website, for example <em>“Open my marketing dashboard for getcarports.com”</em>, and it picks that business’s accounts for you.</p><p class="hint">If Claude doesn't use it, click the <strong>+</strong> (or tools) button under the message box and switch on Marketer Companion.</p>`)}
</ol>
<details class="more"><summary>Using Claude at work (Team or Enterprise)?</summary>
<p>Only an organization owner can add connectors. If you are the owner, use this button instead:</p>
${button(claudeOrgLink, "Add for my organization", { primary: false })}
<p>Not the owner? Send them this message:</p>${copyBlock(claudeAdminNote)}
<p>On the free plan you can add one connector like this; paid plans can add more.</p>
</details>
</section>

<section class="app" id="chatgpt">
<h2>Add it to ChatGPT</h2>
${chatgptListed ? `<ol class="steps">
${step(1, `<p>In ChatGPT, open <strong>Plugins</strong> in the left sidebar and search for <strong>Marketer Companion</strong>.</p>${button("https://chatgpt.com", "Open ChatGPT")}`)}
${step(2, `<p>Click <strong>Install plugin</strong>, then <strong>Connect</strong>. Choose your Google account and click <strong>Allow</strong>.</p>`)}
${step(3, `<p>Start a new chat and type:</p>${copyBlock(ask)}<p class="hint">Tip: name your website, for example <em>“Open my marketing dashboard for getcarports.com”</em>, and it picks that business’s accounts for you.</p>`)}
</ol>
<details class="more"><summary>Can't find it in Plugins?</summary>` : `<p class="needs">Works with ChatGPT <strong>Plus</strong> or <strong>Pro</strong>, on chatgpt.com or the desktop app. It doesn't work in the phone app.</p>`}
<ol class="steps">
${step(1, `<p>Open ChatGPT, click your name in the bottom-left corner, then <strong>Settings → Security and login</strong>. Turn on <strong>Developer mode</strong>.</p>${button("https://chatgpt.com", "Open ChatGPT")}`)}
${step(2, `<p>Click <strong>Plugins</strong> in the left sidebar, then the <strong>+</strong> button, and choose <strong>Create app</strong>, then <strong>MCP app</strong>.</p>`)}
${step(3, `<p>Fill in the form. Copy each value with its button:</p>
<p class="field">Name</p>${copyBlock(display)}
<p class="field">MCP server URL</p>${copyBlock(mcpUrl)}
<p class="field">Authentication: choose <strong>OAuth</strong>. Tick the confirmation box if one appears, then click <strong>Create</strong>.</p>`)}
${step(4, `<p>Click <strong>Connect</strong>. Choose your Google account and click <strong>Allow</strong>. If you are asked about CallRail and don't use it, click <strong>Skip</strong>.</p>`)}
${step(5, `<p>Start a new chat and type:</p>${copyBlock(ask)}<p class="hint">Tip: name your website, for example <em>“Open my marketing dashboard for getcarports.com”</em>, and it picks that business’s accounts for you.</p>`)}
</ol>
${chatgptListed ? "</details>" : ""}
<details class="more"><summary>Using ChatGPT at work (Business, Enterprise or Edu)?</summary>
<p>Work accounts usually can't turn on developer mode; an admin adds the plugin once for everyone. If you are the admin, download the plugin file and upload it in <strong>Workspace settings → Plugins → Add → Upload plugin</strong>, then set it to <strong>Available</strong>:</p>
${button(zipUrl, "Download plugin file", { primary: false, download: true })}
<p>Not the admin? Send them this message:</p>${copyBlock(chatgptAdminNote)}
</details>
</section>

<h2>What happens next</h2>
<ul><li>The dashboard asks you to pick your accounts, one per tool, for the same business. Skip any tool you don't use.</li>
<li>Change the dates, add filters, or click <strong>Ask</strong> to get an explanation of what changed.</li>
<li>Google shows exactly what you are sharing before you click Allow. You can remove access any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</li></ul>

<h2 id="support">Something not working?</h2>
<ul><li><strong>I can't find Developer mode in ChatGPT</strong>: it needs a Plus or Pro plan. On a work account, send the message above to your admin.</li>
<li><strong>A tool says I don't have access</strong>: you signed in with a Google account that can't see that property. Remove Marketer Companion, add it again, and pick the right Google account.</li>
<li><strong>The dashboard looks out of date</strong>: start a new chat.</li>
<li><strong>Google Ads says quota exceeded</strong>: the shared daily Google Ads allowance ran out. Try again tomorrow.</li></ul>
<p>Still stuck? Contact ${contact()} and say which app you use and what you see.</p>

<details class="more dev" id="developers"><summary>For developers: Claude Code, Codex, Gemini CLI, Cursor and VS Code</summary>
<p>Server address (Streamable HTTP, OAuth 2.1 with dynamic client registration):</p>${copyBlock(mcpUrl)}
<h3>Claude Code</h3>${copyBlock(`claude mcp add --transport http ${name} ${mcpUrl}`)}<p>Then run <code>/mcp</code>, choose <strong>${name}</strong> and select <strong>Authenticate</strong>.</p>
<h3>OpenAI Codex CLI</h3>${copyBlock(`codex mcp add ${name} --url ${mcpUrl}`)}${copyBlock(`codex mcp login ${name}`)}
<h3>Gemini CLI</h3>${copyBlock(`gemini mcp add --transport http ${name} ${mcpUrl}`)}<p>Gemini CLI opens the sign-in the first time it uses the server.</p>
<h3>Cursor</h3><p>Add to <code>~/.cursor/mcp.json</code>, then select <strong>Connect</strong> next to it:</p>${copyBlock(JSON.stringify({ mcpServers: { [name]: { url: mcpUrl } } }, null, 2))}
<h3>VS Code (Copilot agent mode)</h3>${copyBlock(`code --add-mcp '${JSON.stringify({ name, type: "http", url: mcpUrl })}'`)}
<h3>Let a coding agent do it</h3><p>Claude Code, Codex, Gemini CLI, Cursor and Copilot agent mode can edit their own settings. Paste this into one of them (chat apps like ChatGPT and Claude.ai cannot):</p>${copyBlock(prompt)}
<p>In terminals and editors you get the reports as text and tables; the interactive dashboard needs ChatGPT or Claude.</p>
</details>

<script>
// Show only the chosen app's steps. Without JavaScript both sections stay visible.
(function () {
  var options = document.querySelectorAll('.pick-option');
  function show(app) {
    if (app !== 'claude' && app !== 'chatgpt') return;
    document.body.setAttribute('data-app', app);
    options.forEach(function (o) { o.setAttribute('aria-selected', String(o.dataset.app === app)); });
  }
  options.forEach(function (o) { o.addEventListener('click', function (e) { e.preventDefault(); show(o.dataset.app); history.replaceState(null, '', '#' + o.dataset.app); document.getElementById(o.dataset.app).scrollIntoView({ behavior: 'smooth', block: 'start' }); }); });
  show(location.hash.slice(1));
})();
</script>`);
}

function privacyPage() {
  return layout("Privacy policy", `
<h1>Privacy policy</h1>
<p>Last updated ${UPDATED}. This policy covers the Marketer Companion ChatGPT plugin and its server (“the service”), operated by ${OWNER}.</p>

<h2>What the service accesses</h2>
<p>Only what you authorise when you connect:</p>
<ul><li><strong>Google</strong> (through Google sign-in): Google Analytics, Search Console, Google Ads, Merchant Center and Business Profile data for the accounts your Google user can access, and Tag Manager or BigQuery data where those features are enabled. Google shows the exact list before you approve.</li>
<li><strong>Meta</strong> (optional): ad account and page data, if you connect Meta.</li>
<li><strong>CallRail</strong> (optional): call data through an API key you enter.</li></ul>

<h2>How it is used</h2>
<p>Data is fetched only when you, or ChatGPT on your behalf, run a report or open the dashboard, and is used only to answer that request. The dashboard and reports are read-only. The service changes something only when you explicitly ask ChatGPT to: Google Business Profile actions such as replying to a review or publishing a post, creating a GA4 audience export, or registering the service with your Merchant Center account. ChatGPT asks you to confirm these actions.</p>
<p>Report results are returned to ChatGPT so it can show and discuss them with you. OpenAI's handling of conversation content is covered by OpenAI's own terms and privacy policy.</p>

<h2>What is stored</h2>
<ul><li>The service has no database. Report data is not stored after a request completes.</li>
<li>Your Google, Meta and CallRail credentials are encrypted (AES-256-GCM) inside the access and refresh tokens that ChatGPT keeps for your connection. Access tokens expire after 30 days and refresh tokens after 90 days.</li>
<li>A short-lived session cache may be held in server memory and is discarded when the server instance stops.</li>
<li>The hosting provider (Vercel) keeps standard request logs, such as time, path and status code, for operating and securing the service.</li></ul>

<h2>Sharing</h2>
<p>Your data is not sold, rented or used for advertising, and is not shared with anyone other than the providers needed to fulfil your request (Google, Meta, CallRail, OpenAI and the hosting provider).</p>

<h2>Google user data</h2>
<p>The service's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Google user data is not used to develop, improve or train generalised AI or machine-learning models, and humans do not read it except with your consent, for security, or where the law requires.</p>

<h2>Your choices</h2>
<ul><li>Disconnect the plugin in ChatGPT to stop all access.</li>
<li>Revoke Google access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, Meta access in your Facebook Business settings, and rotate your CallRail API key in CallRail.</li>
<li>Because nothing is stored in a database, disconnecting removes the service's ability to access your data.</li></ul>

<h2>Contact</h2>
<p>Questions about this policy: ${contact()}.</p>`);
}

function termsPage() {
  return layout("Terms of service", `
<h1>Terms of service</h1>
<p>Last updated ${UPDATED}. These terms apply to the Marketer Companion ChatGPT plugin and its server (“the service”), provided by ${OWNER}.</p>

<h2>Using the service</h2>
<ul><li>Connect only accounts you are authorised to access, and use the service in line with the terms of Google, Meta, CallRail and OpenAI.</li>
<li>You are responsible for decisions you make from the reports and from ChatGPT's analysis of them. Check important figures in the source platform.</li>
<li>Do not use the service to overload, probe or disrupt it or the APIs it calls.</li></ul>

<h2>Availability</h2>
<p>The service is provided free of charge, “as is” and “as available”, without warranties of any kind. Platform API limits, outages or policy changes can make sources temporarily unavailable. Features may change or be withdrawn.</p>

<h2>Liability</h2>
<p>To the extent the law allows, ${OWNER} is not liable for indirect or consequential losses, or for losses arising from data provided by third-party platforms.</p>

<h2>Privacy</h2>
<p>See the <a href="/privacy">privacy policy</a> for what the service accesses and stores.</p>

<h2>Contact</h2>
<p>${contact()}.</p>`);
}

export function registerPublicPages(app, { getBaseUrl }) {
  const send = (res, html) => res.set("Cache-Control", "public, max-age=300").type("html").send(html);
  app.get(["/install", "/support"], (req, res) => send(res, installPage(getBaseUrl(req))));
  app.get("/privacy", (req, res) => send(res, privacyPage()));
  app.get("/terms", (req, res) => send(res, termsPage()));
  // Short links to share: /claude goes straight to Claude's prefilled "Add connector" form.
  app.get("/claude", (req, res) => res.redirect(302, claudeInstallLink(publicBaseUrl(getBaseUrl(req)))));
  app.get("/chatgpt", (req, res) => res.redirect(302, "/install#chatgpt"));
  app.get(["/add", "/start"], (req, res) => res.redirect(302, "/install"));
  // The ChatGPT plugin package, built from the deployed files, for workspace admins.
  app.get("/download/plugin.zip", (req, res) => {
    const { fileName, buffer } = buildPluginZip();
    res.set("Content-Disposition", `attachment; filename="${fileName}"`).set("Cache-Control", "public, max-age=300").type("application/zip").send(buffer);
  });
  // OpenAI verifies plugin domain ownership by fetching this token over HTTPS.
  app.get("/.well-known/openai-apps-challenge", (req, res) => {
    const token = process.env.OPENAI_APPS_CHALLENGE;
    if (!token) return res.status(404).type("text").send("Not configured");
    res.set("Cache-Control", "no-store").type("text").send(token.trim());
  });
}
