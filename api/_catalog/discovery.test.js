// find_marketing_data against the server's real definitions, over HTTP. This is the test
// that catches the catalog drifting from what the server can actually do.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";

process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.META_GRAPH_API_VERSION = "v23.0";

const { default: app, testSupport } = await import("../index.js");

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
    scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId: "catalog-user"
  };
  const session = testSupport.saveSession(sessionId, google);
  return testSupport.mintAccessToken(
    { protocol: "http", get: () => new URL(baseUrl).host },
    { sessionId, resource: `${baseUrl}/mcp`, scope: session.scope, google: session }
  );
}

async function find(args) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_marketing_data", arguments: args } })
  });
  return (await response.json()).result.structuredContent;
}

test("the catalog covers every platform the server serves", async () => {
  const result = await find({ query: "campaign" });
  const platforms = result.catalog.platforms;
  for (const expected of ["google_ads", "ga4", "search_console", "merchant_center", "meta", "callrail"]) {
    assert.ok(platforms.includes(expected), `catalog is missing ${expected}`);
  }
  assert.ok(result.catalog.entryCount > 200, `expected a substantial catalog, got ${result.catalog.entryCount}`);
});

test("plain-language questions route to the right tool with runnable arguments", async () => {
  const cases = [
    { query: "phone calls", expectPlatform: "callrail" },
    { query: "branded queries", expectId: "branded_vs_non_branded" },
    { query: "product listing issues", expectPlatform: "merchant_center" },
    { query: "keyword rankings", expectPlatform: "search_console" }
  ];
  for (const testCase of cases) {
    const result = await find({ query: testCase.query, limit: 6 });
    assert.ok(result.matchCount > 0, `no matches for "${testCase.query}"`);
    if (testCase.expectId) {
      assert.ok(result.matches.some((match) => match.id === testCase.expectId), `"${testCase.query}" did not surface ${testCase.expectId}`);
    }
    if (testCase.expectPlatform) {
      assert.ok(
        result.matches.some((match) => (Array.isArray(match.platform) ? match.platform : [match.platform]).includes(testCase.expectPlatform)),
        `"${testCase.query}" did not surface ${testCase.expectPlatform}`
      );
    }
  }
});

test("every preset match names a real tool and its id argument", async () => {
  const result = await find({ query: "performance", kind: "preset", limit: 20 });
  assert.ok(result.matches.length);
  for (const match of result.matches) {
    assert.ok(match.call?.tool, `${match.id} has no call`);
    assert.equal(match.call.arguments.preset, match.id);
    // The placeholder names the id the caller has to supply.
    const placeholder = Object.entries(match.call.arguments).find(([key]) => key !== "preset");
    assert.ok(placeholder && /^<.+>$/.test(placeholder[1]), `${match.id} does not show which id to pass`);
  }
});

test("data that no API exposes is reported as unavailable", async () => {
  const result = await find({ query: "auction insights" });
  assert.ok(result.notAvailable?.length, "auction insights should be reported unavailable");
  assert.match(result.notAvailable[0].limitation, /not exposed/i);
});

test("the new Search Console capabilities are discoverable", async () => {
  // Anything added to the tools should be findable here, or models will never use it.
  const branded = await find({ query: "branded", platform: "search_console" });
  assert.ok(branded.matchCount > 0);
});

test("a field match says which platforms have it and which do not", async () => {
  const result = await find({ query: "cost", kind: "field", limit: 10 });
  const withNatives = result.matches.find((match) => match.nativeFields);
  assert.ok(withNatives, "no field match carried native names");
  assert.ok(Object.keys(withNatives.nativeFields).length > 1, "a cross-platform field should list several platforms");
});

test("find_marketing_data is read-only and needs no account", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  const tool = (await response.json()).result.tools.find((entry) => entry.name === "find_marketing_data");
  assert.ok(tool, "find_marketing_data is not registered");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(tool.inputSchema.required, ["query"]);
});
