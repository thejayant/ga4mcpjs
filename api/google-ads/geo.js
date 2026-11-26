// Geo and language targeting by name (item 13).
//
// Callers can pass "California", "Sacramento, CA", "United States" or "English" instead of
// Google's numeric constant IDs. Place names resolve through
// GeoTargetConstantService.SuggestGeoTargetConstants (a read-only lookup) and are cached;
// languages resolve from Google's published criterion codes, which need no API call.

import { adsRequest } from "./client.js";

export const GEO_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

// Google's language criterion codes (developers.google.com/google-ads/api/data/codes-formats).
export const LANGUAGE_CODES = Object.freeze({
  arabic: 1019, bengali: 1056, bulgarian: 1020, catalan: 1038, croatian: 1039, czech: 1021,
  danish: 1009, dutch: 1010, english: 1000, estonian: 1043, filipino: 1042, finnish: 1011,
  french: 1002, german: 1001, greek: 1022, gujarati: 1072, hebrew: 1027, hindi: 1023,
  hungarian: 1024, icelandic: 1026, indonesian: 1025, italian: 1004, japanese: 1005,
  kannada: 1086, korean: 1012, latvian: 1028, lithuanian: 1029, malay: 1102, malayalam: 1098,
  marathi: 1101, norwegian: 1013, polish: 1030, portuguese: 1014, punjabi: 1110,
  romanian: 1032, russian: 1031, serbian: 1035, slovak: 1033, slovenian: 1034, spanish: 1003,
  swedish: 1015, tamil: 1130, telugu: 1131, thai: 1044, turkish: 1037, ukrainian: 1036,
  urdu: 1041, vietnamese: 1040
});

// ISO 639-1 shorthands, so "en" and "es" work too.
const LANGUAGE_BY_ISO = Object.freeze({
  ar: 1019, bn: 1056, bg: 1020, ca: 1038, hr: 1039, cs: 1021, da: 1009, nl: 1010, en: 1000,
  et: 1043, tl: 1042, fi: 1011, fr: 1002, de: 1001, el: 1022, gu: 1072, iw: 1027, he: 1027,
  hi: 1023, hu: 1024, is: 1026, id: 1025, it: 1004, ja: 1005, kn: 1086, ko: 1012, lv: 1028,
  lt: 1029, ms: 1102, ml: 1098, mr: 1101, no: 1013, pl: 1030, pt: 1014, pa: 1110, ro: 1032,
  ru: 1031, sr: 1035, sk: 1033, sl: 1034, es: 1003, sv: 1015, ta: 1130, te: 1131, th: 1044,
  tr: 1037, uk: 1036, ur: 1041, vi: 1040
});

/**
 * "English" | "en" | "1000" | "languageConstants/1000" -> "languageConstants/1000".
 * Returns null when the name is not recognised, so the caller can report it.
 */
export function resolveLanguage(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^languageConstants\/\d+$/.test(raw)) return { resourceName: raw, id: raw.split("/")[1], matchedOn: "resourceName" };
  if (/^\d+$/.test(raw)) return { resourceName: `languageConstants/${raw}`, id: raw, matchedOn: "id" };

  const key = raw.toLowerCase();
  const id = LANGUAGE_CODES[key] ?? LANGUAGE_BY_ISO[key]
    // "English (US)" / "Spanish - Latin America" -> the base language.
    ?? LANGUAGE_CODES[key.split(/[(\-,]/)[0].trim()];
  return id ? { resourceName: `languageConstants/${id}`, id: String(id), name: raw, matchedOn: "name" } : null;
}

const ALREADY_A_GEO_ID = /^(geoTargetConstants\/)?\d+$/;

export function asGeoResourceName(value) {
  const raw = String(value ?? "").trim();
  if (!ALREADY_A_GEO_ID.test(raw)) return null;
  const id = raw.replace(/\D/g, "");
  return id ? `geoTargetConstants/${id}` : null;
}

