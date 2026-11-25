// Connections are kept per assistant: the same Google account signed in from Claude and from
// ChatGPT gets two separate stores, so accounts added in one never appear in the other.
//
// A store user ID is "<account>-<assistant>": <account> is the HMAC of the Google account (as
// before) and <assistant> comes from the redirect address the assistant registered for sign-in
// (claude.ai → claude, chatgpt.com → chatgpt). IDs made before this are the bare 32-character
// <account>; they no longer open a store, and their data can be moved to one assistant once, from
// that assistant's Connections page.

const ACCOUNT = /^[0-9a-f]{32}$/;
const SCOPED = /^([0-9a-f]{32})-([a-z0-9]{1,24})$/;
const KNOWN = { "claude.ai": "claude", "claude.com": "claude", "anthropic.com": "claude", "chatgpt.com": "chatgpt", "chat.openai.com": "chatgpt", "openai.com": "chatgpt" };
export const ASSISTANT_NAMES = { claude: "Claude", chatgpt: "ChatGPT", local: "a local app", web: "the browser" };
const clean = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);

// The assistant behind a sign-in, from the redirect URI its OAuth client registered.
export function assistantFor(redirectUri) {
  if (!redirectUri) return "web";
  let url;
  try { url = new URL(String(redirectUri)); } catch { return "other"; }
  if (!/^https?:$/.test(url.protocol)) return clean(url.protocol) || "other"; // e.g. cursor://, vscode://
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return "local";
  for (const [domain, name] of Object.entries(KNOWN)) if (host === domain || host.endsWith(`.${domain}`)) return name;
  const labels = host.split(".");
  return clean(labels.length > 1 ? labels[labels.length - 2] : host) || "other";
}

export const scopedUserId = (accountId, assistant) => (accountId ? `${accountId}-${clean(assistant) || "other"}` : null);

// The store user ID a token may use: scoped IDs (and test or hand-made IDs) pass; a bare pre-change
// account ID does not, so the sign-in that holds it is asked to reconnect once.
export const storeUserId = id => (id && !ACCOUNT.test(String(id)) ? String(id) : null);
export const isUnscoped = id => Boolean(id) && ACCOUNT.test(String(id));

// For a scoped ID: the shared store it may adopt (connections made before the split) and its assistant.
export function splitUserId(id) {
  const match = SCOPED.exec(String(id || ""));
  return match ? { account: match[1], assistant: match[2], name: ASSISTANT_NAMES[match[2]] || match[2] } : null;
}
