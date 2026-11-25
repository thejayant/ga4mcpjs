// Both protocol eras against the real HTTP endpoint: 2025-era clients (initialize, one JSON response)
// must see exactly what they saw on SDK v1, and 2026-07-28 clients get the same tools over server/discover.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.ENABLE_MARKETING_DASHBOARD = "true";
const { default: app, testSupport } = await import("./index.js");

let server, baseUrl;
before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = baseUrl;
});
after(() => new Promise(resolve => server.close(resolve)));

function token() {
  const sessionId = `s-${Math.random()}`;
  const google = { sessionId, refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId: "protocol-user" };
  const session = testSupport.saveSession(sessionId, google);
  return testSupport.mintAccessToken({ protocol: "http", get: () => new URL(baseUrl).host }, { sessionId, resource: `${baseUrl}/mcp`, scope: session.scope, google: session });
}

async function legacy(method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  assert.match(response.headers.get("content-type"), /application\/json/, "2025-era answers stay plain JSON");
  return response.json();
}

async function modernClient() {
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token()}` } } }));
  return client;
}

test("2025-era initialize still negotiates a 2025 revision", async () => {
  const { result } = await legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } });
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.equal(result.serverInfo.name, "marketing-data-mcp");
});

test("both eras list the same tools, and the dashboard keeps its app metadata", async () => {
  const old = (await legacy("tools/list")).result.tools;
  const client = await modernClient();
  try {
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    const modern = (await client.listTools()).tools;
    assert.deepEqual(modern.map(tool => tool.name).sort(), old.map(tool => tool.name).sort());
    for (const tools of [old, modern]) {
      const opener = tools.find(tool => tool.name === "open_marketing_dashboard");
      assert.ok(opener?._meta?.ui?.resourceUri?.startsWith("ui://"));
      assert.deepEqual(opener._meta["openai/ui"].entrypoints, [{ type: "global" }, { type: "thread" }]);
      const report = tools.find(tool => tool.name === "run_ga4_report");
      assert.ok(report.inputSchema.properties.propertyId, "input schemas still convert to JSON Schema");
      assert.ok(report.inputSchema.properties.account, "the account input is still added");
    }
  } finally {
    await client.close();
  }
});

test("a 2026-07-28 client calls tools and reads the dashboard resource", async () => {
  const client = await modernClient();
  try {
    const presets = await client.callTool({ name: "list_marketing_presets", arguments: {} });
    assert.ok(!presets.isError);
    assert.ok(presets.content[0].text.length > 100);
    const { resources } = await client.listResources();
    const dashboard = resources.find(resource => resource.uri.startsWith("ui://"));
    const read = await client.readResource({ uri: dashboard.uri });
    assert.match(read.contents[0].mimeType, /mcp-app/);
  } finally {
    await client.close();
  }
});
