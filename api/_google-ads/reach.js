// Reach Planner (ReachPlanService) read/plan methods.
//
// v25 removed Targeting.plannable_location_id and
// GenerateReachForecastRequest.cookie_frequency_cap. The location now goes in
// Targeting.plannable_location_ids[] and the frequency cap in cookie_frequency_cap_setting.
// v26 GenerateReachForecastRequest has no top-level plannable_location_id at all, so the
// previous request shape silently targeted nothing.

import { adsRequest, normalizeCustomerId } from "./client.js";
import { GOOGLE_ADS_API_BASE, googleAdsApiVersion } from "./version.js";

function toMicros(amount) {
  const numeric = Number(amount);
  return Number.isFinite(numeric) ? String(Math.round(numeric * 1_000_000)) : undefined;
}

// ReachPlanService list methods hang off the version root, not a customer.
function versionRootPath(method) {
  return `${GOOGLE_ADS_API_BASE}/${googleAdsApiVersion()}:${method}`;
}

export function reachError(message) {
  const error = new Error(message);
  error.code = "INVALID_REACH_PLANNER_REQUEST";
  return error;
}

/**
 * Builds the v26 GenerateReachForecastRequest body.
 * `plannableLocationId` is still accepted from callers for compatibility, but it is placed
 * where v26 expects it: targeting.plannableLocationIds.
 */
export function buildReachForecastBody(params) {
  const locationIds = [
    ...(params.plannableLocationIds || []),
    ...(params.plannableLocationId ? [params.plannableLocationId] : [])
  ].map((id) => String(id).trim()).filter(Boolean);

  if (!locationIds.length) {
    throw reachError("forecast needs plannableLocationId or plannableLocationIds (get them from action \"locations\").");
  }
  if (!params.products?.length) {
    throw reachError("forecast needs products, each with a code and a budget.");
  }

  const { plannableLocationId: _legacy, plannableLocationIds: _legacyList, ...callerTargeting } = params.targeting || {};

  return {
    ...(params.currencyCode ? { currencyCode: params.currencyCode } : {}),
    customerId: normalizeCustomerId(params.customerId),
    campaignDuration: { durationInDays: params.durationInDays || 28 },
    targeting: {
      ...callerTargeting,
      // v25+: the location lives here, as a list.
      plannableLocationIds: locationIds
    },
    plannedProducts: params.products.map((product) => ({
      plannableProductCode: product.code,
      budgetMicros: toMicros(product.budget)
    })),
    ...(params.cookieFrequencyCap !== undefined
      // v25 renamed cookie_frequency_cap -> cookie_frequency_cap_setting (a FrequencyCap).
      ? { cookieFrequencyCapSetting: { impressions: params.cookieFrequencyCap, timeUnit: params.cookieFrequencyCapTimeUnit || "WEEK" } }
      : {}),
    ...(params.minEffectiveFrequency !== undefined ? { minEffectiveFrequency: params.minEffectiveFrequency } : {}),
    ...(params.effectiveFrequencyLimit !== undefined
      ? { effectiveFrequencyLimit: { maxEffectiveFrequency: params.effectiveFrequencyLimit } }
      : {}),
    ...(params.customerReachGroup ? { customerReachGroup: params.customerReachGroup } : {})
  };
}

export async function runReachPlanner(params, context) {
  const shared = {
    accessToken: context.accessToken,
    loginCustomerId: params.loginCustomerId,
    directoryEntry: context.directoryEntry,
    managerIds: context.managerIds || [],
    fetchImpl: context.fetchImpl,
    store: context.store,
    debug: params.debug
  };

  if (params.action === "locations") {
    const response = await adsRequest({ path: versionRootPath("listPlannableLocations"), body: {}, ...shared });
    return shapeReach(response, {
      action: "locations",
      rows: response.body?.plannableLocations || [],
      emptyMessage: "Google returned no plannable locations."
    });
  }

  if (params.action === "products") {
    if (!params.plannableLocationId) {
      throw reachError("products needs plannableLocationId (get one from action \"locations\").");
    }
    const response = await adsRequest({
      path: versionRootPath("listPlannableProducts"),
      body: { plannableLocationId: String(params.plannableLocationId) },
      ...shared
    });
    return shapeReach(response, {
      action: "products",
      rows: response.body?.productMetadata || [],
      emptyMessage: "Google returned no plannable products for this location."
    });
  }

  if (params.action === "forecast") {
    if (!params.customerId) throw reachError("forecast needs customerId.");
    const body = buildReachForecastBody(params);
    const response = await adsRequest({
      path: `customers/${normalizeCustomerId(params.customerId)}:generateReachForecast`,
      body,
      customerId: params.customerId,
      ...shared
    });
    return shapeReach(response, {
      action: "forecast",
      request: body,
      rows: response.body?.reachCurve?.reachForecasts || [],
      forecast: response.body ?? null,
      emptyMessage: "Reach Planner returned no forecast. Google has to approve an account for Reach Planner before it answers, and the chosen products must be available in the chosen location."
    });
  }

  throw reachError(`Unsupported reach planner action: ${params.action}`);
}

function shapeReach(response, { action, rows, forecast, request, emptyMessage }) {
  const base = {
    action,
    googleAds: "read-only",
    quota: response.quota,
    attempts: response.attempts,
    ...(request ? { request } : {})
  };
  if (!response.ok) return { ...base, ok: false, available: false, error: response.error };
  // An empty object is "Google answered but had nothing", which is still not available.
  const hasForecast = forecast !== null && forecast !== undefined && Object.keys(forecast).length > 0;
  if (!rows.length && !hasForecast) return { ...base, ok: true, available: false, rowCount: 0, rows: [], message: emptyMessage };
  return {
    ...base, ok: true, available: true,
    rowCount: rows.length,
    ...(forecast ? { forecast } : { rows })
  };
}