/**
 * Resolves place names to geo target constants, one API request for all of them.
 *
 * Numeric IDs pass straight through without an API call. Names go to
 * SuggestGeoTargetConstants; the best match per name is returned, and every resolution is
 * echoed back so the caller can show what the names became (item 13).
 *
 * @returns {Promise<{geoTargetConstants:string[], resolved:object[], unresolved:string[], requestCount:number, error?:object}>}
 */
export async function resolveGeoTargets({ names, accessToken, locale = "en", countryCode, store, fetchImpl, debug }) {
  const wanted = (Array.isArray(names) ? names : [names]).map((name) => String(name ?? "").trim()).filter(Boolean);
  const out = { geoTargetConstants: [], resolved: [], unresolved: [], requestCount: 0 };
  if (!wanted.length) return out;

  const needLookup = [];
  for (const name of wanted) {
    const direct = asGeoResourceName(name);
    if (direct) {
      out.geoTargetConstants.push(direct);
      out.resolved.push({ input: name, resourceName: direct, matchedOn: "id" });
    } else {
      needLookup.push(name);
    }
  }
  if (!needLookup.length) return out;

  // Cache on the exact name set, so repeat research costs nothing.
  const cacheKey = `adsgeo:${locale}:${countryCode || "any"}:${needLookup.map((n) => n.toLowerCase()).sort().join("|")}`;
  const load = async () => {
    const response = await adsRequest({
      path: "geoTargetConstants:suggest",
      accessToken,
      body: {
        locale,
        ...(countryCode ? { countryCode } : {}),
        locationNames: { names: needLookup }
      },
      fetchImpl, store, debug
    });
    return response.ok
      ? { ok: true, suggestions: response.body?.geoTargetConstantSuggestions || [], requestCount: response.attempts?.length || 1 }
      : { ok: false, error: response.error, requestCount: response.attempts?.length || 1 };
  };

  const result = store?.cached ? await store.cached(cacheKey, GEO_CACHE_TTL_SECONDS, load) : await load();
  out.requestCount += result.cached ? 0 : result.requestCount || 1;
  if (!result.ok) {
    out.error = result.error;
    out.unresolved.push(...needLookup);
    return out;
  }

  for (const name of needLookup) {
    const best = bestSuggestion(result.suggestions, name);
    if (!best) {
      out.unresolved.push(name);
      continue;
    }
    out.geoTargetConstants.push(best.geoTargetConstant.resourceName);
    out.resolved.push({
      input: name,
      resourceName: best.geoTargetConstant.resourceName,
      id: String(best.geoTargetConstant.resourceName).split("/").pop(),
      name: best.geoTargetConstant.name || null,
      canonicalName: best.geoTargetConstant.canonicalName || null,
      targetType: best.geoTargetConstant.targetType || null,
      countryCode: best.geoTargetConstant.countryCode || null,
      reach: best.reach ?? null,
      matchedOn: "name"
    });
  }
  // De-duplicate: two names can resolve to the same constant.
  out.geoTargetConstants = [...new Set(out.geoTargetConstants)];
  return out;
}

// Google returns suggestions for every requested name together, so pick the row that
// actually corresponds to this name: exact name/canonical match first, then largest reach.
function bestSuggestion(suggestions, name) {
  const wanted = name.toLowerCase();
  const usable = (suggestions || []).filter((entry) => entry?.geoTargetConstant?.resourceName);
  const scored = usable.map((entry) => {
    const constant = entry.geoTargetConstant;
    const plain = String(constant.name || "").toLowerCase();
    const canonical = String(constant.canonicalName || "").toLowerCase();
    let score = 0;
    if (plain === wanted || canonical === wanted) score = 4;
    else if (canonical.startsWith(`${wanted},`) || plain.startsWith(wanted)) score = 3;
    else if (canonical.includes(wanted) || plain.includes(wanted)) score = 2;
    // "Sacramento, CA" -> match each comma-separated part.
    else if (wanted.split(/\s*,\s*/).every((part) => canonical.includes(part))) score = 2;
    return { entry, score, reach: Number(entry.reach ?? 0) };
  }).filter((candidate) => candidate.score > 0);

  scored.sort((a, b) => b.score - a.score || b.reach - a.reach);
  return scored[0]?.entry || null;
}
