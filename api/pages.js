// Public pages a ChatGPT plugin listing needs: an install guide for end users, the
// privacy policy and terms the plugin manifest links to, and OpenAI's domain
// verification challenge. Static HTML; nothing here reads user data.

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

function installPage(baseUrl) {
  const mcpUrl = `${publicBaseUrl(baseUrl)}/mcp`;
  const name = "marketer-companion";
  // Only advertise the ChatGPT directory once the listing is actually live.
  const directoryLive = process.env.PLUGIN_DIRECTORY_LIVE === "true";
  const prompt = `Add the remote MCP server "${name}" at ${mcpUrl} (HTTP transport, OAuth sign-in) to my MCP settings, then start the sign-in so I can connect my Google account.`;
  return layout("Install", `
<h1>Install Marketer Companion</h1>
<p class="lead">Marketing reporting for GA4, Search Console, Google Ads, Merchant Center, Google Business Profile and CallRail, in the AI tools you already use. You connect your own accounts; reporting is read-only.</p>
<p>Every setup below uses the same server address:</p>
${copyBlock(mcpUrl)}
<nav class="jump"><a href="#chatgpt">ChatGPT</a><a href="#claude">Claude</a><a href="#terminal">Terminal</a><a href="#editors">Cursor &amp; VS Code</a><a href="#prompt">Ask your AI</a></nav>

<h2 id="chatgpt">ChatGPT</h2>
${directoryLive ? `<div class="card"><span class="tag">Easiest</span><h3>From the ChatGPT plugin directory</h3>
<ol><li>Open <strong>Plugins</strong> in the ChatGPT sidebar and search for <strong>Marketer Companion</strong>.</li>
<li>Select <strong>Install plugin</strong>, then <strong>Connect</strong>, and sign in with Google.</li>
<li>Ask: <em>“Open my marketing dashboard.”</em></li></ol></div>` : ""}
<div class="card"><span class="tag">Plus, Pro and workspace admins</span><h3>Developer mode</h3>
<ol><li>On ChatGPT on the web or desktop, open <strong>Settings → Security and login</strong> and turn on <strong>Developer mode</strong>.</li>
<li>Open <strong>Plugins</strong>, select <strong>+</strong>, and add an MCP app.</li>
<li>Name it <strong>Marketer Companion</strong>, paste the server address above, and choose <strong>OAuth</strong>.</li>
<li>Select <strong>Connect</strong> and sign in with Google. Add a CallRail API key on the next screen, or skip it.</li>
<li>In a new chat, ask: <em>“Open my marketing dashboard.”</em></li></ol>
<p>Not available in the mobile apps. If the setting is missing in a work account, your admin has turned it off.</p></div>
<div class="card"><span class="tag">Teams</span><h3>Business, Enterprise or Edu workspace</h3>
<ol><li>A workspace owner or admin goes to <strong>Workspace settings → Plugins → Add → Upload plugin</strong> and uploads the Marketer Companion plugin ZIP (ask ${OWNER} for the latest file).</li>
<li>Set the installation policy to <strong>Available</strong> (members install it) or <strong>Installed</strong> (installed for everyone).</li>
<li>Each member connects their own Google account the first time they use it.</li></ol></div>
<div class="card"><span class="tag">By chat</span><h3>Create it with Plugin Creator</h3>
<p>With developer mode on, install <strong>Plugin Creator</strong> from Plugins, then send:</p>
${copyBlock(`@plugin-creator Create a plugin called Marketer Companion that connects to the MCP server ${mcpUrl} with OAuth sign-in.`)}
<p>Approve the install card it shows, then connect Google.</p></div>

<h2 id="claude">Claude</h2>
<div class="card"><span class="tag">Claude.ai and Claude Desktop</span><h3>Custom connector</h3>
<ol><li>Open <strong>Customize → Connectors</strong>, select <strong>+</strong>, then <strong>Add custom connector</strong>. On Team and Enterprise plans an owner adds it under <strong>Organization settings → Connectors</strong>.</li>
<li>Name it <strong>Marketer Companion</strong> and paste the server address. Leave the advanced OAuth fields empty.</li>
<li>Select <strong>Connect</strong> and sign in with Google.</li>
<li>Enable it in a chat from the tools menu and ask: <em>“Open my marketing dashboard.”</em></li></ol>
<p>Free plans can add one custom connector; Pro, Max, Team and Enterprise can add more. Connectors added on the web also appear in Claude Desktop.</p></div>

<h2 id="terminal">Terminal</h2>
<div class="card"><h3>Claude Code</h3>
${copyBlock(`claude mcp add --transport http ${name} ${mcpUrl}`)}
<p>Then run <code>/mcp</code> inside Claude Code, choose <strong>${name}</strong> and select <strong>Authenticate</strong>.</p></div>
<div class="card"><h3>OpenAI Codex CLI</h3>
${copyBlock(`codex mcp add ${name} --url ${mcpUrl}`)}
${copyBlock(`codex mcp login ${name}`)}
<p>The second command opens your browser to sign in.</p></div>
<div class="card"><h3>Gemini CLI</h3>
${copyBlock(`gemini mcp add --transport http ${name} ${mcpUrl}`)}
<p>Gemini CLI opens the sign-in the first time it uses the server.</p></div>

<h2 id="editors">Cursor and VS Code</h2>
<div class="card"><h3>Cursor</h3>
<p>Add this to <code>~/.cursor/mcp.json</code> (or <strong>Settings → MCP → Add new MCP server</strong>), then select <strong>Connect</strong> next to it:</p>
${copyBlock(JSON.stringify({ mcpServers: { [name]: { url: mcpUrl } } }, null, 2))}</div>
<div class="card"><h3>VS Code (GitHub Copilot agent mode)</h3>
${copyBlock(`code --add-mcp '${JSON.stringify({ name, type: "http", url: mcpUrl })}'`)}
<p>Or add it to <code>.vscode/mcp.json</code> under <code>servers</code>. VS Code asks you to sign in the first time a tool runs.</p></div>

<h2 id="prompt">Ask your AI to set it up</h2>
<p>Agents that can change their own settings, such as Claude Code, Codex, Gemini CLI, Cursor and Copilot agent mode, can add it for you. Paste:</p>
${copyBlock(prompt)}

<h2>What you will see</h2>
<ul><li>In ChatGPT and Claude, “Open my marketing dashboard” shows the interactive dashboard where the app supports it. In terminals and editors you get the same reports as text and tables.</li>
<li>Pick one account per source for the same business, or leave a source out. Then choose dates, add filters and ask for an analysis.</li>
<li>Google shows exactly which data you are granting before you approve. Revoke access any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</li></ul>

<h2 id="support">Troubleshooting and support</h2>
<ul><li><strong>“Reconnect this source”</strong>: remove the connection in your AI tool and add it again, approving every requested permission.</li>
<li><strong>A source shows an access error</strong>: the Google account you signed in with has no access to that property or account.</li>
<li><strong>Sign-in does not open from a terminal tool</strong>: run its login command again (<code>/mcp</code> in Claude Code, <code>codex mcp login ${name}</code> in Codex).</li>
<li><strong>The dashboard looks out of date</strong>: start a new chat; ChatGPT caches app views per conversation.</li>
<li><strong>Google Ads says quota exceeded</strong>: the shared daily Google Ads allowance ran out; try again the next day.</li></ul>
<p>Still stuck? Contact ${contact()}.</p>`);
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
  // OpenAI verifies plugin domain ownership by fetching this token over HTTPS.
  app.get("/.well-known/openai-apps-challenge", (req, res) => {
    const token = process.env.OPENAI_APPS_CHALLENGE;
    if (!token) return res.status(404).type("text").send("Not configured");
    res.set("Cache-Control", "no-store").type("text").send(token.trim());
  });
}
