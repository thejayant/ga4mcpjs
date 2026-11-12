import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { z } from "zod";
import { buildProfile, findProfile, profileShape, profileToolAllowed, newSlug, SLUG_PATTERN } from "./connections/profiles.js";

// The in-memory store must be chosen before the server module creates its store.
process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
const { default: app, testSupport } = await import("./index.js");
const store = testSupport.connectionStore;

let server, baseUrl;
const realFetch = globalThis.fetch;
before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = baseUrl;
});
after(async () => { globalThis.fetch = realFetch; await new Promise(resolve => server.close(resolve)); });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// A signed-in user's token for `resource` (the plain /mcp endpoint unless a profile URL is given).
function tokenFor(userId, resource = `${baseUrl}/mcp`) {
  const sessionId = `s-${Math.random()}`;
  const google = { sessionId, refreshToken: "r", accessToken: "main-access", expiryDate: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId };
  const session = testSupport.saveSession(sessionId, google);
  return testSupport.mintAccessToken({ protocol: "http", get: () => new URL(baseUrl).host }, { sessionId, resource, scope: session.scope, google: session });
}

// One JSON-RPC call to `path` (/mcp or /mcp/p/<slug>); `upstream` answers calls that leave this server.
async function rpc(token, path, method, params = {}, upstream) {
  globalThis.fetch = (url, init) => String(url).startsWith(baseUrl) || !upstream ? realFetch(url, init) : upstream(String(url), init);
  try {
    const response = await realFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body, headers: response.headers };
  } finally { globalThis.fetch = realFetch; }
}
const callTool = async (token, path, name, args = {}, upstream) => (await rpc(token, path, "tools/call", { name, arguments: args }, upstream)).body.result;
const listTools = async (token, path) => (await rpc(token, path, "tools/list")).body.result.tools;

// GA4 metadata answers with the property and the bearer it was read with.
const ga4 = async (url, init) => {
  const property = /v1beta\/(properties\/\d+)\/metadata/.exec(url)?.[1];
  if (!property) throw new Error(`unexpected ${url}`);
  return json({ name: `${property}/metadata`, readWith: (init.headers.Authorization || init.headers.authorization || "").replace("Bearer ", "") });
};

async function saveProfile(userId, profile) {
  const full = { slug: newSlug(profile.name), accounts: { google: null, meta: null, callrail: null }, accountLabels: {}, platforms: [], defaults: {}, createdAt: Date.now(), ...profile };
  await store.saveProfile(userId, full);
  return full;
}

