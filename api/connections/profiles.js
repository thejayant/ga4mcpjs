// Profiles: one connector URL per client. A profile names the connected account that answers for
// each platform (Google, Meta, CallRail), which other connected platforms it shows (Bing, Clarity,
// YouTube) and default IDs. Claude, ChatGPT or any MCP client adds /mcp/p/<slug> as its own
// connector, so switching client is switching connector; every request on that URL uses only the
// profile's accounts. The plain /mcp endpoint reaches any profile through the existing `account`
// argument ("profile:<slug>" or the profile's name) and through run_across_profiles.
import crypto from "node:crypto";
import { z } from "zod";

export const PROFILE_FAMILIES = { google: "Google", meta: "Meta", callrail: "CallRail" };
// Other connected platforms a profile can include, by the tool names they own.
export const PROFILE_PLATFORMS = { bing_webmaster: /^bing_webmaster_/, clarity: /^clarity_/, youtube: /^youtube_/ };
// Default IDs, keyed by the platform whose tools take them and the tool argument they fill.
export const PROFILE_DEFAULTS = {
  google: {
    propertyId: { label: "GA4 property ID", pattern: /^(properties\/)?\d+$/, placeholder: "123456789" },
    siteUrl: { label: "Search Console site", pattern: /^(sc-domain:\S+|https?:\/\/\S+)$/, placeholder: "sc-domain:example.com" },
    customerId: { label: "Google Ads customer ID", pattern: /^\d{3}-?\d{3}-?\d{4}$/, placeholder: "123-456-7890" },
    merchantAccountId: { label: "Merchant Center account ID", pattern: /^(accounts\/)?\d+$/, placeholder: "1234567" }
  },
  meta: {
    adAccountId: { label: "Meta ad account ID", pattern: /^(act_)?\d+$/, placeholder: "act_123456789" },
    pageId: { label: "Facebook Page ID", pattern: /^\d+$/, placeholder: "1234567890" }
  },
  callrail: {
    accountId: { label: "CallRail account ID", pattern: /^[A-Za-z0-9]+$/, placeholder: "ACC8154748ae6bd4e278a7cddd38a662f4f" }
  }
};
export const PROFILE_PREFIX = "profile:";
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const MAX_PROFILES = 50;
const MAX_RUN_PROFILES = 10;
const PER_PROFILE_MS = 20_000;
const TOTAL_BUDGET_MS = 45_000;

// A readable slug with a random suffix, so connector URLs can't be guessed from a client's name.
export function newSlug(name) {
  const base = String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 32).replace(/-+$/, "");
  return `${base || "profile"}-${crypto.randomBytes(3).toString("hex")}`;
}

export const profileUrl = (baseUrl, slug) => `${baseUrl}/mcp/p/${slug}`;

/**
 * Validates a profile submitted from the Connections page. `accountOptions` lists the account keys
 * each platform may use ("main" or a connection id), `platformOptions` the connected extra platforms,
 * `labels` the display name of each account key per platform. Returns { profile } or { error }.
 */
