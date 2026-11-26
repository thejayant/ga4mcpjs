// Item 9: a profile's googleAdsCustomerId default must make customerId optional on the Ads
// tools and be filled in automatically. The storage side already existed; this pins the
// chain through to the Ads tool shapes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { PROFILE_DEFAULTS, buildProfile, profileShape } from "../connections/profiles.js";

const options = {
  accountOptions: { google: ["main", "google_account:x"], meta: ["main"], callrail: ["main"] },
  platformOptions: ["clarity"],
  labels: { google: { "google_account:x": "client@example.com" } }
};

test("the profile default fields cover the Ads customer, GA4 property, GSC site and Merchant ID", () => {
  assert.deepEqual(Object.keys(PROFILE_DEFAULTS.google).sort(), ["customerId", "merchantAccountId", "propertyId", "siteUrl"]);
});

test("a Google Ads customer default is stored normalized", () => {
  const { profile } = buildProfile({
    name: "DMS",
    accounts: { google: "google_account:x" },
    defaults: { google: { customerId: "952-946-9947", propertyId: "properties/123", siteUrl: "sc-domain:example.com", merchantAccountId: "accounts/555" } }
  }, options);
  assert.equal(profile.defaults.google.customerId, "9529469947", "dashes should be stripped");
  assert.equal(profile.defaults.google.propertyId, "properties/123");
  assert.equal(profile.defaults.google.siteUrl, "sc-domain:example.com");
  assert.equal(profile.defaults.google.merchantAccountId, "accounts/555");
});

test("an Ads tool shape with an optional customerId accepts the profile default", () => {
  // This is the shape the Ads tools use: optional, so no existing caller breaks.
  const shape = {
    customerId: z.string().min(1).optional().describe("The Google Ads customer ID."),
    query: z.string().min(1)
  };
  const { shape: profiled, defaults } = profileShape(shape, { customerId: "9529469947" }, "DMS");
  assert.equal(defaults.customerId, "9529469947", "the default was not applied to the Ads tool");
  assert.match(profiled.customerId.description, /Defaults to 9529469947 \(profile "DMS"\)/);
  // The tool still works when the caller passes its own value.
  assert.equal(profiled.customerId.safeParse("1234567890").success, true);
});

test("a malformed Ads customer default is rejected at save time, not at call time", () => {
  const bad = buildProfile({
    name: "Bad", accounts: { google: "google_account:x" }, defaults: { google: { customerId: "not-an-id" } }
  }, options);
  assert.match(bad.error, /Google Ads customer ID/);
});

test("a default needs its platform account on the profile", () => {
  const orphan = buildProfile({
    name: "Orphan", accounts: { meta: "main" }, defaults: { google: { customerId: "9529469947" } }
  }, options);
  assert.match(orphan.error, /needs a Google account/);
});
