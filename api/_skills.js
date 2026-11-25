// Skills: expert playbooks (skills/<name>/SKILL.md) served two ways, so every client gets them:
// - MCP prompts (prompts/list, prompts/get): the widest client support today.
// - The skills extension (io.modelcontextprotocol/skills, SEP-2640) through the SDK's SkillCatalog:
//   skills/list, skills/get and skill:// resources. 2026-07-28 clients see it in server/discover,
//   2025-era clients in the initialize capabilities.
// Skills are only added to the server: no tool changes behavior.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SKILLS_EXTENSION_ID, SkillsExtension, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";

export { SKILLS_EXTENSION_ID };
export const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
const SKILL_SCHEME = "skill://";
const CACHE_HINT = { ttlMs: 300_000, cacheScope: "public" };
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
      // LF line endings whatever the checkout (Git on Windows may write CRLF), so the text and its
      // digest are the same on every machine.
      const text = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8").replace(/\r\n?/g, "\n");
      const buffer = Buffer.from(text, "utf8");
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

// One SDK catalog per distinct set of offered skills (usually one or two per deployment), built once.
const catalogs = new Map();
function catalogFor(skills) {
  const key = skills.map(skill => skill.name).join(",");
  if (!catalogs.has(key)) {
    const files = Object.fromEntries(skills.map(skill => [`${skill.name}/SKILL.md`, skill.text]));
    const loading = SkillsExtension.load(memorySkillFiles(files), { strict: true, cacheHint: CACHE_HINT });
    loading.catch(() => catalogs.delete(key));
    catalogs.set(key, loading);
  }
  return catalogs.get(key);
}

// `isAvailable(skill)` hides a skill whose tools aren't on this connector (e.g. a profile without that platform).
// Async because the catalog computes digests once; attach before the server connects.
export async function registerSkills(server, { skills = loadSkills(), isAvailable = () => true } = {}) {
  const offered = skills.filter(isAvailable);
  if (!offered.length) return [];
  for (const skill of offered) {
    const argsSchema = Object.fromEntries(skill.args.map(arg => [arg, z.string().optional().describe(`Optional ${arg.replace(/_/g, " ")}`)]));
    server.registerPrompt(skill.name, {
      title: title(skill.name),
      description: skill.frontmatter.description,
      ...(skill.args.length ? { argsSchema: z.object(argsSchema) } : {})
    }, args => ({
      description: skill.frontmatter.description,
      messages: [{ role: "user", content: { type: "text", text: promptText(skill, args) } }]
    }));
  }
  (await catalogFor(offered)).attach(server);
  return offered;
}