export function buildProfile(input, { accountOptions, platformOptions, youtubeOptions, labels = {}, existing } = {}) {
  const name = String(input.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) return { error: "Give the profile a name." };
  const accounts = {}, accountLabels = {};
  for (const [family, title] of Object.entries(PROFILE_FAMILIES)) {
    const value = String(input.accounts?.[family] || "").trim();
    if (!value) { accounts[family] = null; continue; }
    if (!accountOptions?.[family]?.includes(value)) return { error: `Pick a ${title} account from the list.` };
    accounts[family] = value;
    accountLabels[family] = labels[family]?.[value] || value;
  }
  const platforms = [...new Set([].concat(input.platforms || []).map(String))].filter(id => platformOptions?.includes(id));
  // YouTube: none, any connected channel ("any"), or one channel (its connection ID).
  let youtubeChannel = null;
  const youtube = String(input.youtubeChannel || "").trim();
  if (youtube) {
    const choice = (youtubeOptions || []).find(([value]) => value === youtube);
    if (youtube !== "any" && !choice) return { error: "Pick a YouTube channel from the list." };
    if (youtube === "any" && !(youtubeOptions || []).length) return { error: "Connect a YouTube channel first." };
    platforms.push("youtube");
    if (choice) { youtubeChannel = choice[0]; accountLabels.youtube = choice[1]; }
  }
  if (!Object.values(accounts).some(Boolean) && !platforms.length) return { error: "Choose at least one account or platform for this profile." };
  const defaults = {};
  for (const [family, fields] of Object.entries(PROFILE_DEFAULTS)) {
    for (const [arg, field] of Object.entries(fields)) {
      const value = String(input.defaults?.[family]?.[arg] || "").trim();
      if (!value) continue;
      if (!accounts[family]) return { error: `${field.label} needs a ${PROFILE_FAMILIES[family]} account in this profile.` };
      if (!field.pattern.test(value)) return { error: `${field.label} doesn't look right (for example ${field.placeholder}).` };
      (defaults[family] ||= {})[arg] = arg === "customerId" ? value.replace(/-/g, "") : value;
    }
  }
  return { profile: { slug: existing?.slug || newSlug(name), name, accounts, accountLabels, platforms, youtubeChannel, defaults, createdAt: existing?.createdAt || Date.now() } };
}

// A profile by "profile:<slug>", slug or name (case-insensitive).
export function findProfile(profiles, ref) {
  const wanted = String(ref || "").trim().toLowerCase();
  if (!wanted) return null;
  const slug = wanted.startsWith(PROFILE_PREFIX) ? wanted.slice(PROFILE_PREFIX.length) : wanted;
  return profiles.find(profile => profile.slug === slug) || profiles.find(profile => profile.name.toLowerCase() === slug) || null;
}

// Whether a profile connector offers a tool: platform tools only when the profile has that platform.
export function profileToolAllowed(profile, name, family) {
  if (family) return Boolean(profile.accounts?.[family]);
  const platform = Object.entries(PROFILE_PLATFORMS).find(([, pattern]) => pattern.test(name));
  return platform ? (profile.platforms || []).includes(platform[0]) : true;
}

/**
 * A tool's input shape on a profile connector: arguments the profile has a valid default for
 * become optional and say so. Returns { shape, defaults } with only the defaults that apply.
 */
export function profileShape(shape, defaults, profileName) {
  const applied = {}, next = { ...shape };
  for (const [arg, value] of Object.entries(defaults || {})) {
    const field = shape[arg];
    if (!field || typeof field.safeParse !== "function" || !field.safeParse(value).success) continue;
    applied[arg] = value;
    next[arg] = field.optional().describe(`${field.description ? `${field.description} ` : ""}Defaults to ${value} (profile "${profileName}").`);
  }
  return { shape: next, defaults: applied };
}

// What a model is told about a profile connector, in the MCP initialize instructions.
export function profileInstructions(profile) {
  const accounts = Object.entries(PROFILE_FAMILIES).filter(([family]) => profile.accounts?.[family])
    .map(([family, title]) => `${title}: ${profile.accountLabels?.[family] || profile.accounts[family]}`)
    .concat(profile.youtubeChannel ? [`YouTube channel: ${profile.accountLabels?.youtube || "set"}`] : []);
  const defaults = Object.values(profile.defaults || {}).flatMap(Object.entries).map(([arg, value]) => `${arg} ${value}`);
  return [
    `This connector is the profile "${profile.name}". Every request on it uses only this profile's accounts${accounts.length ? ` (${accounts.join("; ")})` : ""}.`,
    defaults.length ? `When an ID is left out, the profile's default is used: ${defaults.join(", ")}.` : "",
    "Tools for platforms outside this profile are not offered here. To work on another client, use that client's connector."
  ].filter(Boolean).join(" ");
}

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); })]).finally(() => clearTimeout(timer));
};

const resultData = outcome => {
  if (outcome?.structuredContent) return outcome.structuredContent;
  const text = outcome?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return text ?? null; }
};

