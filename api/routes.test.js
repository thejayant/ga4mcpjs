import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import app, { testSupport } from "./index.js";

let server;
let baseUrl;
const previousSecret = process.env.CBX_INTERNAL_SECRET;
const previousEncryptionKey = process.env.APP_ENCRYPTION_KEY;
const previousSharedCallRailToken = process.env.CALLRAIL_API_TOKEN;
const previousBaseUrl = process.env.APP_BASE_URL;

before(async () => {
  process.env.CBX_INTERNAL_SECRET = "test-only-internal-secret";
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.CALLRAIL_API_TOKEN = "shared-test-token";
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = baseUrl;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (previousSecret === undefined) delete process.env.CBX_INTERNAL_SECRET;
  else process.env.CBX_INTERNAL_SECRET = previousSecret;
  if (previousEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = previousEncryptionKey;
  if (previousSharedCallRailToken === undefined) delete process.env.CALLRAIL_API_TOKEN;
  else process.env.CALLRAIL_API_TOKEN = previousSharedCallRailToken;
  if (previousBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = previousBaseUrl;
});

function issueToken(resource, callrail = null, internalAccessKeyId = null) {
  const sessionId = `test-${Math.random()}`;
  const session = testSupport.saveSession(sessionId, {
    sessionId,
    refreshToken: "test-google-refresh",
    accessToken: "test-google-access",
    expiryDate: Date.now() + 3_600_000,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    tokenType: "Bearer",
    callrail,
    internalAccessKeyId
  });
  const req = { protocol: "http", get: () => new URL(baseUrl).host };
  return testSupport.mintAccessToken(req, { sessionId, resource, scope: session.scope, google: session, callrail, internalAccessKeyId });
}

async function listTools(resource, token) {
  const response = await fetch(resource, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.result.tools.map((tool) => tool.name);
}

async function callTool(resource, token) {
  const response = await fetch(resource, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_callrail_accounts", arguments: {} } })
  });
  assert.equal(response.status, 200);
  return (await response.json()).result.structuredContent;
}

test("public catalog does not advertise shared CallRail tools", async () => {
  const response = await fetch(baseUrl);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mcpUrl, `${baseUrl}/mcp`);
  assert.equal(body.internalMcpUrl, `${baseUrl}/cbx`);
  assert.equal(body.tools.includes("list_callrail_calls"), false);
  assert.equal(body.optionalCallRailTools.includes("list_callrail_calls"), true);
});

test("authenticated MCP exposes the dashboard resource and opener without upstream requests", async () => {
  const previousDashboardFlag = process.env.ENABLE_MARKETING_DASHBOARD;
  process.env.ENABLE_MARKETING_DASHBOARD = 'true';
  try {
  const resource = `${baseUrl}/mcp`;
  const token = issueToken(resource);
  const rpc = async (method, params) => {
    const response = await fetch(resource, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    assert.equal(response.status, 200);
    const json = await response.json(); assert.equal(json.error, undefined); return json.result;
  };
  const tools = await rpc('tools/list', {});
  const opener = tools.tools.find(tool => tool.name === 'open_marketing_dashboard');
  assert.equal(opener._meta.ui.resourceUri, 'ui://marketing/dashboard-v3.html');
  const read = await rpc('resources/read', { uri: opener._meta.ui.resourceUri });
  assert.match(read.contents[0].text, /Marketer Companion/);
  const opened = await rpc('tools/call', { name: opener.name, arguments: {} });
  assert.equal(opened.structuredContent.defaults.days, 28);
  } finally {
    if (previousDashboardFlag === undefined) delete process.env.ENABLE_MARKETING_DASHBOARD;
    else process.env.ENABLE_MARKETING_DASHBOARD = previousDashboardFlag;
  }
});

test("dashboard is absent from the catalog and authenticated tools when disabled", async () => {
  const previousDashboardFlag = process.env.ENABLE_MARKETING_DASHBOARD;
  process.env.ENABLE_MARKETING_DASHBOARD = 'false';
  try {
    const catalog = await (await fetch(baseUrl)).json();
    assert.equal(catalog.tools.includes('open_marketing_dashboard'), false);
    const resource = `${baseUrl}/mcp`;
    const tools = await listTools(resource, issueToken(resource));
    assert.equal(tools.includes('get_marketing_dashboard'), false);
    assert.equal(tools.includes('run_ga4_report'), true);
    assert.equal(tools.includes('list_search_console_sites'), true);
  } finally {
    if (previousDashboardFlag === undefined) delete process.env.ENABLE_MARKETING_DASHBOARD;
    else process.env.ENABLE_MARKETING_DASHBOARD = previousDashboardFlag;
  }
});

test("internal route starts OAuth and requires a separate approval after Google", async () => {
  const noOauth = await fetch(`${baseUrl}/cbx`);
  assert.equal(noOauth.status, 401);
  assert.match(noOauth.headers.get("www-authenticate"), /oauth-protected-resource\/cbx/);
});

test("public route and optional CallRail step require valid authorization", async () => {
  assert.equal((await fetch(`${baseUrl}/mcp`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/auth/callrail?chain=invalid`)).status, 400);
  const metadata = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/cbx`)).json();
  assert.equal(metadata.resource, `${baseUrl}/cbx`);
});

test("public token cannot cross into CBX", async () => {
  const publicToken = issueToken(`${baseUrl}/mcp`);
  const response = await fetch(`${baseUrl}/cbx`, { headers: {
    Authorization: `Bearer ${publicToken}`
  } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).debug, "bad_audience_resource");
});

test("CBX token requires internal approval and public route rejects CBX audience", async () => {
  const internalToken = issueToken(`${baseUrl}/cbx`);
  assert.equal((await fetch(`${baseUrl}/cbx`, { headers: { Authorization: `Bearer ${internalToken}` } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/mcp`, { headers: { Authorization: `Bearer ${internalToken}` } })).status, 401);
});

test("an old token cannot inherit CallRail or CBX access added later to its session", async () => {
  const oldPublic = issueToken(`${baseUrl}/mcp`);
  const publicPayload = testSupport.decryptJson(oldPublic);
  testSupport.saveSession(publicPayload.sessionId, {
    sessionId: publicPayload.sessionId, refreshToken: "test-google-refresh", accessToken: "test-google-access",
    expiryDate: Date.now() + 3_600_000, scope: publicPayload.scope,
    callrail: { apiToken: "later-connected-token" }
  });
  assert.equal((await listTools(`${baseUrl}/mcp`, oldPublic)).includes("list_callrail_calls"), false);
  const oldInternal = issueToken(`${baseUrl}/cbx`);
  const internalPayload = testSupport.decryptJson(oldInternal);
  testSupport.saveSession(internalPayload.sessionId, {
    sessionId: internalPayload.sessionId, refreshToken: "test-google-refresh", accessToken: "test-google-access",
    expiryDate: Date.now() + 3_600_000, scope: internalPayload.scope,
    internalAccessKeyId: testSupport.internalAccessKeyId()
  });
  assert.equal((await fetch(`${baseUrl}/cbx`, { headers: { Authorization: `Bearer ${oldInternal}` } })).status, 401);
});

test("CallRail tools appear only for connected public users or internal CBX", async () => {
  const publicTools = await listTools(`${baseUrl}/mcp`, issueToken(`${baseUrl}/mcp`));
  assert.equal(publicTools.includes("list_callrail_calls"), false);
  const connectedTools = await listTools(`${baseUrl}/mcp`, issueToken(`${baseUrl}/mcp`, { apiToken: "user-test-token" }));
  assert.equal(connectedTools.includes("list_callrail_calls"), true);
  const internalTools = await listTools(`${baseUrl}/cbx`, issueToken(`${baseUrl}/cbx`, null, testSupport.internalAccessKeyId()));
  assert.equal(internalTools.includes("list_callrail_calls"), true);
});

test("outbound CallRail calls use the user's token on MCP and the shared token on CBX", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith("https://api.callrail.com/")) {
      return Promise.resolve(new Response(JSON.stringify({ authorizationUsed: options.headers.Authorization }), { status: 200 }));
    }
    return originalFetch(url, options);
  };
  try {
    const publicResult = await callTool(`${baseUrl}/mcp`, issueToken(`${baseUrl}/mcp`, { apiToken: "user-test-token" }));
    assert.equal(publicResult.authorizationUsed, 'Token token="user-test-token"');
    const internalResult = await callTool(`${baseUrl}/cbx`, issueToken(`${baseUrl}/cbx`, null, testSupport.internalAccessKeyId()));
    assert.equal(internalResult.authorizationUsed, 'Token token="shared-test-token"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("optional CallRail screen validates and seals a user token into OAuth credentials", async () => {
  const sessionId = `oauth-test-${Math.random()}`;
  const scope = "https://www.googleapis.com/auth/analytics.readonly";
  const google = { refreshToken: "test-google-refresh", accessToken: "test-google-access", expiryDate: Date.now() + 3_600_000, scope };
  const authCode = testSupport.encryptJson({
    typ: "mcp_authorization_code", iss: baseUrl, aud: `${baseUrl}/mcp`, resource: `${baseUrl}/mcp`,
    sessionId, scope, exp: Date.now() + 300_000, google
  });
  const fakeReq = { protocol: "http", get: () => new URL(baseUrl).host };
  const stepUrl = testSupport.buildCallRailStepUrl(fakeReq, authCode, {
    clientRedirectUri: `${baseUrl}/callback`, clientState: "test-state", googleConnected: true
  });
  const form = await fetch(stepUrl);
  assert.equal(form.status, 200);
  assert.match(await form.text(), /name="api_token"/);
  const chain = new URL(stepUrl).searchParams.get("chain");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith("https://api.callrail.com/")) {
      return Promise.resolve(new Response(JSON.stringify({ accounts: [] }), { status: 200 }));
    }
    return originalFetch(url, options);
  };
  try {
    const connected = await fetch(`${baseUrl}/auth/callrail`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chain, api_token: "personal-test-token-123" })
    });
    assert.equal(connected.status, 302);
    const connectedCode = new URL(connected.headers.get("location")).searchParams.get("code");
    assert.equal(testSupport.decryptJson(connectedCode).callrail.apiToken, "personal-test-token-123");
    const exchanged = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: connectedCode, resource: `${baseUrl}/mcp` })
    });
    assert.equal(exchanged.status, 200);
    const credentials = await exchanged.json();
    assert.equal((await listTools(`${baseUrl}/mcp`, credentials.access_token)).includes("list_callrail_calls"), true);
    assert.equal(testSupport.decryptJson(credentials.refresh_token).callrail.apiToken, "personal-test-token-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skipping CallRail keeps public tools unavailable and a delayed Meta handoff remains usable", async () => {
  const scope = "https://www.googleapis.com/auth/analytics.readonly";
  const google = { refreshToken: "test-google-refresh", accessToken: "test-google-access", expiryDate: Date.now() + 3_600_000, scope };
  const authCode = testSupport.encryptJson({
    typ: "mcp_authorization_code", iss: baseUrl, aud: `${baseUrl}/mcp`, resource: `${baseUrl}/mcp`,
    sessionId: `skip-test-${Math.random()}`, scope, exp: Date.now() - 60_000, google
  });
  const fakeReq = { protocol: "http", get: () => new URL(baseUrl).host };
  const stepUrl = testSupport.buildCallRailStepUrl(fakeReq, authCode, {
    clientRedirectUri: `${baseUrl}/callback`, googleConnected: true
  });
  const chain = new URL(stepUrl).searchParams.get("chain");
  const skipped = await fetch(`${baseUrl}/auth/callrail/skip?chain=${encodeURIComponent(chain)}`, { redirect: "manual" });
  assert.equal(skipped.status, 302);
  const skippedCode = new URL(skipped.headers.get("location")).searchParams.get("code");
  assert.ok(testSupport.decryptJson(skippedCode).exp > Date.now());
  const exchanged = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code: skippedCode, resource: `${baseUrl}/mcp` })
  });
  assert.equal(exchanged.status, 200);
  const credentials = await exchanged.json();
  assert.equal((await listTools(`${baseUrl}/mcp`, credentials.access_token)).includes("list_callrail_calls"), false);
  assert.equal(testSupport.decryptJson(credentials.refresh_token).callrail, undefined);
});

test("CBX screen requires the internal secret and seals approval into OAuth tokens", async () => {
  const scope = "https://www.googleapis.com/auth/analytics.readonly";
  const google = { refreshToken: "test-google-refresh", accessToken: "test-google-access", expiryDate: Date.now() + 3_600_000, scope };
  const authCode = testSupport.encryptJson({
    typ: "mcp_authorization_code", iss: baseUrl, aud: `${baseUrl}/cbx`, resource: `${baseUrl}/cbx`,
    sessionId: `cbx-test-${Math.random()}`, scope, exp: Date.now() + 300_000, google
  });
  const fakeReq = { protocol: "http", get: () => new URL(baseUrl).host };
  const stepUrl = testSupport.buildCallRailStepUrl(fakeReq, authCode, {
    clientRedirectUri: `${baseUrl}/callback`, googleConnected: true
  });
  assert.equal(new URL(stepUrl).pathname, "/auth/cbx");
  assert.match(await (await fetch(stepUrl)).text(), /name="internal_secret"/);
  const chain = new URL(stepUrl).searchParams.get("chain");
  const invalid = await fetch(`${baseUrl}/auth/cbx`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ chain, internal_secret: "wrong" })
  });
  assert.equal(invalid.status, 403);
  const approved = await fetch(`${baseUrl}/auth/cbx`, {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ chain, internal_secret: "test-only-internal-secret" })
  });
  assert.equal(approved.status, 302);
  const approvedCode = new URL(approved.headers.get("location")).searchParams.get("code");
  assert.equal(testSupport.decryptJson(approvedCode).internalAccessKeyId, testSupport.internalAccessKeyId());
  const exchanged = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code: approvedCode, resource: `${baseUrl}/cbx` })
  });
  assert.equal(exchanged.status, 200);
  const credentials = await exchanged.json();
  assert.equal((await listTools(`${baseUrl}/cbx`, credentials.access_token)).includes("list_callrail_calls"), true);
  assert.equal(testSupport.decryptJson(credentials.refresh_token).internalAccessKeyId, testSupport.internalAccessKeyId());
  process.env.CBX_INTERNAL_SECRET = "rotated-secret";
  try {
    assert.equal((await fetch(`${baseUrl}/cbx`, { headers: { Authorization: `Bearer ${credentials.access_token}` } })).status, 401);
  } finally {
    process.env.CBX_INTERNAL_SECRET = "test-only-internal-secret";
  }
});

test("install, privacy and terms pages are public and the OpenAI challenge serves only a configured token", async () => {
  for (const path of ["/install", "/support", "/privacy", "/terms"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /text\/html/);
  }
  const install = await (await fetch(`${baseUrl}/install`)).text();
  assert.ok(!install.includes("http://"), "install guide never shows a plain-HTTP address");
  assert.ok(install.includes("claude mcp add --transport http marketer-companion https://ga4mcpjs.vercel.app/mcp"), "a local run shows the public HTTPS address");
  assert.ok(!install.includes("Install plugin"), "directory route stays hidden until the listing is live");
  assert.ok(install.includes("https://claude.ai/customize/connectors?modal=add-custom-connector&amp;connectorName=Marketer%20Companion&amp;connectorUrl=https%3A%2F%2Fga4mcpjs.vercel.app%2Fmcp"), "Add to Claude prefills the connector form");
  assert.ok(!install.includes("plugin-creator"), "no chat-based install for ChatGPT");
  const zip = await fetch(`${baseUrl}/download/plugin.zip`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get("content-type"), "application/zip");
  const zipBytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(zipBytes.readUInt32LE(0), 0x04034b50, "download is a ZIP");
  assert.ok(zipBytes.includes(Buffer.from("plugin.json")));
  process.env.PLUGIN_DIRECTORY_LIVE = "true";
  assert.ok((await (await fetch(`${baseUrl}/install`)).text()).includes("Install plugin"));
  delete process.env.PLUGIN_DIRECTORY_LIVE;
  assert.match(await (await fetch(`${baseUrl}/privacy`)).text(), /Limited Use/);

  const previous = process.env.OPENAI_APPS_CHALLENGE;
  delete process.env.OPENAI_APPS_CHALLENGE;
  assert.equal((await fetch(`${baseUrl}/.well-known/openai-apps-challenge`)).status, 404);
  process.env.OPENAI_APPS_CHALLENGE = " test-challenge-token\n";
  const challenge = await fetch(`${baseUrl}/.well-known/openai-apps-challenge`);
  assert.equal(await challenge.text(), "test-challenge-token");
  if (previous === undefined) delete process.env.OPENAI_APPS_CHALLENGE;
  else process.env.OPENAI_APPS_CHALLENGE = previous;
});

test("short links send people straight to the right install step", async () => {
  const claude = await fetch(`${baseUrl}/claude`, { redirect: "manual" });
  assert.equal(claude.status, 302);
  assert.equal(claude.headers.get("location"), "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Marketer%20Companion&connectorUrl=https%3A%2F%2Fga4mcpjs.vercel.app%2Fmcp");
  assert.equal((await fetch(`${baseUrl}/chatgpt`, { redirect: "manual" })).headers.get("location"), "/install#chatgpt");
  assert.equal((await fetch(`${baseUrl}/add`, { redirect: "manual" })).headers.get("location"), "/install");
  process.env.CLAUDE_DIRECTORY_URL = "https://claude.ai/directory/connectors/marketer-companion";
  assert.equal((await fetch(`${baseUrl}/claude`, { redirect: "manual" })).headers.get("location"), process.env.CLAUDE_DIRECTORY_URL);
  delete process.env.CLAUDE_DIRECTORY_URL;
});
