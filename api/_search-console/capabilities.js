// Search Analytics API capabilities, including the three added on 2026-11-16
// (brandedClassification, type webMultimodal, and filterLists).
//
// Everything here was checked against Google's Search Analytics: query reference.
// Constraints Google documents are enforced locally, so an invalid combination fails with
// a clear message instead of coming back as a confusing empty result set.

/** Every `type` the Search Analytics API accepts. webMultimodal was added 2026-11-16. */
export const SEARCH_TYPES = Object.freeze([
  "web",             // default: the combined "All" tab, excluding Discover and Google News
  "image",
  "video",
  "news",            // the "News" tab in Google Search
  "discover",
  "googleNews",      // news.google.com and the Google News apps
  "webMultimodal"    // Google Lens, Circle to Search on Android, image uploads
]);

/** Dimensions that can be grouped by. `hour` pairs with dataState "hourly_all". */
export const SEARCH_DIMENSIONS = Object.freeze([
  "date", "hour", "query", "page", "country", "device", "searchAppearance", "brandedClassification"
]);

export const BRANDED_VALUES = Object.freeze(["BRANDED", "NON_BRANDED"]);

/** filterLists matches several exact values for one dimension in a single request. */
export const FILTER_LIST_DIMENSIONS = Object.freeze(["country", "device"]);
export const FILTER_LIST_DEVICES = Object.freeze(["DESKTOP", "MOBILE", "TABLET"]);

// Branded data only exists from this date, per Google's branded queries announcement.
export const BRANDED_DATA_START = "2026-02-21";

export function searchConsoleError(message, code = "INVALID_SEARCH_CONSOLE_REQUEST") {
  const error = new Error(message);
  error.code = code;
  return error;
}

const filterDimension = (filter) => String(filter?.dimension || "").trim();

function allFilters(groups) {
  return (groups || []).flatMap((group) => group?.filters || []);
}

function allFilterLists(groups) {
  return (groups || []).flatMap((group) => group?.filterLists || []);
}

/**
 * Enforces the combinations Google documents as unsupported. Each of these otherwise
 * returns either an opaque API error or, worse, an empty result that reads as "no data".
 *
 * @param {{dimensions?:string[], type?:string, dimensionFilterGroups?:object[]}} request
 * @returns {string[]} advisory notes (constraints that are legal but worth knowing)
 */
