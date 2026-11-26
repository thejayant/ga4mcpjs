// The read-only guarantee, checked against the tools the server really registers and
// against the Ads source itself. These are the tests that must pass before anything else
// about the Ads layer counts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";

const { default: app, testSupport } = await import("../index.js");
const { GOOGLE_ADS_TOOL_NAMES } = await import("./tools.js");
const { ADS_ALLOWED_RPCS, ADS_DENY_PATTERNS } = await import("./gate.js");

let server, baseUrl;
before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = baseUrl;
});
after(() => new Promise((resolve) => server.close(resolve)));

function token() {
  const sessionId = `s-${Math.random()}`;
  const google = {
    sessionId, refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000,
    scope: "https://www.googleapis.com/auth/adwords", tokenType: "Bearer", userId: "ads-registry-user"
  };
  const session = testSupport.saveSession(sessionId, google);
  return testSupport.mintAccessToken(
    { protocol: "http", get: () => new URL(baseUrl).host },
    { sessionId, resource: `${baseUrl}/mcp`, scope: session.scope, google: session }
  );
}

async function listTools() {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  const body = await response.json();
  return body.result.tools;
}

const isAdsTool = (name) => /google_ads/.test(name);

test("every registered Google Ads tool is annotated read-only", async () => {
  const tools = await listTools();
  const adsTools = tools.filter((tool) => isAdsTool(tool.name));
  assert.ok(adsTools.length >= 13, `expected the Ads tools to be registered, found ${adsTools.length}`);

  for (const tool of adsTools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is not readOnlyHint: true`);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} is not destructiveHint: false`);
    // Item: each description has to say read-only in so many words.
    assert.match(tool.description, /read-only/i, `${tool.name} does not say read-only in its description`);
  }
});

test("every Ads tool name this module registers is actually offered by the server", async () => {
  const offered = new Set((await listTools()).map((tool) => tool.name));
  for (const name of GOOGLE_ADS_TOOL_NAMES) {
    assert.ok(offered.has(name), `${name} is in GOOGLE_ADS_TOOL_NAMES but the server does not offer it`);
  }
});

test("the Ads tool names that existed before are all still offered", async () => {
  const offered = new Set((await listTools()).map((tool) => tool.name));
  // Nothing that callers already depend on may disappear.
  for (const name of [
    "list_google_ads_accessible_customers", "list_google_ads_customer_clients",
    "query_google_ads", "search_stream_google_ads", "run_google_ads_preset",
    "run_google_ads_across_accounts", "google_ads_keyword_planner", "google_ads_reach_planner",
    "get_google_ads_field", "search_google_ads_fields"
  ]) {
    assert.ok(offered.has(name), `the existing tool ${name} is no longer registered`);
  }
});

test("no Ads tool makes a required parameter out of a new option", async () => {
  const tools = await listTools();
  for (const tool of tools.filter((entry) => isAdsTool(entry.name))) {
    const required = tool.inputSchema?.required || [];
    // Only genuinely unavoidable inputs may be required.
    const allowed = new Set(["query", "action", "preset", "name", "groups", "listingId"]);
    for (const field of required) {
      assert.ok(allowed.has(field), `${tool.name} requires "${field}", which would break existing callers`);
    }
  }
});

/* ---------------- static scan of the Ads source ---------------- */

const ADS_DIR = path.join(import.meta.dirname, ".");
const adsSources = fs.readdirSync(ADS_DIR)
  .filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"))
  .map((file) => ({ file, text: fs.readFileSync(path.join(ADS_DIR, file), "utf8") }));

test("the Ads source contains no mutate endpoint outside the gate's deny list", () => {
  // gate.js names write RPCs on purpose (its deny list); every other file must not.
  for (const { file, text } of adsSources) {
    if (file === "gate.js") continue;
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const pattern of [/:mutate/i, /googleAds:mutate/i, /recommendations:apply/i, /recommendations:dismiss/i, /uploadClickConversions/i, /uploadUserData/i, /offlineUserDataJobs/i, /batchJobs/i, /generatePMaxDraftCampaign/i]) {
      assert.ok(!pattern.test(withoutComments), `${file} references a write endpoint matching ${pattern}`);
    }
  }
});

test("every path the Ads source requests is on the allowlist", () => {
  // Collect the REST paths built in the Ads modules and check each against the allowlist.
  const allowed = Object.keys(ADS_ALLOWED_RPCS);
  const templates = new Set();
  for (const { file, text } of adsSources) {
    if (file === "gate.js") continue;
    for (const match of text.matchAll(/path:\s*[`"']([^`"']+)[`"']/g)) templates.add(`${file}:${match[1]}`);
    for (const match of text.matchAll(/`customers\/\$\{[^}]+\}([^`]*)`/g)) templates.add(`${file}:customers/X${match[1]}`);
  }
  assert.ok(templates.size > 0, "no request paths were found to check");

  for (const entry of templates) {
    const template = entry.slice(entry.indexOf(":") + 1);
    // A path whose METHOD is interpolated (googleAds:${verb}) is expanded into every value
    // the code can supply, and each expansion must be allowlisted.
    const methodInterpolated = /:\$\{(\w+)\}$/.exec(template);
    const expansions = methodInterpolated
      ? { verb: ["search", "searchStream"], method: ["search", "searchStream"] }[methodInterpolated[1]] || []
      : [null];
    assert.ok(expansions.length > 0, `${entry} interpolates an unrecognised method name; add its values to this test`);

    for (const expansion of expansions) {
      const concrete = (expansion ? template.replace(/:\$\{\w+\}$/, `:${expansion}`) : template)
        // Any remaining interpolation is an id segment.
        .replace(/\$\{[^}]+\}/g, "123")
        .replace(/^customers\/X/, "customers/123")
        .split("?")[0];
      if (!concrete || concrete.includes("${")) continue;
      const key = normalizeKey(concrete);
      assert.ok(
        allowed.includes(key),
        `${entry} builds request key "${key}", which is not on the read-only allowlist`
      );
    }
  }

  function normalizeKey(target) {
    let value = target.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
    value = value.replace(/^v\d+(?=:)/, "").replace(/^v\d+\//, "").replace(/^\/+/, "");
    const [resource, method] = value.includes(":")
      ? [value.slice(0, value.lastIndexOf(":")), value.slice(value.lastIndexOf(":") + 1)]
      : [value, null];
    const pattern = resource.split("/").map((segment, index) => (index % 2 === 0 ? segment : "*")).join("/");
    return method === null ? pattern : `${pattern}:${method}`;
  }
});

test("the deny list still names the write RPC families we care about", () => {
  // A guard against someone trimming the deny list.
  const names = ADS_DENY_PATTERNS.map((pattern) => pattern.name);
  for (const required of ["mutate", "apply", "dismiss", "upload", "create", "update", "remove", "draft-generation", "batch-job"]) {
    assert.ok(names.includes(required), `the deny list no longer covers ${required}`);
  }
});

test("no Ads source file reads a global login-customer-id from the environment", () => {
  // The P0 bug: a global manager ID was sent for every account.
  for (const { file, text } of adsSources) {
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/process\.env\.GOOGLE_ADS_LOGIN_CUSTOMER_ID/.test(withoutComments),
      `${file} reads GOOGLE_ADS_LOGIN_CUSTOMER_ID, which must never be used as a default header`
    );
  }
});

test("no Ads source file requires a developer token", () => {
  for (const { file, text } of adsSources) {
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/requireEnv\(\s*["']GOOGLE_ADS_DEVELOPER_TOKEN/.test(withoutComments), `${file} still requires a developer token`);
  }
});
