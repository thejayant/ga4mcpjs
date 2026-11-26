import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountRouter, MAIN } from "../connections/routing.js";

const MAIN_EMAIL = "jayant.solanki@cibirix.com";

// A store holding one extra Google account plus the main sign-in's recorded email.
function fakeStore() {
  const records = {
    "google_account:abc123": { label: "jayant.cibirix@gmail.com", summary: "Analytics, Search Console, Ads, Merchant Center" }
  };
  return {
    list: async () => Object.keys(records),
    get: async (_userId, id) => records[id] || null,
    getAccountInfo: async () => ({ googleEmail: MAIN_EMAIL }),
    cached: async (_key, _ttl, load) => load()
  };
}

function router() {
  return createAccountRouter({
    store: fakeStore(),
    labels: { main: () => "Main Google sign-in" },
    listers: { google: async () => [] },
    credentialsFor: async (_family, record, id) => ({ accessToken: `token-for-${id}`, label: record.label }),
    mainAliases: async (userId, family) => (family === "google" ? [MAIN_EMAIL] : [])
  });
}

const choose = (account) => router().choose({ userId: "u1", family: "google", args: {}, account, primary: { accessToken: "main-token" } });

test("account accepts the main sign-in email address", async () => {
  // Previously only "main" worked, even though manage_connections shows this email.
  assert.equal(await choose(MAIN_EMAIL), null, "the main sign-in resolves to null (its own handling)");
});

test("account accepts the main sign-in email case-insensitively and with whitespace", async () => {
  for (const spelling of ["JAYANT.SOLANKI@CIBIRIX.COM", "  Jayant.Solanki@Cibirix.com  "]) {
    assert.equal(await choose(spelling), null, `${spelling} was rejected`);
  }
});

test('account still accepts "main" and the main label', async () => {
  assert.equal(await choose("main"), null);
  assert.equal(await choose("MAIN"), null);
  assert.equal(await choose("Main Google sign-in"), null);
});

test("account accepts an extra account by email label, id and case", async () => {
  for (const spelling of ["jayant.cibirix@gmail.com", "JAYANT.CIBIRIX@GMAIL.COM", "google_account:abc123"]) {
    const chosen = await choose(spelling);
    assert.ok(chosen, `${spelling} was rejected`);
    assert.equal(chosen.key, "google_account:abc123");
  }
});

test("an unknown account name fails with a message that lists what is connected", async () => {
  await assert.rejects(() => choose("nobody@example.com"), (error) => {
    assert.match(error.message, /No connected google account called "nobody@example.com"/);
    assert.match(error.message, /Main Google sign-in/);
    assert.match(error.message, /email address/);
    return true;
  });
});

test("MAIN is still the key for the main sign-in", () => {
  assert.equal(MAIN, "main");
});
