import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADS_ALLOWED_RPCS, ADS_DENY_PATTERNS, ADS_READ_ONLY_ERROR,
  adsRequestKey, assertReadOnly, readOnlyFlagState
} from "./gate.js";

// Every write-shaped RPC Google exposes that we must never call. Paths are the real REST
// shapes for these services, so a regression that re-adds one is caught by name.
const WRITE_RPCS = [
  "customers/1234567890/googleAds:mutate",
  "customers/1234567890/campaigns:mutate",
  "customers/1234567890/adGroups:mutate",
  "customers/1234567890/adGroupAds:mutate",
  "customers/1234567890/adGroupCriteria:mutate",
  "customers/1234567890/campaignCriteria:mutate",
  "customers/1234567890/campaignBudgets:mutate",
  "customers/1234567890/biddingStrategies:mutate",
  "customers/1234567890/conversionActions:mutate",
  "customers/1234567890/customerClientLinks:mutate",
  "customers/1234567890/assets:mutate",
  "customers/1234567890/assetGroups:mutate",
  "customers/1234567890/experiments:mutate",
  "customers/1234567890/experiments:scheduleExperiment",
  "customers/1234567890/recommendations:apply",
  "customers/1234567890/recommendations:dismiss",
  "customers/1234567890:uploadClickConversions",
  "customers/1234567890:uploadConversionAdjustments",
  "customers/1234567890:uploadUserData",
  "customers/1234567890/offlineUserDataJobs:create",
  "customers/1234567890/offlineUserDataJobs/55:addOperations",
  "customers/1234567890/offlineUserDataJobs/55:run",
  "customers/1234567890/batchJobs:mutate",
  "customers/1234567890/batchJobs/55:run",
  "customers/1234567890:generatePMaxDraftCampaign",
  "customers/1234567890/customers:createCustomerClient",
  "customers/1234567890/userLists:mutate",
  "customers/1234567890/customerUserAccesses:mutate",
  "customers/1234567890/keywordPlans:mutate",
  "customers/1234567890/keywordPlans/7:generateForecastCurve",
  "customers/1234567890/productLinkInvitations:create",
  "customers/1234567890/multiPartyAuthReviews:resolve"
];

test("read-only gate blocks every write RPC without contacting Google", () => {
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalls += 1; throw new Error("the gate let a request through"); };
  try {
    for (const path of WRITE_RPCS) {
      assert.throws(
        () => assertReadOnly({ path, method: "POST", body: {} }),
        (error) => {
          assert.equal(error.message, ADS_READ_ONLY_ERROR, `wrong message for ${path}`);
          assert.equal(error.code, "ADS_READ_ONLY");
          assert.equal(error.contactedGoogle, false);
          return true;
        },
        `${path} was not blocked`
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  // The HTTP mock must never have been called: a blocked call opens no socket.
  assert.equal(fetchCalls, 0, "a blocked request reached the network");
});

test("gate blocks a validate_only write dry-run, even on an allowed path", () => {
  assert.throws(
    () => assertReadOnly({ path: "customers/123/googleAds:search", body: { query: "SELECT x", validateOnly: true } }),
    /ADS_READ_ONLY/
  );
  assert.throws(
    () => assertReadOnly({ path: "customers/123/googleAds:search", body: { query: "SELECT x", validate_only: true } }),
    /ADS_READ_ONLY/
  );
});

test("gate allows exactly the confirmed read RPCs", () => {
  const allowed = [
    { path: "customers/1234567890/googleAds:search", method: "POST" },
    { path: "customers/1234567890/googleAds:searchStream", method: "POST" },
    { path: "customers:listAccessibleCustomers", method: "GET" },
    { path: "customers/1234567890:generateKeywordIdeas", method: "POST" },
    { path: "customers/1234567890:generateKeywordHistoricalMetrics", method: "POST" },
    { path: "customers/1234567890:generateKeywordForecastMetrics", method: "POST" },
    { path: "https://googleads.googleapis.com/v26:listPlannableLocations", method: "POST" },
    { path: "https://googleads.googleapis.com/v26:listPlannableProducts", method: "POST" },
    { path: "customers/1234567890:generateReachForecast", method: "POST" },
    { path: "customers/1234567890:generateBenchmarksMetrics", method: "POST" },
    { path: "geoTargetConstants:suggest", method: "POST" },
    { path: "customers/1234567890:checkLocalServicesEligibility", method: "POST" },
    { path: "googleAdsFields:search", method: "GET" },
    { path: "googleAdsFields/metrics.clicks", method: "GET" }
  ];
  for (const request of allowed) {
    const entry = assertReadOnly({ ...request, body: {} });
    assert.ok(entry.service, `${request.path} returned no allowlist entry`);
  }
  // The allowlist covers these 14 and nothing else.
  assert.equal(Object.keys(ADS_ALLOWED_RPCS).length, allowed.length);
});

test("gate refuses an allowed RPC on the wrong HTTP method", () => {
  // search is POST-only; a GET would be a different (unvetted) surface.
  assert.throws(() => assertReadOnly({ path: "customers/123/googleAds:search", method: "GET" }), /ADS_READ_ONLY/);
  assert.throws(() => assertReadOnly({ path: "customers:listAccessibleCustomers", method: "POST" }), /ADS_READ_ONLY/);
});

test("no allowlist entry collides with a deny pattern", () => {
  // Guards the two checks against each other: if a deny pattern ever started matching an
  // allowed read, that read would break at runtime instead of being caught here.
  for (const key of Object.keys(ADS_ALLOWED_RPCS)) {
    for (const pattern of ADS_DENY_PATTERNS) {
      assert.ok(!pattern.re.test(key), `allowlist entry ${key} matches deny pattern ${pattern.name}`);
    }
  }
});

test("unknown and malformed paths are denied by default", () => {
  for (const path of ["", "   ", "customers/123:somethingNew", "customers/123/campaigns", "../../v26/customers/1:mutate"]) {
    assert.throws(() => assertReadOnly({ path }), /ADS_READ_ONLY/, `${JSON.stringify(path)} was not denied`);
  }
});

test("read-only enforcement cannot be switched off by env", () => {
  const previous = process.env.GOOGLE_ADS_READ_ONLY;
  try {
    for (const value of ["false", "0", "no", ""]) {
      process.env.GOOGLE_ADS_READ_ONLY = value;
      assert.equal(readOnlyFlagState().enforced, true);
      assert.equal(readOnlyFlagState().ignoredOverride, true);
      // Enforcement is unchanged regardless of the flag.
      assert.throws(() => assertReadOnly({ path: "customers/1/googleAds:mutate" }), /ADS_READ_ONLY/);
    }
    delete process.env.GOOGLE_ADS_READ_ONLY;
    assert.deepEqual(readOnlyFlagState(), { enforced: true, requested: "true", ignoredOverride: false });
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_ADS_READ_ONLY;
    else process.env.GOOGLE_ADS_READ_ONLY = previous;
  }
});

test("request keys collapse account ids so the allowlist cannot be bypassed by id", () => {
  assert.equal(adsRequestKey("customers/999/googleAds:search"), "customers/*/googleAds:search");
  assert.equal(adsRequestKey("/v26/customers/999/googleAds:search"), "customers/*/googleAds:search");
  assert.equal(adsRequestKey("https://googleads.googleapis.com/v26/customers/9/googleAds:search"), "customers/*/googleAds:search");
});
