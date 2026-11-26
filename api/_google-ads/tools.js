// Every Google Ads MCP tool, registered in one place on the shared read-only request path.
//
// All of these are reads. Each carries readOnlyHint: true, destructiveHint: false and says
// "read-only" in its description, and every request goes through the gate in gate.js.

import { z } from "zod";
import { adsRequest, countAdsRequest, normalizeCustomerId, readOnlyNotice } from "./client.js";
import { directoryEntry, directoryListing, findByName, getAccountDirectory, allManagers, managersFor } from "./directory.js";
import { normalizeLocalError } from "./errors.js";
import { assertSelectQuery, withGaqlLimit } from "./gaql.js";
import { runKeywordBatch, runKeywordPlanner } from "./keywords.js";
import { NEW_GOOGLE_ADS_PRESETS, NEW_PRESET_NAMES, runBenchmarks, runLocalServicesEligibility, runNewPreset } from "./presets.js";
import { runReachPlanner } from "./reach.js";
import { googleAdsVersionInfo } from "./version.js";

export const GOOGLE_ADS_TOOL_NAMES = Object.freeze([
  "list_google_ads_accessible_customers", "list_google_ads_customer_clients",
  "query_google_ads", "search_stream_google_ads",
  "run_google_ads_preset", "run_google_ads_across_accounts",
  "google_ads_keyword_planner", "google_ads_keyword_research_batch",
  "google_ads_reach_planner", "google_ads_benchmarks",
  "google_ads_local_services_eligibility",
  "get_google_ads_field", "search_google_ads_fields"
]);

// Shared, optional inputs. Nothing here is required, so no existing call site breaks.
const customerIdInput = z.string().min(1).optional()
  .describe("The Google Ads customer ID (dashes optional). Routing is automatic: the right Google account and login-customer-id header are chosen from the cached account directory, so loginCustomerId is almost never needed.");
const customerNameInput = z.string().min(1).optional()
  .describe('Instead of customerId: an account name, matched loosely (for example "ideal steel"). If several accounts match, the candidates are returned rather than one being guessed.');
const loginCustomerIdInput = z.string().min(1).optional()
  .describe("Override the login-customer-id header. Normally omit it: the directory supplies the manager that works, and the request retries under the account itself and then each known manager if Google refuses.");
const refreshInput = z.boolean().optional().describe("Rebuild the cached account directory (normally cached for 12h).");
const debugInput = z.boolean().optional().describe("Include Google's raw error payload (credentials redacted) when a call fails.");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/**
 * @param {object} deps
 * @param {object} deps.req
 * @param {Function} deps.withVerifiedToolAuth
 * @param {Function} deps.buildToolResult
 * @param {object|null} deps.store            connection store (cache + quota)
 * @param {string[]} deps.scopes              the Ads OAuth scope list
 * @param {Function} deps.googleAccountsFor   async (auth) => [{ label, accessToken }]
 * @param {object} deps.legacyPresets         existing GOOGLE_ADS_PRESET_DEFINITIONS
 * @param {Function} deps.buildLegacyPresetQuery
 * @param {Function} deps.normalizeLegacyPresetRows
 * @param {object} deps.normalizedSchema
 */
