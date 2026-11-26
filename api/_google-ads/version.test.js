import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GOOGLE_ADS_API_RELEASE, GOOGLE_ADS_API_SUNSETS, GOOGLE_ADS_API_VERSION,
  googleAdsApiUrl, googleAdsApiVersion, googleAdsVersionInfo
} from "./version.js";

function withVersionEnv(value, run) {
  const previous = process.env.GOOGLE_ADS_API_VERSION;
  if (value === undefined) delete process.env.GOOGLE_ADS_API_VERSION;
  else process.env.GOOGLE_ADS_API_VERSION = value;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.GOOGLE_ADS_API_VERSION;
    else process.env.GOOGLE_ADS_API_VERSION = previous;
  }
}

test("sunset dates match Google's published timetable", () => {
  assert.deepEqual(GOOGLE_ADS_API_SUNSETS, { v23: "2027-02", v24: "2027-05", v25: "2027-08", v26: "2027-11" });
});

test("the reported sunset tracks the version actually in use, not the pinned one", () => {
  // The bug this pins: with the env override forcing v24, the code reported v26's
  // sunset (2027-11). v24 really sunsets 2027-05.
  withVersionEnv("v24", () => {
    const info = googleAdsVersionInfo();
    assert.equal(info.apiVersion, "v24");
    assert.equal(info.sunsets, "2027-05", "an overridden version must report its own sunset");
  });
  withVersionEnv("v25", () => assert.equal(googleAdsVersionInfo().sunsets, "2027-08"));
});

test("an override is surfaced with a warning rather than passing silently", () => {
  withVersionEnv("v24", () => {
    const info = googleAdsVersionInfo();
    assert.equal(info.pinnedVersion, GOOGLE_ADS_API_VERSION);
    assert.match(info.versionWarning, /GOOGLE_ADS_API_VERSION/);
    assert.match(info.versionWarning, /sunsets 2027-05/);
    assert.match(info.versionWarning, /Remove that variable/);
  });
});

test("with no override there is no warning and the pin is used", () => {
  withVersionEnv(undefined, () => {
    const info = googleAdsVersionInfo();
    assert.equal(info.apiVersion, GOOGLE_ADS_API_VERSION);
    assert.equal(info.sunsets, GOOGLE_ADS_API_SUNSETS[GOOGLE_ADS_API_VERSION]);
    assert.ok(!("versionWarning" in info), "no warning when the pinned version is in use");
    assert.ok(!("pinnedVersion" in info));
  });
});

test("setting the override to the pinned version is not reported as an override", () => {
  withVersionEnv(GOOGLE_ADS_API_VERSION, () => {
    assert.ok(!("versionWarning" in googleAdsVersionInfo()));
  });
});

test("a malformed override is ignored and the pin stands", () => {
  for (const bad of ["v", "26", "latest", "v26.2", ""]) {
    withVersionEnv(bad, () => assert.equal(googleAdsApiVersion(), GOOGLE_ADS_API_VERSION, `"${bad}" should be ignored`));
  }
});

test("every pinned and overridable version has a known sunset", () => {
  assert.ok(GOOGLE_ADS_API_SUNSETS[GOOGLE_ADS_API_VERSION], "the pinned version has no sunset recorded");
  // An unrecognised version must not silently inherit another version's date.
  withVersionEnv("v99", () => assert.equal(googleAdsVersionInfo().sunsets, "unknown"));
});

test("the release the code targets is a minor of the pinned major", () => {
  assert.ok(GOOGLE_ADS_API_RELEASE.startsWith(GOOGLE_ADS_API_VERSION), `${GOOGLE_ADS_API_RELEASE} is not a ${GOOGLE_ADS_API_VERSION} release`);
});

test("request URLs use the version actually in use", () => {
  withVersionEnv("v24", () => assert.match(googleAdsApiUrl("customers:listAccessibleCustomers"), /\/v24\//));
  withVersionEnv(undefined, () => assert.match(googleAdsApiUrl("customers:listAccessibleCustomers"), new RegExp(`/${GOOGLE_ADS_API_VERSION}/`)));
});
