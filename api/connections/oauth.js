// OAuth for platforms connected on the Connections page (YouTube now; Microsoft Advertising,
// LinkedIn, TikTok and HubSpot reuse it). Separate from the app's own sign-in: the user is
// already identified by the private Connections link, which the OAuth state carries.

const TIMEOUT_MS = 30_000;
export const STATE_TTL_MS = 15 * 60 * 1000;
export const CALLBACK_PATH = "/connections/oauth/callback";

// Whether this server has the platform's OAuth app configured.
export const oauthReady = provider => Boolean(provider.oauth?.clientId() && provider.oauth?.clientSecret());

// Scopes can be a function, for accounts that mirror the server's own scope list.
export const scopesOf = provider => typeof provider.oauth.scopes === "function" ? provider.oauth.scopes() : provider.oauth.scopes;

export function authorizeUrl(provider, { redirectUri, state }) {
  if (provider.oauth.authorize) return provider.oauth.authorize({ redirectUri, state });
  const url = new URL(provider.oauth.authorizeUrl);
  const params = { client_id: provider.oauth.clientId(), redirect_uri: redirectUri, response_type: "code", scope: scopesOf(provider).join(" "), state, ...(provider.oauth.authParams || {}) };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function tokenRequest(provider, fields) {
  const body = new URLSearchParams({ client_id: provider.oauth.clientId(), client_secret: provider.oauth.clientSecret(), ...fields });
  const response = await fetch(provider.oauth.tokenUrl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) throw new Error(json.error_description || json.error || `Token request failed (${response.status})`);
  return {
    accessToken: json.access_token,
    // Some platforms rotate the refresh token on every refresh; keep the old one if none comes back.
    refreshToken: json.refresh_token || fields.refresh_token || null,
    // A missing lifetime means an hour; a real 0 means already expired.
    expiresAt: Date.now() + (json.expires_in === undefined || json.expires_in === null ? 3600 : Number(json.expires_in)) * 1000,
    scope: json.scope || scopesOf(provider).join(" ")
  };
}

export const exchangeCode = (provider, code, redirectUri) => provider.oauth.exchange
  ? provider.oauth.exchange(code, redirectUri)
  : tokenRequest(provider, { grant_type: "authorization_code", code, redirect_uri: redirectUri });

// A usable access token for a stored OAuth connection, refreshing (and saving) it when it is
// within a minute of expiring. Throws a readable error if the platform revoked access.
export async function freshAccessToken({ store, userId, providerId, provider, record }) {
  const oauth = record.oauth || {};
  if (oauth.accessToken && oauth.expiresAt - Date.now() > 60_000) return oauth.accessToken;
  if (!oauth.refreshToken) throw new Error(`${provider.name} needs to be connected again.`);
  let refreshed;
  try {
    refreshed = await tokenRequest(provider, { grant_type: "refresh_token", refresh_token: oauth.refreshToken });
  } catch (error) {
    throw new Error(`${provider.name} access expired or was removed. Connect it again on the Connections page. (${error.message})`);
  }
  await store.save(userId, providerId, { ...record, oauth: { ...oauth, ...refreshed } });
  return refreshed.accessToken;
}