/**
 * run_across_profiles, on the plain /mcp endpoint only. `registry` maps tool names to
 * { family, schema, handler, readOnly }; `profilesFor()` returns the caller's profiles (or throws);
 * `run(entry, name, args, account, extra)` calls a tool with the given account.
 */
export function registerRunAcrossProfiles(server, { registry, profilesFor, run, result }) {
  server.registerTool("run_across_profiles", {
    title: "Run Across Profiles",
    description: `Run one read-only Google, Meta or CallRail tool for several client profiles in turn and return the results side by side, for questions like "compare all my clients". Each profile uses its own accounts and fills IDs it has defaults for (GA4 property, Search Console site, Google Ads customer, Merchant Center account, Meta ad account and page, CallRail account), so leave those out of \`arguments\`. \`tool\` is the tool name (for example run_ga4_preset), \`profiles\` the profile names or slugs (default: all, at most ${MAX_RUN_PROFILES}). Profiles run one at a time; one that fails or runs out of time is reported and the others still answer.`,
    inputSchema: {
      tool: z.string().min(1).max(100),
      arguments: z.record(z.any()).optional(),
      profiles: z.array(z.string().min(1).max(100)).min(1).max(MAX_RUN_PROFILES).optional()
    },
    annotations: { readOnlyHint: true }
  }, async ({ tool, arguments: args = {}, profiles: wanted }, extra) => {
    const entry = registry.get(tool);
    if (!entry || tool === "run_across_profiles") return result({ error: "unknown_tool", error_description: `No Google, Meta or CallRail tool called "${tool}".` }, true);
    if (!entry.readOnly) return result({ error: "not_read_only", error_description: `${tool} changes data, so it runs only on one profile at a time: call it on that profile's connector or with account "profile:<slug>".` }, true);
    let all;
    try { all = await profilesFor(); } catch (error) { return result({ error: "profiles_unavailable", error_description: error.message }, true); }
    if (!all.length) return result({ error: "no_profiles", error_description: "No profiles yet. Create them on the Connections page (manage_connections gives the link)." }, true);
    const chosen = [];
    for (const ref of wanted || all.map(profile => profile.slug)) {
      const profile = findProfile(all, ref);
      if (!profile) return result({ error: "unknown_profile", error_description: `No profile called "${ref}". Profiles: ${all.map(p => `${p.name} (${p.slug})`).join(", ")}.` }, true);
      if (!chosen.includes(profile)) chosen.push(profile);
    }
    const started = Date.now(), results = [];
    for (const profile of chosen.slice(0, MAX_RUN_PROFILES)) {
      const row = { profile: profile.name, slug: profile.slug };
      if (!profile.accounts?.[entry.family]) { results.push({ ...row, skipped: `no ${PROFILE_FAMILIES[entry.family]} account in this profile` }); continue; }
      if (Date.now() - started > TOTAL_BUDGET_MS) { results.push({ ...row, skipped: "time budget used up; ask again for this profile" }); continue; }
      const parsed = entry.schema.safeParse({ ...(profile.defaults?.[entry.family] || {}), ...args });
      if (!parsed.success) {
        results.push({ ...row, error: "invalid_arguments", details: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".") || "arguments"}: ${issue.message}`) });
        continue;
      }
      try {
        const outcome = await withTimeout(run(entry, tool, parsed.data, `${PROFILE_PREFIX}${profile.slug}`, extra), PER_PROFILE_MS);
        if (outcome?.timedOut) results.push({ ...row, error: "timed_out", error_description: `No answer within ${PER_PROFILE_MS / 1000} seconds.` });
        else results.push({ ...row, ok: !outcome?.isError, data: resultData(outcome) });
      } catch (error) {
        results.push({ ...row, error: "tool_execution_failed", error_description: error.message });
      }
    }
    const omitted = chosen.slice(MAX_RUN_PROFILES).map(profile => profile.name);
    return result({ tool, profiles: results, ...(omitted.length ? { omitted, note: `At most ${MAX_RUN_PROFILES} profiles per call; ask again for the rest.` } : {}) });
  });
}