export function registerGoogleAdsTools(server, deps) {
  const {
    req, withVerifiedToolAuth, buildToolResult, store, scopes,
    googleAccountsFor, legacyPresets, buildLegacyPresetQuery, normalizeLegacyPresetRows, normalizedSchema
  } = deps;

  const result = (payload, isError = false) => buildToolResult({
    googleAds: "read-only",
    api: googleAdsVersionInfo(),
    ...payload
  }, isError);

  const failed = (error) => result(normalizeLocalError(error, { debug: false }), true);

  // The directory for this user, built across every connected Google account and cached.
  async function directoryFor(auth, { refresh = false } = {}) {
    const accounts = await googleAccountsFor(auth);
    return getAccountDirectory({ userId: auth.userId, accounts, store, refresh });
  }

  /**
   * Resolves customerId / customerName into a concrete account plus its routing context.
   * Returns { ambiguous } or { missing } instead of guessing.
   */
  async function resolveTarget(auth, params, { required = true } = {}) {
    const directory = await directoryFor(auth, { refresh: params.refresh === true });

    if (params.customerName && !params.customerId) {
      const found = findByName(directory, params.customerName);
      if (found.candidates?.length) {
        return {
          directory,
          ambiguous: {
            error: "ambiguous_customer_name",
            customerName: params.customerName,
            message: found.candidates.length
              ? `"${params.customerName}" matches ${found.candidates.length} accounts. Pass customerId for the one you mean.`
              : `No Google Ads account name matches "${params.customerName}".`,
            candidates: found.candidates.map((entry) => ({
              customerId: entry.customerId, name: entry.name, status: entry.status, usable: entry.usable, googleAccount: entry.googleAccount
            }))
          }
        };
      }
      if (!found.match) {
        return {
          directory,
          ambiguous: {
            error: "unknown_customer_name",
            message: `No Google Ads account name matches "${params.customerName}". Call list_google_ads_accessible_customers to see the accounts this login can read.`,
            candidates: []
          }
        };
      }
      return context(directory, found.match.customerId);
    }

    const customerId = normalizeCustomerId(params.customerId);
    if (!customerId) {
      if (!required) return { directory, customerId: null, entry: null, managerIds: [] };
      return {
        directory,
        ambiguous: {
          error: "customer_id_required",
          message: "Pass customerId, or customerName to look one up by name.",
          candidates: directoryListing(directory).accounts.filter((account) => account.usable).slice(0, 25)
        }
      };
    }
    return context(directory, customerId);

    function context(dir, id) {
      const entry = directoryEntry(dir, id);
      return { directory: dir, customerId: id, entry, managerIds: managersFor(dir, id) };
    }
  }

  // The per-call context handed to the Ads modules.
  const callContext = (auth, target, params = {}) => ({
    accessToken: auth.googleCredentials.accessToken,
    store,
    directoryEntry: target.entry,
    managerIds: target.managerIds,
    debug: params.debug === true
  });

  // Routing information echoed back so a caller can see which account answered.
  const routing = (target) => ({
    customerId: target.customerId,
    ...(target.entry
      ? {
          accountName: target.entry.name,
          googleAccount: target.entry.googleAccount,
          loginCustomerId: target.entry.managerCustomerId || target.entry.loginCustomerId,
          status: target.entry.status,
          usable: target.entry.usable,
          ...(target.entry.usable ? {} : { usableReason: target.entry.usableReason })
        }
      : { note: "This customer is not in the cached account directory; the request used the customer ID as its own login-customer-id header." })
  });

  /* ---------------- item 6: the directory as the listing ---------------- */

  server.registerTool("list_google_ads_accessible_customers", {
    title: "List Google Ads Accounts",
    description:
      "Read-only. Every Google Ads account this user can reach, across all connected Google logins, with id, name, " +
      "status, manager flag, currency, time zone, the owning Google account and the login-customer-id header that " +
      "works, plus usable true/false with a reason. An account with no Ads access is reported as an explicit empty " +
      "list with a note. Built once and cached for 12h; pass refresh to rebuild.",
    inputSchema: { refresh: refreshInput, debug: debugInput },
    annotations: READ_ONLY
  }, async (params = {}) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      const directory = await directoryFor(auth, { refresh: params.refresh === true });
      const listing = directoryListing(directory);
      return result({
        ...listing,
        fromCache: directory.fromCache === true,
        requestCount: directory.requestCount ?? null,
        ...(listing.accountCount === 0
          ? { message: "None of the connected Google logins is a user on any Google Ads account. Add the login as a user in Google Ads (Admin, then Access and security), or connect a different Google account from manage_connections." }
          : {})
      });
    } catch (error) {
      return failed(error);
    }
  }));

  /* ---------------- item 7: customerId optional ---------------- */

  server.registerTool("list_google_ads_customer_clients", {
    title: "List Google Ads Customer Clients",
    description:
      "Read-only. Walks a Google Ads manager (MCC) account tree and returns every child account with id, name, " +
      "currency, time zone, level and manager flag. With customerId omitted it walks every manager in the account " +
      "directory. Use this when the account listing only shows a manager account.",
    inputSchema: {
      customerId: customerIdInput,
      customerName: customerNameInput,
      loginCustomerId: loginCustomerIdInput,
      includeDisabled: z.boolean().optional(),
      maxLevel: z.number().int().min(0).max(10).optional(),
      limit: z.number().int().min(1).max(10000).optional(),
      refresh: refreshInput,
      debug: debugInput
    },
    annotations: READ_ONLY
  }, async (params = {}) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      const target = await resolveTarget(auth, params, { required: false });
      if (target.ambiguous) return result(target.ambiguous, true);

      // No customerId: walk every manager the directory knows (item 7).
      const managers = target.customerId
        ? [{ customerId: target.customerId, entry: target.entry, managerIds: target.managerIds }]
        : allManagers(target.directory).map((entry) => ({ customerId: entry.customerId, entry, managerIds: managersFor(target.directory, entry.customerId) }));

      if (!managers.length) {
        return result({
          managers: [], accountCount: 0, accounts: [],
          message: "No manager (MCC) account is in the directory, so there is no account tree to walk. Pass customerId explicitly, or check list_google_ads_accessible_customers."
        });
      }

      const limit = params.limit || 1000;
      const clauses = [];
      if (!params.includeDisabled) clauses.push("customer_client.status = 'ENABLED'");
      if (params.maxLevel !== undefined) clauses.push(`customer_client.level <= ${params.maxLevel}`);
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";

      const walked = [];
      for (const manager of managers) {
        // v26 search takes no pageSize: the row ceiling is a GAQL LIMIT.
        const query = withGaqlLimit(
          "SELECT customer_client.id, customer_client.client_customer, customer_client.descriptive_name, " +
          "customer_client.currency_code, customer_client.time_zone, customer_client.level, customer_client.manager, " +
          `customer_client.status, customer_client.test_account FROM customer_client${where} ORDER BY customer_client.level ASC`,
          limit
        );
        const response = await adsRequest({
          path: `customers/${manager.customerId}/googleAds:search`,
          accessToken: auth.googleCredentials.accessToken,
          body: { query },
          customerId: manager.customerId,
          loginCustomerId: params.loginCustomerId || manager.customerId,
          directoryEntry: manager.entry,
          managerIds: manager.managerIds,
          store,
          debug: params.debug === true
        });
        walked.push({
          managerCustomerId: manager.customerId,
          managerName: manager.entry?.name || null,
          ok: response.ok,
          gaql: query,
          attempts: response.attempts,
          accounts: response.ok
            ? (response.body?.results || []).map((row) => shapeClient(row))
            : [],
          ...(response.ok ? {} : { error: response.error })
        });
      }

      const accounts = walked.flatMap((entry) => entry.accounts);
      return result({
        managersWalked: walked.length,
        accountCount: accounts.length,
        accounts,
        managers: walked.map(({ accounts: _rows, ...rest }) => rest),
        // Guardrails deliberately live in list_marketing_guardrails only (item 19).
        quota: walked[walked.length - 1]?.attempts ? await countAdsRequest(store, 0) : undefined
      }, walked.every((entry) => !entry.ok));
    } catch (error) {
      return failed(error);
    }
  }));

  /* ---------------- GAQL reads ---------------- */

  const gaqlShape = {
    customerId: customerIdInput,
    customerName: customerNameInput,
    query: z.string().min(1).describe("A GAQL SELECT ... FROM ... read. Anything else is rejected: this server is read-only."),
    loginCustomerId: loginCustomerIdInput,
    limit: z.number().int().min(1).max(10000).optional().describe("Row ceiling, applied as a GAQL LIMIT. v26 search has no pageSize; pages are a fixed 10,000 rows."),
    pageToken: z.string().optional(),
    refresh: refreshInput,
    debug: debugInput
  };

  server.registerTool("query_google_ads", {
    title: "Query Google Ads",
    description:
      "Read-only GAQL query against a Google Ads customer: campaigns, ad groups, ads, keywords, assets, conversions, " +
      "placements, audiences, search terms and reporting. Only SELECT ... FROM ... is accepted. Routing is automatic " +
      "from customerId (or customerName), and a permission failure retries under the account itself and then each " +
      "known manager.",
    inputSchema: gaqlShape,
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => runGaql(auth, params, "search")));

  server.registerTool("search_stream_google_ads", {
    title: "Search Stream Google Ads",
    description:
      "Read-only streamed GAQL query, for large Google Ads result sets. Only SELECT ... FROM ... is accepted. " +
      "Routing and permission retries work as in query_google_ads.",
    inputSchema: {
      ...gaqlShape,
      summaryRowSetting: z.enum(["NO_SUMMARY_ROW", "SUMMARY_ROW_WITH_RESULTS", "SUMMARY_ROW_ONLY"]).optional()
    },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => runGaql(auth, params, "searchStream")));

  async function runGaql(auth, params, verb) {
    try {
      // Reject anything that is not a SELECT read before touching the network.
      const query = withGaqlLimit(assertSelectQuery(params.query), params.limit);
      const target = await resolveTarget(auth, params);
      if (target.ambiguous) return result(target.ambiguous, true);

      const response = await adsRequest({
        path: `customers/${target.customerId}/googleAds:${verb}`,
        accessToken: auth.googleCredentials.accessToken,
        body: {
          query,
          ...(verb === "search" && params.pageToken ? { pageToken: params.pageToken } : {}),
          ...(verb === "searchStream" && params.summaryRowSetting ? { summaryRowSetting: params.summaryRowSetting } : {})
        },
        customerId: target.customerId,
        loginCustomerId: params.loginCustomerId,
        directoryEntry: target.entry,
        managerIds: target.managerIds,
        store,
        debug: params.debug === true
      });

      const rows = verb === "searchStream"
        ? (Array.isArray(response.body) ? response.body.flatMap((chunk) => chunk?.results || []) : response.body?.results || [])
        : response.body?.results || [];

      return result({
        routing: routing(target),
        gaql: query,
        attempts: response.attempts,
        quota: response.quota,
        ...(response.ok
          ? { ok: true, rowCount: rows.length, rows, nextPageToken: response.body?.nextPageToken || null }
          : { ok: false, error: response.error })
      }, !response.ok);
    } catch (error) {
      return failed(error);
    }
  }

  /* ---------------- presets: existing plus the new v25/v26 ones ---------------- */

  const legacyPresetNames = Object.keys(legacyPresets);
  const allPresetNames = [...legacyPresetNames, ...NEW_PRESET_NAMES];

  server.registerTool("run_google_ads_preset", {
    title: "Run Google Ads Preset",
    description:
      "Read-only expert Google Ads reports via GAQL. Covers campaigns, ad groups, keywords, search terms, ads, assets, " +
      "impression share, Quality Score, Shopping, Performance Max, geo, device, ad schedule, demographics, audiences, " +
      "placements, conversion actions, landing pages, budgets, bidding strategies, video, calls and account overview, " +
      "plus read-only recommendations and the v25/v26 reports: AI Max migration status, enhanced conversions audit, " +
      "budget network settings, Local Services campaigns and leads, lift studies, unique reach 1+ to 10+, and " +
      "deprecation audits for call ads, manual language criteria and Smart campaigns. " +
      "Call list_marketing_presets for the full catalogue. One call is one Google Ads API request.",
    inputSchema: {
      preset: z.enum(allPresetNames),
      customerId: customerIdInput,
      customerName: customerNameInput,
      loginCustomerId: loginCustomerIdInput,
      campaignId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().min(1).max(100000).optional(),
      includeDailyBreakdown: z.boolean().optional(),
      includeImpressionShare: z.boolean().optional(),
      includeQualityScore: z.boolean().optional(),
      orderBy: z.string().optional(),
      extraWhereClauses: z.array(z.string()).optional(),
      pageToken: z.string().optional(),
      refresh: refreshInput,
      debug: debugInput
    },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      const target = await resolveTarget(auth, params);
      if (target.ambiguous) return result(target.ambiguous, true);

      // A new v25/v26 preset.
      if (NEW_GOOGLE_ADS_PRESETS[params.preset]) {
        const outcome = await runNewPreset({
          preset: params.preset,
          params: { ...params, customerId: target.customerId },
          context: callContext(auth, target, params)
        });
        return result({ routing: routing(target), ...outcome }, outcome.ok === false);
      }

      // An existing preset: unchanged query building, on the new request path.
      let config;
      try {
        config = buildLegacyPresetQuery({ ...params, customerId: target.customerId });
      } catch (error) {
        return result({
          error: "invalid_google_ads_preset_request",
          error_description: error instanceof Error ? error.message : String(error),
          preset: params.preset,
          presetCatalog: legacyPresets[params.preset] || null
        }, true);
      }

      const query = withGaqlLimit(config.query, config.limit);
      const response = await adsRequest({
        path: `customers/${target.customerId}/googleAds:search`,
        accessToken: auth.googleCredentials.accessToken,
        // No pageSize: v26 search rejects it (item 2).
        body: { query, ...(params.pageToken ? { pageToken: params.pageToken } : {}) },
        customerId: target.customerId,
        loginCustomerId: params.loginCustomerId,
        directoryEntry: target.entry,
        managerIds: target.managerIds,
        store,
        debug: params.debug === true
      });

      return result({
        preset: params.preset,
        routing: routing(target),
        entityType: config.entityType,
        resource: config.resource,
        timeSeries: config.timeSeries,
        dateRange: config.dateRange,
        limit: config.limit,
        notes: config.notes,
        gaql: query,
        attempts: response.attempts,
        quota: response.quota,
        normalizedSchema,
        ...(response.ok
          ? {
              ok: true,
              nextPageToken: response.body?.nextPageToken || null,
              rowCount: (response.body?.results || []).length,
              normalizedRows: normalizeLegacyPresetRows(params.preset, response.body)
            }
          : { ok: false, error: response.error })
      }, !response.ok);
    } catch (error) {
      return failed(error);
    }
  }));

  /* ---------------- keyword planner ---------------- */

  const plannerTargeting = {
    language: z.string().optional().describe('Language by name ("English"), ISO code ("en") or Google\'s numeric ID. Defaults to English.'),
    geoTargets: z.array(z.string()).max(10).optional().describe('Locations by name ("California", "Sacramento, California", "United States") or numeric geo target ID. Names are resolved and the IDs echoed back.'),
    geoCountryCode: z.string().length(2).optional().describe("Bias name resolution to one country, for example US."),
    network: z.enum(["GOOGLE_SEARCH", "GOOGLE_SEARCH_AND_PARTNERS"]).optional(),
    includeAdultKeywords: z.boolean().optional()
  };

  const plannerOutput = {
    detail: z.enum(["compact", "full"]).optional().describe("compact (default) returns one summary row per keyword; full adds the 12 monthly volumes."),
    groupVariants: z.boolean().optional().describe("Default true: collapse close variants Google reports identical metrics for into one row."),
    minVolume: z.number().int().min(0).optional(),
    maxVolume: z.number().int().min(0).optional(),
    includeTerms: z.array(z.string()).max(50).optional().describe("Keep only keywords containing one of these terms."),
    excludeTerms: z.array(z.string()).max(50).optional().describe("Drop keywords containing any of these terms, for example competitor brands."),
    sortBy: z.enum(["volume", "bid", "competition"]).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    refresh: z.boolean().optional().describe("Bypass the 24h result cache and ask Google again.")
  };

  server.registerTool("google_ads_keyword_planner", {
    title: "Google Ads Keyword Planner",
    description:
      "Read-only keyword research. ideas: new keywords from seed keywords, a URL, both, or a whole site. " +
      "historical_metrics: 12-month volume and bids for keywords you already have. forecast: projected clicks, cost " +
      "and conversions for a keyword set under a chosen bidding strategy. Locations and languages can be given by " +
      "name. Output is compact by default and cached for 24h. Google limits these methods to 1 request per second " +
      "per account.",
    inputSchema: {
      action: z.enum(["ideas", "historical_metrics", "forecast"]),
      customerId: customerIdInput,
      customerName: customerNameInput,
      loginCustomerId: loginCustomerIdInput,
      keywords: z.array(z.string().min(1)).max(20).optional(),
      url: z.string().optional().describe("A page URL. With keywords this is a KeywordAndUrlSeed; alone, a UrlSeed."),
      site: z.string().optional().describe("A whole site (SiteSeed). Cannot be combined with keywords or url."),
      ...plannerTargeting,
      ...plannerOutput,
      pageSize: z.number().int().min(1).max(10000).optional(),
      pageToken: z.string().optional(),
      biddingStrategy: z.enum(["manual_cpc", "maximize_clicks", "maximize_conversions"]).optional()
        .describe("forecast only. manual_cpc needs maxCpcBid; the maximize strategies need dailyBudget. Google returns only the metrics the chosen strategy affects."),
      maxCpcBid: z.number().positive().optional(),
      dailyBudget: z.number().positive().optional(),
      matchType: z.enum(["EXACT", "PHRASE", "BROAD"]).optional(),
      forecastStartDate: z.string().optional(),
      forecastEndDate: z.string().optional(),
      currencyCode: z.string().optional(),
      debug: debugInput
    },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      const target = await resolveTarget(auth, params);
      if (target.ambiguous) return result(target.ambiguous, true);
      const outcome = await runKeywordPlanner(
        { ...params, customerId: target.customerId },
        callContext(auth, target, params)
      );
      return result({ routing: routing(target), ...outcome }, outcome.ok === false);
    } catch (error) {
      return failed(error);
    }
  }));

  server.registerTool("google_ads_keyword_research_batch", {
    title: "Google Ads Keyword Research (Batch)",
    description:
      "Read-only. Runs several keyword seed groups and merges them into one deduped, clustered table. Groups run one " +
      "at a time because Google allows 1 Keyword Planner request per second per account, and the run stops early with " +
      "partial results and a note if Google reports a quota or rate limit.",
    inputSchema: {
      groups: z.array(z.object({
        label: z.string().optional(),
        keywords: z.array(z.string().min(1)).max(20).optional(),
        url: z.string().optional(),
        site: z.string().optional()
      })).min(1).max(10),
      customerId: customerIdInput,
      customerName: customerNameInput,
      loginCustomerId: loginCustomerIdInput,
      ...plannerTargeting,
      ...plannerOutput,
      maxGroups: z.number().int().min(1).max(10).optional(),
      debug: debugInput
    },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      const target = await resolveTarget(auth, params);
      if (target.ambiguous) return result(target.ambiguous, true);
      const outcome = await runKeywordBatch(
        { ...params, customerId: target.customerId },
        callContext(auth, target, params)
      );
      return result({ routing: routing(target), ...outcome }, outcome.ok === false);
    } catch (error) {
      return failed(error);
    }
  }));

  /* ---------------- reach planner ---------------- */

  server.registerTool("google_ads_reach_planner", {
    title: "Google Ads Reach Planner",
    description:
      "Read-only YouTube and video reach planning: list plannable locations, list the products available in a " +
      "location, or forecast reach, frequency and impressions for a budget split across products. Google has to " +
      "approve an account for Reach Planner before it returns data.",
    inputSchema: {
      action: z.enum(["locations", "products", "forecast"]),
      customerId: customerIdInput,
      customerName: customerNameInput,
      loginCustomerId: loginCustomerIdInput,
      plannableLocationId: z.string().optional(),
      plannableLocationIds: z.array(z.string()).max(10).optional()
        .describe("v25 moved the location into targeting as a list; several IDs must share one parent country."),
      currencyCode: z.string().optional(),
      durationInDays: z.number().int().min(1).max(90).optional(),
      products: z.array(z.object({ code: z.string().min(1), budget: z.number().positive() })).optional(),
      targeting: z.record(z.any()).optional(),
      cookieFrequencyCap: z.number().int().min(1).optional(),
      cookieFrequencyCapTimeUnit: z.enum(["DAY", "WEEK", "MONTH"]).optional(),
      minEffectiveFrequency: z.number().int().min(1).max(10).optional(),
      effectiveFrequencyLimit: z.number().int().min(1).max(10).optional(),
      refresh: refreshInput,
      debug: debugInput
    },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      // locations needs no account; forecast and products do.
      const target = await resolveTarget(auth, params, { required: params.action === "forecast" });
      if (target.ambiguous) return result(target.ambiguous, true);
      const outcome = await runReachPlanner(
        { ...params, customerId: target.customerId || params.customerId },
        callContext(auth, target, params)
      );
      return result({ ...(target.customerId ? { routing: routing(target) } : {}), ...outcome }, outcome.ok === false);
    } catch (error) {
      return failed(error);
    }
  }));

  /* ---------------- item 27: benchmarks ---------------- */

  server.registerTool("google_ads_benchmarks", {
    title: "Google Ads Benchmarks",
    description:
      "Read-only industry benchmarks (BenchmarksService, v25.2 percentile metrics): how this account's CTR, CPC and " +
      "conversion rate compare with other advertisers in a product and service category and location. Useful for " +
      "client reports. Pass a client account, not a manager: a manager has no ad spend of its own to compare.",
    inputSchema: {
      customerId: customerIdInput,
      customerName: customerNameInput,
      loginCustomerId: loginCustomerIdInput,
      countryCode: z.string().optional().describe("Two-letter country code, for example US."),
      geoTargetConstant: z.string().optional().describe("A geo target constant resource name, instead of countryCode."),
      categories: z.array(z.string()).max(10).optional()
        .describe('Product and service categories, for example "/Home & Garden". Required for the all-advertisers comparison.'),
      industryVerticalId: z.string().optional().describe("Compare against one industry vertical instead of all advertisers in a category."),
      products: z.array(z.string()).max(20).optional(),
      marketingObjectives: z.array(z.string()).max(20).optional(),
      breakdown: z.array(z.string()).max(5).optional(),
      includePercentiles: z.boolean().optional().describe("Default true: ask for percentile metrics as supplemental data."),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      currencyCode: z.string().optional(),
      refresh: refreshInput,
      debug: debugInput
    },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      const target = await resolveTarget(auth, params);
      if (target.ambiguous) return result(target.ambiguous, true);
      const outcome = await runBenchmarks({ ...params, customerId: target.customerId }, callContext(auth, target, params));
      return result({ routing: routing(target), ...outcome }, outcome.ok === false);
    } catch (error) {
      return failed(error);
    }
  }));

  /* ---------------- item 27: Local Services eligibility ---------------- */

  server.registerTool("google_ads_local_services_eligibility", {
    title: "Google Ads Local Services Eligibility",
    description:
      "Read-only Local Services eligibility check (LocalServicesEligibilityService, v26.1) for an account and a " +
      "Google Business Profile listing: whether it is eligible, which lead types and service categories it qualifies " +
      "for, and the reasons if not.",
    inputSchema: {
      customerId: customerIdInput,
      customerName: customerNameInput,
      loginCustomerId: loginCustomerIdInput,
      listingId: z.string().min(1).describe("The Google Business Profile listing ID to check."),
      refresh: refreshInput,
      debug: debugInput
    },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      const target = await resolveTarget(auth, params);
      if (target.ambiguous) return result(target.ambiguous, true);
      const outcome = await runLocalServicesEligibility({ ...params, customerId: target.customerId }, callContext(auth, target, params));
      return result({ routing: routing(target), ...outcome }, outcome.ok === false);
    } catch (error) {
      return failed(error);
    }
  }));

  /* ---------------- across every account under a manager ---------------- */

  server.registerTool("run_google_ads_across_accounts", {
    title: "Run Google Ads Query Across Accounts",
    description:
      "Read-only. Runs one GAQL SELECT query against every client account under a manager (MCC) and returns the rows " +
      "together, each tagged with its account, plus per-account totals. Each account costs one API request, so use " +
      "dryRun first to see the account list and request count, and keep maxAccounts small.",
    inputSchema: {
      managerCustomerId: z.string().min(1).optional()
        .describe("The manager whose clients to query. Omit it to use every manager in the account directory."),
      customerName: customerNameInput,
      loginCustomerId: loginCustomerIdInput,
      customerIds: z.array(z.string().min(1)).max(50).optional()
        .describe("Query these accounts instead of walking a manager's clients."),
      query: z.string().min(1).describe("A GAQL SELECT ... FROM ... read."),
      maxAccounts: z.number().int().min(1).max(50).optional(),
      dryRun: z.boolean().optional(),
      computedMetrics: z.array(z.object({ name: z.string().min(1), formula: z.string().min(1) })).optional(),
      having: z.array(z.object({ field: z.string().min(1), op: z.string().optional(), value: z.any().optional() })).optional(),
      sort: z.array(z.object({ field: z.string().min(1), direction: z.enum(["asc", "desc"]).optional() })).optional(),
      topN: z.number().int().min(1).max(10000).optional(),
      limit: z.number().int().min(1).max(10000).optional(),
      refresh: refreshInput,
      debug: debugInput
    },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      const query = withGaqlLimit(assertSelectQuery(params.query), params.limit);
      const directory = await directoryFor(auth, { refresh: params.refresh === true });

      // Which accounts to run against: an explicit list, a named manager's clients, or
      // every usable non-manager account in the directory.
      let selected;
      if (params.customerIds?.length) {
        selected = params.customerIds.map((id) => directoryEntry(directory, id) || { customerId: normalizeCustomerId(id), name: null });
      } else {
        const managerId = normalizeCustomerId(params.managerCustomerId);
        const candidates = Object.values(directory.byCustomerId || {}).filter((entry) => entry.usable && !entry.isManager);
        selected = managerId
          ? candidates.filter((entry) => entry.managerCustomerId === managerId || entry.loginCustomerId === managerId)
          : candidates;
        if (managerId && !selected.length) {
          return result({
            error: "no_client_accounts",
            message: `No usable client accounts are recorded under manager ${managerId}. Call list_google_ads_customer_clients to walk the tree, or pass customerIds.`,
            managerCustomerId: managerId
          }, true);
        }
      }

      const maxAccounts = params.maxAccounts || 10;
      const running = selected.slice(0, maxAccounts);
      const skipped = selected.length - running.length;

      if (params.dryRun) {
        return result({
          dryRun: true,
          gaql: query,
          accountsFound: selected.length,
          accountsThatWouldRun: running.map((entry) => ({ customerId: entry.customerId, name: entry.name ?? null })),
          accountsSkippedByMaxAccounts: skipped,
          requestsIfRun: running.length,
          note: "No API request was made. Each account costs one request when run for real."
        });
      }

      const outcomes = [];
      for (const entry of running) {
        const response = await adsRequest({
          path: `customers/${entry.customerId}/googleAds:search`,
          accessToken: auth.googleCredentials.accessToken,
          body: { query },
          customerId: entry.customerId,
          loginCustomerId: params.loginCustomerId,
          directoryEntry: entry,
          managerIds: managersFor(directory, entry.customerId),
          store,
          debug: params.debug === true
        });
        outcomes.push({
          customerId: entry.customerId,
          name: entry.name ?? null,
          ok: response.ok,
          rowCount: response.ok ? (response.body?.results || []).length : 0,
          rows: response.ok ? (response.body?.results || []) : [],
          attempts: response.attempts,
          ...(response.ok ? {} : { error: response.error })
        });
      }

      const allRows = outcomes.flatMap((outcome) =>
        outcome.rows.map((row) => ({ customerId: outcome.customerId, accountName: outcome.name, ...row }))
      );
      return result({
        gaql: query,
        accountsRun: outcomes.length,
        accountsSkippedByMaxAccounts: skipped,
        requestCount: outcomes.reduce((total, outcome) => total + (outcome.attempts?.length || 1), 0),
        accounts: outcomes.map(({ rows: _rows, ...rest }) => rest),
        rowCount: allRows.length,
        rows: allRows,
        quota: await countAdsRequest(store, 0)
      }, outcomes.length > 0 && outcomes.every((outcome) => !outcome.ok));
    } catch (error) {
      return failed(error);
    }
  }));

  /* ---------------- field metadata ---------------- */

  server.registerTool("get_google_ads_field", {
    title: "Get Google Ads Field",
    description:
      "Read-only metadata for a Google Ads field or resource, including whether it is selectable, filterable, " +
      "sortable and repeated. Use it to validate GAQL before running a query.",
    inputSchema: { name: z.string().min(1), debug: debugInput },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      const response = await adsRequest({
        path: `googleAdsFields/${encodeURIComponent(String(params.name).trim())}`,
        method: "GET",
        accessToken: auth.googleCredentials.accessToken,
        store,
        debug: params.debug === true
      });
      return result(response.ok ? { ok: true, field: response.body } : { ok: false, error: response.error }, !response.ok);
    } catch (error) {
      return failed(error);
    }
  }));

  server.registerTool("search_google_ads_fields", {
    title: "Search Google Ads Fields",
    description:
      "Read-only search over Google Ads field metadata, to discover valid attributes, segments, metrics and filters " +
      "before writing GAQL.",
    inputSchema: {
      query: z.string().min(1),
      pageSize: z.number().int().min(1).max(1000).optional(),
      pageToken: z.string().optional(),
      debug: debugInput
    },
    annotations: READ_ONLY
  }, async (params) => withVerifiedToolAuth(req, scopes, async (auth) => {
    try {
      // GoogleAdsFieldService.SearchGoogleAdsFields is a GET with query parameters, and it
      // does accept page_size; only GoogleAdsService.search rejects it.
      const search = new URLSearchParams({ query: params.query });
      if (params.pageSize) search.set("pageSize", String(params.pageSize));
      if (params.pageToken) search.set("pageToken", params.pageToken);
      const response = await adsRequest({
        path: `googleAdsFields:search?${search.toString()}`,
        method: "GET",
        accessToken: auth.googleCredentials.accessToken,
        store,
        debug: params.debug === true
      });
      return result(response.ok
        ? { ok: true, fieldCount: (response.body?.results || []).length, fields: response.body?.results || [], nextPageToken: response.body?.nextPageToken || null }
        : { ok: false, error: response.error }, !response.ok);
    } catch (error) {
      return failed(error);
    }
  }));

  return { readOnly: readOnlyNotice() };
}

function shapeClient(row) {
  const client = row.customerClient || row.customer_client || {};
  const value = (camel, snake) => client[camel] ?? client[snake];
  return {
    customerId: String(value("id", "id") ?? ""),
    resourceName: value("clientCustomer", "client_customer") ?? null,
    name: value("descriptiveName", "descriptive_name") ?? null,
    currency: value("currencyCode", "currency_code") ?? null,
    timeZone: value("timeZone", "time_zone") ?? null,
    level: Number(value("level", "level") ?? 0) || 0,
    isManager: value("manager", "manager") === true,
    isTestAccount: value("testAccount", "test_account") === true,
    status: value("status", "status") ?? null
  };
}
