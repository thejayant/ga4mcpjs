import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRANDED_DATA_START, FILTER_LIST_DEVICES, SEARCH_DIMENSIONS, SEARCH_TYPES,
  assertSearchConsoleRequest, explainEmptySearchConsoleResult, searchConsoleFreshness
} from "./capabilities.js";

const group = (filters = [], filterLists = []) => [{ groupType: "and", filters, filterLists }];

/* ---------------- the capabilities added 2026-11-16 ---------------- */

test("webMultimodal is an accepted search type", () => {
  assert.ok(SEARCH_TYPES.includes("webMultimodal"));
  // Everything Google documents, nothing invented.
  assert.deepEqual(SEARCH_TYPES, ["web", "image", "video", "news", "discover", "googleNews", "webMultimodal"]);
  assert.doesNotThrow(() => assertSearchConsoleRequest({ type: "webMultimodal" }));
});

test("an unknown type or dimension is rejected locally", () => {
  assert.throws(() => assertSearchConsoleRequest({ type: "aiMode" }), /Unknown type "aiMode"/);
  assert.throws(() => assertSearchConsoleRequest({ dimensions: ["browser"] }), /Unknown dimension "browser"/);
});

test("hour and brandedClassification are groupable dimensions", () => {
  for (const dimension of ["hour", "brandedClassification"]) {
    assert.ok(SEARCH_DIMENSIONS.includes(dimension), `${dimension} missing`);
  }
});

/* ---------------- brandedClassification constraints ---------------- */

test("brandedClassification cannot be combined with a query filter", () => {
  assert.throws(
    () => assertSearchConsoleRequest({
      dimensions: ["brandedClassification"],
      dimensionFilterGroups: group([{ dimension: "query", operator: "contains", expression: "shoes" }])
    }),
    /cannot be combined with a query filter/
  );
  // Also when branded is used as a filter rather than a grouping.
  assert.throws(
    () => assertSearchConsoleRequest({
      dimensionFilterGroups: group([
        { dimension: "brandedClassification", operator: "equals", expression: "BRANDED" },
        { dimension: "query", operator: "contains", expression: "shoes" }
      ])
    }),
    /cannot be combined with a query filter/
  );
});

test("brandedClassification only supports equals, and only its two values", () => {
  assert.throws(
    () => assertSearchConsoleRequest({ dimensionFilterGroups: group([{ dimension: "brandedClassification", operator: "contains", expression: "BRANDED" }]) }),
    /only supports the "equals" operator/
  );
  assert.throws(
    () => assertSearchConsoleRequest({ dimensionFilterGroups: group([{ dimension: "brandedClassification", operator: "equals", expression: "MAYBE" }]) }),
    /accepts BRANDED or NON_BRANDED/
  );
  assert.doesNotThrow(
    () => assertSearchConsoleRequest({ dimensionFilterGroups: group([{ dimension: "brandedClassification", operator: "equals", expression: "NON_BRANDED" }]) })
  );
});

