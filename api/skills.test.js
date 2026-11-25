import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import http from "node:http";
import { loadSkills, parseFrontmatter, SKILLS_EXTENSION_ID } from "./_skills.js";

process.env.CONNECTIONS_STORE = "memory";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
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
  const google = { sessionId, refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/analytics.readonly", tokenType: "Bearer", userId: "skills-user" };
  const session = testSupport.saveSession(sessionId, google);
  return testSupport.mintAccessToken({ protocol: "http", get: () => new URL(baseUrl).host }, { sessionId, resource: `${baseUrl}/mcp`, scope: session.scope, google: session });
}

async function rpc(method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return response.json();
}

const skills = loadSkills();
const SOURCES = ["api/index.js", ...fs.readdirSync("api/connections").map(file => `api/connections/${file}`), "MCP GBP/tools.js"]
  .map(file => fs.readFileSync(file, "utf8")).join("\n");

test("every skill is valid and only names tools this server has", () => {
  assert.ok(skills.length >= 7);
  for (const skill of skills) {
    assert.match(skill.frontmatter.description, /Use when|Use for/, `${skill.name} description says when to use it`);
    assert.ok(skill.tools.length > 0, `${skill.name} lists its tools`);
    for (const tool of skill.tools) assert.ok(SOURCES.includes(`"${tool}"`), `${skill.name} uses unknown tool ${tool}`);
    for (const tool of skill.body.match(/`([a-z0-9]+_[a-z0-9_]+)`/g) || []) {
      const name = tool.slice(1, -1);
      // Tool and preset names both appear in the server source.
      assert.ok(SOURCES.includes(name), `${skill.name} body mentions unknown tool or preset ${name}`);
    }
    assert.match(skill.resources[0].digest, /^sha256:[0-9a-f]{64}$/);
  }
});

test("frontmatter parser reads nested metadata and rejects files without frontmatter", () => {
  const { frontmatter, body } = parseFrontmatter("---\nname: a\ndescription: \"b: c\"\nmetadata:\n  arguments: x, y\n---\n# Body\n");
  assert.deepEqual(frontmatter, { name: "a", description: "b: c", metadata: { arguments: "x, y" } });
  assert.equal(body, "# Body\n");
  assert.throws(() => parseFrontmatter("# no frontmatter"));
});

test("initialize declares prompts, resources and the skills extension", async () => {
  const { result } = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.ok(result.capabilities.prompts);
  assert.ok(result.capabilities.resources);
  assert.deepEqual(result.capabilities.extensions?.[SKILLS_EXTENSION_ID], {});
  assert.ok(result.capabilities.tools, "tools are still offered");
});

test("skills are listed as prompts and render with their inputs", async () => {
  const { result } = await rpc("prompts/list");
  const prompt = result.prompts.find(entry => entry.name === "youtube-video-repackage");
  assert.ok(prompt);
  assert.deepEqual(prompt.arguments.map(arg => [arg.name, arg.required]), [["channel", false], ["scope", false]]);
  const rendered = await rpc("prompts/get", { name: "youtube-video-repackage", arguments: { channel: "Jayant Respawn" } });
  const text = rendered.result.messages[0].content.text;
  assert.match(text, /- channel: Jayant Respawn/);
  assert.match(text, /# YouTube video repackage/);
});

test("skill files are readable as skill:// resources", async () => {
  const { result } = await rpc("resources/list");
  assert.ok(result.resources.some(entry => entry.uri === "skill://seo-audit/SKILL.md" && entry.mimeType === "text/markdown"));
  const read = await rpc("resources/read", { uri: "skill://seo-audit/SKILL.md" });
  assert.match(read.result.contents[0].text, /^---\nname: seo-audit\n/);
});

test("skills/list and skills/get follow the skills extension", async () => {
  const { result } = await rpc("skills/list");
  assert.equal(result.resultType, "complete");
  assert.equal(result.cacheScope, "public");
  const entry = result.skills.find(skill => skill.uri === "skill://google-ads-audit/SKILL.md");
  assert.equal(entry.frontmatter.name, "google-ads-audit");
  assert.equal(entry.resources[0].uri, entry.uri);
  const got = await rpc("skills/get", { uri: entry.uri });
  assert.deepEqual(got.result.skill, entry);
  const missing = await rpc("skills/get", { uri: "skill://nope/SKILL.md" });
  assert.equal(missing.error.code, -32602);
});
