// Skills: expert playbooks (skills/<name>/SKILL.md) served three ways, so every client gets them:
// - MCP prompts (prompts/list, prompts/get): the widest client support today.
// - skill:// resources (resources/list, resources/read): plain files any resource-aware client can read.
// - The skills extension (io.modelcontextprotocol/skills: skills/list, skills/get), for hosts that
//   load skills on demand. Declared on initialize; SDK v2 moves this to server/discover.
// Skills are only added to the server: no tool changes behavior.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
export const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
const SKILL_SCHEME = "skill://";
const TTL_MS = 300_000;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const INVALID_PARAMS = -32602;

// The small YAML subset SKILL.md frontmatter uses: `key: value` lines and one level of nested maps.
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter");
  const frontmatter = {};
  let parent = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const entry = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!entry) throw new Error(`Unsupported frontmatter line: ${line}`);
    const [, indent, key, raw] = entry;
    const value = raw.replace(/^(["'])(.*)\1$/, "$2");
    if (indent && parent) parent[key] = value;
    else if (!value) parent = frontmatter[key] = {};
    else { frontmatter[key] = value; parent = null; }
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

const digest = buffer => `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;

// Reads every skills/<name>/SKILL.md. A skill that breaks the spec's rules throws, so a bad file fails
// the tests instead of shipping.
export function loadSkills(dir = SKILLS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .map(name => {
      const buffer = fs.readFileSync(path.join(dir, name, "SKILL.md"));
      const text = buffer.toString("utf8");
      const { frontmatter, body } = parseFrontmatter(text);
      if (frontmatter.name !== name) throw new Error(`Skill folder ${name} must match its frontmatter name (${frontmatter.name})`);
      if (!NAME_PATTERN.test(name) || name.length > 64) throw new Error(`Invalid skill name: ${name}`);
      if (!frontmatter.description || frontmatter.description.length > 1024) throw new Error(`Skill ${name} needs a description of at most 1024 characters`);
      const uri = `${SKILL_SCHEME}${name}/SKILL.md`;
      const args = String(frontmatter.metadata?.arguments || "").split(",").map(arg => arg.trim()).filter(Boolean);
      const tools = String(frontmatter.metadata?.tools || "").split(/\s+/).filter(Boolean);
      return { name, uri, text, body, frontmatter, args, tools, resources: [{ uri, digest: digest(buffer), size: buffer.length }] };
    });
}

// What a skills/list or skills/get entry looks like on the wire.
const entryFor = skill => ({ uri: skill.uri, frontmatter: skill.frontmatter, resources: skill.resources });
const title = name => name.split("-").map(word => word === "ga4" || word === "seo" ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)).join(" ");

function promptText(skill, args) {
  const inputs = Object.entries(args || {}).filter(([, value]) => value).map(([key, value]) => `- ${key}: ${value}`);
  return [
    `Follow the "${skill.name}" playbook below using this server's tools.`,
    inputs.length ? `Inputs:\n${inputs.join("\n")}` : "Ask for any input you need that the tools can't look up.",
    "",
    skill.body.trim()
  ].join("\n");
}

const listSkillsRequest = z.object({ method: z.literal("skills/list"), params: z.object({ cursor: z.string().optional() }).passthrough().optional() });
const getSkillRequest = z.object({ method: z.literal("skills/get"), params: z.object({ uri: z.string() }).passthrough() });

function invalidParams(message) {
  const error = new Error(message);
  error.code = INVALID_PARAMS;
  return error;
}

// `isAvailable(skill)` hides a skill whose tools aren't on this connector (e.g. a profile without that platform).
export function registerSkills(server, { skills = loadSkills(), isAvailable = () => true } = {}) {
  const offered = skills.filter(isAvailable);
  if (!offered.length) return [];
  for (const skill of offered) {
    const argsSchema = Object.fromEntries(skill.args.map(arg => [arg, z.string().optional().describe(`Optional ${arg.replace(/_/g, " ")}`)]));
    server.registerPrompt(skill.name, {
      title: title(skill.name),
      description: skill.frontmatter.description,
      ...(skill.args.length ? { argsSchema } : {})
    }, args => ({
      description: skill.frontmatter.description,
      messages: [{ role: "user", content: { type: "text", text: promptText(skill, args) } }]
    }));
    server.registerResource(`skill-${skill.name}`, skill.uri, {
      title: `${title(skill.name)} skill`,
      description: skill.frontmatter.description,
      mimeType: "text/markdown"
    }, async uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: skill.text }] }));
  }

  const lowLevel = server.server;
  const byUri = new Map(offered.map(skill => [skill.uri, skill]));
  lowLevel.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } });
  lowLevel.setRequestHandler(listSkillsRequest, () => ({
    resultType: "complete", skills: offered.map(entryFor), ttlMs: TTL_MS, cacheScope: "public"
  }));
  lowLevel.setRequestHandler(getSkillRequest, request => {
    const skill = byUri.get(request.params.uri);
    if (!skill) throw invalidParams(`Unknown skill: ${request.params.uri}`);
    return { resultType: "complete", skill: entryFor(skill), ttlMs: TTL_MS, cacheScope: "public" };
  });
  return offered;
}
