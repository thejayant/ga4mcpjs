#!/usr/bin/env node
// Google Ads smoke test against real connections.
//
//   node scripts/ads-smoke.mjs --url https://ga4mcpjs.vercel.app/mcp --token "$MCP_TOKEN"
//   MCP_URL=... MCP_TOKEN=... node scripts/ads-smoke.mjs
//   node scripts/ads-smoke.mjs --self-check          # offline: no credentials needed
//
// It does three things, in this order:
//   1. lists the account directory
//   2. queries `customer` for every usable account it found
//   3. runs one keyword-planner call on 9529469947 with NO loginCustomerId
//
// Step 3 is the regression that mattered: that account used to fail with
// USER_PERMISSION_DENIED unless loginCustomerId was passed by hand.
//
// Everything it calls is read-only. Exit code 0 means every check passed.

import process from "node:process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const MCP_URL = flag("url", process.env.MCP_URL || "https://ga4mcpjs.vercel.app/mcp");
const MCP_TOKEN = flag("token", process.env.MCP_TOKEN || "");
const KEYWORD_PLANNER_ACCOUNT = flag("customer", process.env.ADS_SMOKE_CUSTOMER || "9529469947");

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
  return ok;
};

let requestId = 0;
async function callTool(name, toolArgs = {}) {
  requestId += 1;
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: toolArgs } })
  });
  const text = await response.text();
  let body;
  try {
    // A 2026-era endpoint may answer as SSE; take the last data: line if so.
    body = JSON.parse(text.includes("data:") ? text.split("data:").pop().trim() : text);
  } catch {
    throw new Error(`${name}: could not parse the response (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  if (body.error) throw new Error(`${name}: ${body.error.message || JSON.stringify(body.error)}`);
  const content = body.result?.structuredContent
    ?? (() => { try { return JSON.parse(body.result?.content?.[0]?.text || "null"); } catch { return null; } })();
  return { isError: body.result?.isError === true, payload: content, raw: body.result };
}

/* ---------------- offline self-check ---------------- */

// Validates the request shapes the Ads layer builds, without any credentials. This cannot
// prove the live accounts work, but it catches the shape regressions this work was about.
async function selfCheck() {
  console.log("Offline self-check (no credentials, no network).\n");
  const { assertReadOnly, ADS_ALLOWED_RPCS } = await import("../api/_google-ads/gate.js");
  const { resolveLoginCustomerId, stripSearchPageSize } = await import("../api/_google-ads/client.js");
  const { buildPlannerRequest, buildForecastCampaign } = await import("../api/_google-ads/keywords.js");
  const { buildReachForecastBody } = await import("../api/_google-ads/reach.js");
  const { GOOGLE_ADS_API_VERSION } = await import("../api/_google-ads/version.js");

  record("API version is pinned in one place", GOOGLE_ADS_API_VERSION === "v26", GOOGLE_ADS_API_VERSION);

  record(
    "write RPCs are refused without contacting Google",
    ["customers/1/campaigns:mutate", "customers/1/recommendations:apply", "customers/1:uploadClickConversions", "customers/1:generatePMaxDraftCampaign"]
      .every((path) => {
        try { assertReadOnly({ path, body: {} }); return false; } catch (error) { return error.code === "ADS_READ_ONLY"; }
      }),
    `${Object.keys(ADS_ALLOWED_RPCS).length} read RPCs allowlisted`
  );

  const header = resolveLoginCustomerId({ customerId: KEYWORD_PLANNER_ACCOUNT });
  record(
    "with no loginCustomerId the header falls back to the account itself",
    header.loginCustomerId === KEYWORD_PLANNER_ACCOUNT && header.source === "self",
    `${header.loginCustomerId} (${header.source})`
  );

  const searchBody = stripSearchPageSize("customers/1/googleAds:search", { query: "SELECT customer.id FROM customer", pageSize: 100 });
  record("no search body carries pageSize", !("pageSize" in searchBody));

  const ideas = buildPlannerRequest(
    { action: "ideas", customerId: KEYWORD_PLANNER_ACCOUNT, keywords: ["metal buildings"] },
    { geoTargetConstants: ["geoTargetConstants/2840"], language: "languageConstants/1000" }
  );
  record("keyword ideas request asks for average CPC", ideas.body.historicalMetricsOptions?.includeAverageCpc === true);

  const campaign = buildForecastCampaign({ keywords: ["metal buildings"], maxCpcBid: 2 });
  record(
    "forecast campaign uses only fields v26 accepts",
    !JSON.stringify(campaign).match(/keywordPlanNetwork|negativeKeywords|geoModifiers|biddableKeywords/),
    Object.keys(campaign).join(", ")
  );

  const reach = buildReachForecastBody({ customerId: "1", plannableLocationId: "2840", products: [{ code: "X", budget: 10 }] });
  record("reach forecast puts the location in targeting.plannableLocationIds", Array.isArray(reach.targeting?.plannableLocationIds) && !("plannableLocationId" in reach));

  return finish();
}

/* ---------------- live run ---------------- */

async function live() {
  console.log(`Google Ads smoke test against ${MCP_URL}\n`);

  // 1. the directory
  let directory;
  try {
    const { payload, isError } = await callTool("list_google_ads_accessible_customers", {});
    directory = payload;
    const accounts = payload?.accounts || [];
    record(
      "list the account directory",
      !isError && Array.isArray(accounts),
      `${accounts.length} account(s), ${payload?.usableCount ?? "?"} usable, across ${(payload?.googleAccounts || []).length} Google login(s)`
    );
    for (const note of payload?.notes || []) console.log(`      note: ${note}`);
    for (const account of accounts) {
      console.log(`      ${account.usable ? "usable  " : "unusable"} ${account.customerId}  ${account.name || "(no name)"}  ` +
        `[${account.status}${account.isManager ? ", manager" : ""}] via ${account.googleAccount}, header ${account.loginCustomerId}` +
        `${account.usable ? "" : ` -- ${account.usableReason}`}`);
    }
  } catch (error) {
    record("list the account directory", false, error.message);
    return finish();
  }

  // 2. query `customer` for each usable account, with no loginCustomerId
  const usable = (directory?.accounts || []).filter((account) => account.usable);
  if (!usable.length) record("query each usable account", false, "the directory reported no usable accounts");
  for (const account of usable) {
    try {
      const { payload, isError } = await callTool("query_google_ads", {
        customerId: account.customerId,
        query: "SELECT customer.id, customer.descriptive_name, customer.manager, customer.status, customer.currency_code, customer.time_zone FROM customer"
      });
      const row = payload?.rows?.[0]?.customer || payload?.rows?.[0] || null;
      record(
        `query customer ${account.customerId} (${account.name || "no name"}) with no loginCustomerId`,
        !isError && Boolean(row),
        isError
          ? `${payload?.error?.code}: ${payload?.error?.message}`
          : `${row?.descriptiveName || row?.descriptive_name || "?"}, manager=${row?.manager}, ${row?.status}` +
            ` (header ${payload?.routing?.loginCustomerId}, ${payload?.attempts?.length || 1} attempt(s))`
      );
    } catch (error) {
      record(`query customer ${account.customerId}`, false, error.message);
    }
  }

  // 3. the regression: keyword planner with NO loginCustomerId
  try {
    const { payload, isError } = await callTool("google_ads_keyword_planner", {
      action: "ideas",
      customerId: KEYWORD_PLANNER_ACCOUNT,
      keywords: ["metal buildings", "steel buildings"],
      geoTargets: ["United States"],
      language: "English",
      limit: 5
    });
    const keywords = payload?.keywords || [];
    record(
      `keyword planner on ${KEYWORD_PLANNER_ACCOUNT} with no loginCustomerId`,
      !isError && keywords.length > 0,
      isError
        ? `${payload?.error?.code}: ${payload?.error?.message}`
        : `${keywords.length} keyword(s); resolved ${JSON.stringify((payload?.resolvedTargeting?.locations || []).map((l) => l.canonicalName || l.id))}` +
          `; header ${payload?.routing?.loginCustomerId}`
    );
    for (const row of keywords.slice(0, 5)) {
      console.log(`      ${String(row.keyword).padEnd(34)} vol=${String(row.avgMonthlySearches).padStart(7)} ` +
        `cpc=${row.avgCpc ?? "-"} bid=${row.lowTopOfPageBid ?? "-"}..${row.highTopOfPageBid ?? "-"} ` +
        `peak=${row.peakMonth || "-"} trend3m=${row.trend3m ?? "-"}%${row.variants ? ` variants=${row.variants.length}` : ""}`);
    }
    if (payload?.quota) console.log(`      quota: ${payload.quota.usedToday ?? "?"} / ${payload.quota.limit ?? "unlimited"} today (${payload.quota.accessLevel})`);
  } catch (error) {
    record(`keyword planner on ${KEYWORD_PLANNER_ACCOUNT}`, false, error.message);
  }

  // 4. the read-only guarantee, over the wire
  try {
    const { payload, isError } = await callTool("query_google_ads", {
      customerId: KEYWORD_PLANNER_ACCOUNT,
      query: "UPDATE campaign SET status = 'PAUSED'"
    });
    record(
      "a non-SELECT query is refused",
      isError === true && /INVALID_QUERY/.test(JSON.stringify(payload)),
      payload?.code || payload?.error?.code || "refused"
    );
  } catch (error) {
    record("a non-SELECT query is refused", true, `rejected: ${error.message.slice(0, 80)}`);
  }

  return finish();
}

function finish() {
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("\nFailed:");
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail || ""}`);
  }
  process.exitCode = failed.length ? 1 : 0;
  return failed.length === 0;
}

if (has("self-check")) {
  await selfCheck();
} else if (!MCP_TOKEN) {
  console.error(
    "No MCP token. Either:\n" +
    "  node scripts/ads-smoke.mjs --self-check                      (offline shape checks)\n" +
    "  MCP_TOKEN=... node scripts/ads-smoke.mjs --url <your /mcp>   (against real connections)\n\n" +
    "The token is the bearer token your MCP client uses for this server."
  );
  process.exitCode = 2;
} else {
  await live();
}