test("a branded request warns about its availability limits", () => {
  const notes = assertSearchConsoleRequest({ dimensions: ["brandedClassification"] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(BRANDED_DATA_START));
  assert.match(notes[0], /top-level properties/);
});

/* ---------------- filterLists ---------------- */

test("filterLists accepts several countries or devices in one request", () => {
  assert.doesNotThrow(() => assertSearchConsoleRequest({
    dimensionFilterGroups: group([], [{ dimension: "country", expressions: ["USA", "GBR", "DEU"] }])
  }));
  assert.doesNotThrow(() => assertSearchConsoleRequest({
    dimensionFilterGroups: group([], [{ dimension: "device", expressions: ["DESKTOP", "MOBILE"] }])
  }));
});

test("filterLists rejects what Google does not support", () => {
  assert.throws(
    () => assertSearchConsoleRequest({ dimensionFilterGroups: group([], [{ dimension: "query", expressions: ["a"] }]) }),
    /filterLists only supports country and device/
  );
  // Two-letter codes are the common mistake: Google wants alpha-3 here.
  assert.throws(
    () => assertSearchConsoleRequest({ dimensionFilterGroups: group([], [{ dimension: "country", expressions: ["US"] }]) }),
    /ISO 3166-1 alpha-3/
  );
  assert.throws(
    () => assertSearchConsoleRequest({ dimensionFilterGroups: group([], [{ dimension: "device", expressions: ["PHONE"] }]) }),
    new RegExp(FILTER_LIST_DEVICES.join(", "))
  );
  assert.throws(
    () => assertSearchConsoleRequest({ dimensionFilterGroups: group([], [{ dimension: "country", expressions: [] }]) }),
    /non-empty expressions array/
  );
});

test("a dimension cannot appear in both filters and filterLists", () => {
  assert.throws(
    () => assertSearchConsoleRequest({
      dimensionFilterGroups: group(
        [{ dimension: "country", operator: "equals", expression: "USA" }],
        [{ dimension: "country", expressions: ["GBR", "DEU"] }]
      )
    }),
    /appears in both filters and filterLists/
  );
});

/* ---------------- hour / dataState pairing ---------------- */

test("grouping by hour without hourly_all is flagged, and vice versa", () => {
  assert.match(assertSearchConsoleRequest({ dimensions: ["hour"] })[0], /dataState "hourly_all"/);
  assert.match(assertSearchConsoleRequest({ dimensions: ["date"], dataState: "hourly_all" })[0], /not broken out by hour/);
  // The correct pairing produces no advisory.
  assert.deepEqual(assertSearchConsoleRequest({ dimensions: ["hour"], dataState: "hourly_all" }), []);
});

test("byProperty aggregation is rejected for Discover and Google News", () => {
  for (const type of ["discover", "googleNews"]) {
    assert.throws(() => assertSearchConsoleRequest({ type, aggregationType: "byProperty" }), /not supported for type/);
  }
  assert.doesNotThrow(() => assertSearchConsoleRequest({ type: "web", aggregationType: "byProperty" }));
});

/* ---------------- freshness metadata ---------------- */

test("freshness metadata is read in either spelling", () => {
  const byDate = searchConsoleFreshness({ metadata: { first_incomplete_date: "2026-11-24" } });
  assert.equal(byDate.firstIncompleteDate, "2026-11-24");
  assert.equal(byDate.timeZone, "America/Los_Angeles");
  assert.match(byDate.note, /still being collected/);

  const byHour = searchConsoleFreshness({ metadata: { firstIncompleteHour: "2026-11-25T14:00:00-08:00" } });
  assert.equal(byHour.firstIncompleteHour, "2026-11-25T14:00:00-08:00");
  assert.match(byHour.note, /provisional/);
});

test("a complete response reports no freshness caveat", () => {
  assert.equal(searchConsoleFreshness({ rows: [] }), null);
  assert.equal(searchConsoleFreshness({ metadata: {} }), null);
  assert.equal(searchConsoleFreshness(undefined), null);
});

/* ---------------- empty results that are not "no traffic" ---------------- */

test("an empty branded result explains the qualifying-property limit", () => {
  const why = explainEmptySearchConsoleResult({ dimensions: ["brandedClassification"] });
  assert.match(why, /top-level properties/);
  assert.match(why, /may not mean there was no traffic/);
});

test("an empty multimodal or Discover result is explained too", () => {
  assert.match(explainEmptySearchConsoleResult({ type: "webMultimodal" }), /Google Lens/);
  assert.match(explainEmptySearchConsoleResult({ type: "discover" }), /discover data appears only/);
  // An ordinary web query genuinely meaning "no rows" gets no excuse made for it.
  assert.equal(explainEmptySearchConsoleResult({ type: "web", dimensions: ["query"] }), null);
});