export function assertSearchConsoleRequest(request = {}) {
  const dimensions = request.dimensions || [];
  const groups = request.dimensionFilterGroups || [];
  const filters = allFilters(groups);
  const lists = allFilterLists(groups);
  const notes = [];

  if (request.type && !SEARCH_TYPES.includes(request.type)) {
    throw searchConsoleError(`Unknown type "${request.type}". Valid types: ${SEARCH_TYPES.join(", ")}.`);
  }
  for (const dimension of dimensions) {
    if (!SEARCH_DIMENSIONS.includes(dimension)) {
      throw searchConsoleError(`Unknown dimension "${dimension}". Valid dimensions: ${SEARCH_DIMENSIONS.join(", ")}.`);
    }
  }

  const groupsBranded = dimensions.includes("brandedClassification");
  const filtersBranded = filters.some((filter) => filterDimension(filter) === "brandedClassification");

  if (groupsBranded || filtersBranded) {
    // Google: "Filtering or grouping by brandedClassification can't be combined with a
    // query filter in the same request."
    if (filters.some((filter) => filterDimension(filter) === "query")) {
      throw searchConsoleError(
        "brandedClassification cannot be combined with a query filter in the same request. Drop the query filter, or group by query instead of filtering on it."
      );
    }
    // Only the equals operator is supported.
    const badOperator = filters.find(
      (filter) => filterDimension(filter) === "brandedClassification" &&
        filter.operator && String(filter.operator).toLowerCase() !== "equals"
    );
    if (badOperator) {
      throw searchConsoleError(
        `brandedClassification only supports the "equals" operator, not "${badOperator.operator}".`
      );
    }
    const badValue = filters.find(
      (filter) => filterDimension(filter) === "brandedClassification" &&
        filter.expression && !BRANDED_VALUES.includes(String(filter.expression).toUpperCase())
    );
    if (badValue) {
      throw searchConsoleError(
        `brandedClassification accepts ${BRANDED_VALUES.join(" or ")}, not "${badValue.expression}".`
      );
    }
    notes.push(
      `Branded query data starts ${BRANDED_DATA_START} and is only available for top-level properties with enough query and impression volume. ` +
      "A property that does not qualify returns no rows rather than an error."
    );
  }

  for (const list of lists) {
    const dimension = filterDimension(list);
    if (!FILTER_LIST_DIMENSIONS.includes(dimension)) {
      throw searchConsoleError(
        `filterLists only supports ${FILTER_LIST_DIMENSIONS.join(" and ")}, not "${dimension || "(missing dimension)"}".`
      );
    }
    if (!Array.isArray(list.expressions) || !list.expressions.length) {
      throw searchConsoleError(`A filterLists entry for "${dimension}" needs a non-empty expressions array.`);
    }
    // Google: a single request cannot filter on the same dimension in both filters and filterLists.
    if (filters.some((filter) => filterDimension(filter) === dimension)) {
      throw searchConsoleError(
        `"${dimension}" appears in both filters and filterLists. Google allows only one of the two per dimension in a request; use filterLists for several values.`
      );
    }
    if (dimension === "device") {
      const bad = list.expressions.find((value) => !FILTER_LIST_DEVICES.includes(String(value).toUpperCase()));
      if (bad) throw searchConsoleError(`device filterLists accepts ${FILTER_LIST_DEVICES.join(", ")}, not "${bad}".`);
    }
    if (dimension === "country") {
      const bad = list.expressions.find((value) => !/^[A-Za-z]{3}$/.test(String(value)));
      if (bad) {
        throw searchConsoleError(`country filterLists uses 3-letter ISO 3166-1 alpha-3 codes (for example USA, GBR), not "${bad}".`);
      }
    }
  }

  // hour grouping needs the hourly dataState to be meaningful.
  if (dimensions.includes("hour") && String(request.dataState || "").toLowerCase() !== "hourly_all") {
    notes.push('Grouping by "hour" returns hourly rows only with dataState "hourly_all"; without it Google falls back to daily data.');
  }
  if (String(request.dataState || "").toLowerCase() === "hourly_all" && !dimensions.includes("hour")) {
    notes.push('dataState "hourly_all" was requested without grouping by "hour", so the rows are not broken out by hour.');
  }
  if (request.type === "webMultimodal") {
    notes.push("webMultimodal covers Google Lens, Circle to Search on Android, and image uploads in Google Search. A property with no such traffic returns no rows.");
  }
  if (request.aggregationType === "byProperty" && ["discover", "googleNews"].includes(request.type)) {
    throw searchConsoleError(`aggregationType "byProperty" is not supported for type "${request.type}".`);
  }

  return notes;
}

/**
 * Google's freshness metadata, which says where data is still being collected (item: the
 * server used to drop this, so recent partial rows looked final).
 *
 * @param {object} body the Search Analytics response
 */
export function searchConsoleFreshness(body) {
  const metadata = body?.metadata;
  if (!metadata) return null;
  const firstIncompleteDate = metadata.first_incomplete_date || metadata.firstIncompleteDate || null;
  const firstIncompleteHour = metadata.first_incomplete_hour || metadata.firstIncompleteHour || null;
  if (!firstIncompleteDate && !firstIncompleteHour) return null;
  return {
    ...(firstIncompleteDate ? { firstIncompleteDate } : {}),
    ...(firstIncompleteHour ? { firstIncompleteHour } : {}),
    timeZone: "America/Los_Angeles",
    note: firstIncompleteHour
      ? `Data from ${firstIncompleteHour} onwards is still being collected and may change noticeably. Treat those hours as provisional.`
      : `Data from ${firstIncompleteDate} onwards is still being collected and may change noticeably. Treat those days as provisional.`
  };
}

/**
 * Whether an empty result is explained by a known availability limit rather than genuinely
 * meaning "no traffic". Keeps a qualifying-property issue from reading as a performance drop.
 */
export function explainEmptySearchConsoleResult(request = {}) {
  const dimensions = request.dimensions || [];
  const filters = allFilters(request.dimensionFilterGroups);
  const branded = dimensions.includes("brandedClassification") ||
    filters.some((filter) => filterDimension(filter) === "brandedClassification");

  if (branded) {
    return "No rows. Branded query data is only available for top-level properties with enough query and impression volume, and only from " +
      `${BRANDED_DATA_START}. If this property does not qualify, Google returns no rows rather than an error, so this may not mean there was no traffic.`;
  }
  if (request.type === "webMultimodal") {
    return "No rows. webMultimodal covers Google Lens, Circle to Search and image uploads; a property with no multimodal traffic in the period returns nothing.";
  }
  if (["discover", "googleNews"].includes(request.type)) {
    return `No rows. ${request.type} data appears only for properties that have traffic from that surface.`;
  }
  return null;
}