test("profiles validate their accounts, platforms and default IDs", () => {
  const options = { accountOptions: { google: ["main", "google_account:x"], meta: ["main"], callrail: ["main"] }, platformOptions: ["clarity"], labels: { google: { "google_account:x": "agency@example.com" } } };
  assert.match(buildProfile({ name: "" }, options).error, /name/);
  assert.match(buildProfile({ name: "A", accounts: { google: "google_account:other" } }, options).error, /Pick a Google account/);
  assert.match(buildProfile({ name: "A" }, options).error, /at least one/);
  assert.match(buildProfile({ name: "A", accounts: { meta: "main" }, defaults: { google: { propertyId: "1" } } }, options).error, /needs a Google account/);
  assert.match(buildProfile({ name: "A", accounts: { google: "main" }, defaults: { google: { propertyId: "abc" } } }, options).error, /doesn't look right/);
  const { profile } = buildProfile({ name: "  Client   A ", accounts: { google: "google_account:x" }, platforms: ["clarity", "bing_webmaster"], defaults: { google: { customerId: "123-456-7890" } } }, options);
  assert.equal(profile.name, "Client A");
  assert.match(profile.slug, /^client-a-[0-9a-f]{6}$/);
  assert.ok(SLUG_PATTERN.test(profile.slug));
  assert.deepEqual(profile.platforms, ["clarity"], "only connected platforms");
  assert.equal(profile.defaults.google.customerId, "1234567890");
  assert.equal(profile.accountLabels.google, "agency@example.com");
  assert.equal(buildProfile({ name: "B", accounts: { google: "main" } }, { ...options, existing: profile }).profile.slug, profile.slug, "editing keeps the URL");

  assert.equal(findProfile([profile], `profile:${profile.slug}`), profile);
  assert.equal(findProfile([profile], "client a"), profile);
  assert.equal(findProfile([profile], "nobody"), null);
  assert.equal(profileToolAllowed(profile, "run_ga4_report", "google"), true);
  assert.equal(profileToolAllowed(profile, "run_meta_insights", "meta"), false);
  assert.equal(profileToolAllowed(profile, "clarity_insights", null), true);
  assert.equal(profileToolAllowed(profile, "bing_webmaster_sites", null), false);
  assert.equal(profileToolAllowed(profile, "list_marketing_presets", null), true);

  const shape = { propertyId: z.string().regex(/^\d+$/).describe("GA4 property"), siteUrl: z.string().url() };
  const result = profileShape(shape, { propertyId: "111", siteUrl: "not a url" }, "Client A");
  assert.deepEqual(result.defaults, { propertyId: "111" }, "an invalid default is not applied");
  assert.equal(result.shape.propertyId.safeParse(undefined).success, true);
  assert.match(result.shape.propertyId.description, /Defaults to 111 \(profile "Client A"\)/);
  assert.equal(result.shape.siteUrl.safeParse(undefined).success, false);
});

test("a profile connector offers only its platforms, fills default IDs and names the profile", async () => {
  const profile = await saveProfile("p-user-1", { name: "Client A", accounts: { google: "main", meta: null, callrail: null }, defaults: { google: { propertyId: "111" } } });
  const token = tokenFor("p-user-1", `${baseUrl}/mcp/p/${profile.slug}`);
  const path = `/mcp/p/${profile.slug}`;

  const init = await rpc(token, path, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.match(init.body.result.instructions, /profile "Client A"/);
  assert.match(init.body.result.instructions, /propertyId 111/);

  const tools = await listTools(token, path);
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes("get_ga4_metadata"));
  assert.ok(!names.some(name => /meta/.test(name) && name !== "get_ga4_metadata"), "no Meta tools without a Meta account");
  assert.ok(!names.includes("run_across_profiles"), "run_across_profiles is for the main connector");
  const metadata = tools.find(tool => tool.name === "get_ga4_metadata");
  assert.ok(!metadata.inputSchema.properties.account, "no account input: the profile decides");
  assert.ok(!(metadata.inputSchema.required || []).includes("propertyId"), "the default makes propertyId optional");

  const result = await callTool(token, path, "get_ga4_metadata", {}, ga4);
  assert.equal(result.structuredContent.name, "properties/111/metadata");
  assert.equal(result.structuredContent.readWith, "main-access");
  const other = await callTool(token, path, "get_ga4_metadata", { propertyId: "222" }, ga4);
  assert.equal(other.structuredContent.name, "properties/222/metadata", "an explicit ID still wins");

  // The plain connector is unchanged: account input, no defaults, plus run_across_profiles.
  const plain = await listTools(tokenFor("p-user-1"), "/mcp");
  const plainMetadata = plain.find(tool => tool.name === "get_ga4_metadata");
  assert.ok(plainMetadata.inputSchema.properties.account);
  assert.ok(plainMetadata.inputSchema.required.includes("propertyId"));
  assert.ok(plain.some(tool => tool.name === "run_across_profiles"));
});

test("profile connectors sign in on their own URL, accept /mcp tokens, and refuse other profiles and users", async () => {
  const a = await saveProfile("p-user-2", { name: "A", accounts: { google: "main" } });
  const b = await saveProfile("p-user-2", { name: "B", accounts: { google: "main" } });
  const pathA = `/mcp/p/${a.slug}`;

  const metadata = await (await realFetch(`${baseUrl}/.well-known/oauth-protected-resource${pathA}`)).json();
  assert.equal(metadata.resource, `${baseUrl}${pathA}`);
  const unsigned = await rpc(null, pathA, "tools/list");
  assert.equal(unsigned.status, 401);
  assert.match(unsigned.headers.get("www-authenticate"), new RegExp(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${pathA}"`));

  assert.equal((await rpc(tokenFor("p-user-2", `${baseUrl}${pathA}`), pathA, "tools/list")).status, 200, "its own token");
  assert.equal((await rpc(tokenFor("p-user-2"), pathA, "tools/list")).status, 200, "a token for /mcp");
  assert.equal((await rpc(tokenFor("p-user-2", `${baseUrl}/mcp/p/${b.slug}`), pathA, "tools/list")).status, 401, "another profile's token");
  assert.equal((await rpc(tokenFor("p-user-2", `${baseUrl}${pathA}`), "/mcp", "tools/list")).status, 401, "a profile token is not a /mcp token");

  const stranger = await rpc(tokenFor("p-user-other"), pathA, "tools/list");
  assert.equal(stranger.status, 404, "another user's profile is not found");
  assert.equal(stranger.body.error, "profile_not_found");
  assert.equal((await rpc(tokenFor("p-user-2"), "/mcp/p/NOT_A_SLUG!", "tools/list")).status, 404);

  await store.removeProfile("p-user-2", a.slug);
  assert.equal((await rpc(tokenFor("p-user-2"), pathA, "tools/list")).status, 404, "a deleted profile is a 404, not a sign-in loop");
});

test("a profile pinned to an extra account always uses it, and fails once that account is removed", async () => {
  await store.save("p-user-3", "google_account:x", { label: "agency@example.com", oauth: { accessToken: "extra-access", refreshToken: "x", expiresAt: Date.now() + 3_600_000 } });
  const profile = await saveProfile("p-user-3", { name: "Agency client", accounts: { google: "google_account:x" }, accountLabels: { google: "agency@example.com" } });
  const path = `/mcp/p/${profile.slug}`, token = tokenFor("p-user-3");

  const read = await callTool(token, path, "get_ga4_metadata", { propertyId: "5" }, ga4);
  assert.equal(read.structuredContent.readWith, "extra-access", "never the main sign-in");

  // On /mcp the same account is reached by naming the profile.
  const byProfile = await callTool(token, "/mcp", "get_ga4_metadata", { propertyId: "5", account: `profile:${profile.slug}` }, ga4);
  assert.equal(byProfile.structuredContent.readWith, "extra-access");
  const byName = await callTool(token, "/mcp", "get_ga4_metadata", { propertyId: "5", account: "agency client" }, ga4);
  assert.equal(byName.structuredContent.readWith, "extra-access");
  const unknown = await callTool(token, "/mcp", "get_ga4_metadata", { propertyId: "5", account: "profile:nope-000000" }, ga4);
  assert.equal(unknown.isError, true);
  assert.match(unknown.structuredContent.error_description, /No profile called/);

  await store.remove("p-user-3", "google_account:x");
  const gone = await callTool(token, path, "get_ga4_metadata", { propertyId: "5" }, ga4);
  assert.equal(gone.isError, true, "no quiet fallback to the main sign-in");
  assert.match(gone.structuredContent.error_description, /No connected google account/);
});

test("run_across_profiles runs a read-only tool per profile with each profile's defaults", async () => {
  await store.save("p-user-4", "google_account:y", { label: "second@example.com", oauth: { accessToken: "second-access", refreshToken: "y", expiresAt: Date.now() + 3_600_000 } });
  await saveProfile("p-user-4", { name: "North", accounts: { google: "main" }, defaults: { google: { propertyId: "100" } } });
  await saveProfile("p-user-4", { name: "South", accounts: { google: "google_account:y" }, defaults: { google: { propertyId: "200" } } });
  await saveProfile("p-user-4", { name: "Meta only", accounts: { meta: "main" } });
  const token = tokenFor("p-user-4");

  const run = await callTool(token, "/mcp", "run_across_profiles", { tool: "get_ga4_metadata" }, ga4);
  const rows = Object.fromEntries(run.structuredContent.profiles.map(row => [row.profile, row]));
  assert.equal(rows.North.data.name, "properties/100/metadata");
  assert.equal(rows.North.data.readWith, "main-access");
  assert.equal(rows.South.data.name, "properties/200/metadata");
  assert.equal(rows.South.data.readWith, "second-access", "each profile uses its own account");
  assert.match(rows["Meta only"].skipped, /no Google account/);

  const some = await callTool(token, "/mcp", "run_across_profiles", { tool: "get_ga4_metadata", profiles: ["south"] }, ga4);
  assert.deepEqual(some.structuredContent.profiles.map(row => row.profile), ["South"]);
  const missingId = await callTool(token, "/mcp", "run_across_profiles", { tool: "get_ga4_metadata", profiles: ["Meta only"] }, ga4);
  assert.match(missingId.structuredContent.profiles[0].skipped, /no Google account/);

  const write = await callTool(token, "/mcp", "run_across_profiles", { tool: "register_merchant_developer" });
  assert.equal(write.structuredContent.error, "not_read_only");
  const unknownTool = await callTool(token, "/mcp", "run_across_profiles", { tool: "nope" });
  assert.equal(unknownTool.structuredContent.error, "unknown_tool");
  const unknownProfile = await callTool(token, "/mcp", "run_across_profiles", { tool: "get_ga4_metadata", profiles: ["West"] });
  assert.equal(unknownProfile.structuredContent.error, "unknown_profile");
  const none = await callTool(tokenFor("p-user-empty"), "/mcp", "run_across_profiles", { tool: "get_ga4_metadata" });
  assert.equal(none.structuredContent.error, "no_profiles");
});

test("profiles are created, listed and deleted on the Connections page", async () => {
  const token = tokenFor("p-user-5");
  const managed = (await callTool(token, "/mcp", "manage_connections")).structuredContent;
  assert.deepEqual(managed.profiles, []);
  const t = new URL(managed.manageUrl).searchParams.get("t");
  const post = (path, body) => realFetch(`${baseUrl}${path}?t=${encodeURIComponent(t)}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

  const page = await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text();
  assert.match(page, /New profile/);

  const bad = await post("/connections/profiles/save", { name: "Client A", account_google: "google_account:stolen" });
  assert.match(new URL(bad.headers.get("location"), baseUrl).searchParams.get("error"), /Pick a Google account/, "only the user's own accounts");

  const created = await post("/connections/profiles/save", { name: "Client A", account_google: "main", default_google_propertyId: "123" });
  assert.equal(created.status, 303);
  assert.match(created.headers.get("location"), /profile_saved=Client\+A/);
  const listed = (await callTool(token, "/mcp", "manage_connections")).structuredContent.profiles;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Client A");
  assert.equal(listed[0].connectorUrl, `${baseUrl}/mcp/p/${listed[0].slug}`);
  assert.deepEqual(listed[0].defaults, { google: { propertyId: "123" } });
  const shown = await (await realFetch(`${baseUrl}/connections?t=${encodeURIComponent(t)}`)).text();
  assert.ok(shown.includes(`${baseUrl}/mcp/p/${listed[0].slug}`), "the page shows the connector URL");

  const edited = await post("/connections/profiles/save", { slug: listed[0].slug, name: "Client A2", account_google: "main" });
  assert.match(edited.headers.get("location"), /profile_saved/);
  const after = (await callTool(token, "/mcp", "manage_connections")).structuredContent.profiles;
  assert.equal(after[0].slug, listed[0].slug, "editing keeps the connector URL");
  assert.equal(after[0].name, "Client A2");

  // Another user's link can't edit or delete this profile.
  const otherT = new URL((await callTool(tokenFor("p-user-6"), "/mcp", "manage_connections")).structuredContent.manageUrl).searchParams.get("t");
  const foreign = await realFetch(`${baseUrl}/connections/profiles/${listed[0].slug}/delete?t=${encodeURIComponent(otherT)}`, { method: "POST", redirect: "manual" });
  assert.match(new URL(foreign.headers.get("location"), baseUrl).searchParams.get("error"), /no longer exists/);
  assert.equal((await callTool(token, "/mcp", "manage_connections")).structuredContent.profiles.length, 1);

  const removed = await post(`/connections/profiles/${listed[0].slug}/delete`, {});
  assert.match(removed.headers.get("location"), /profile_deleted/);
  assert.deepEqual((await callTool(token, "/mcp", "manage_connections")).structuredContent.profiles, []);
});
