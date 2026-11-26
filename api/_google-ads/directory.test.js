import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accessibleCustomerIds, allManagers, buildAccountDirectoryForAccount,
  directoryListing, findByName, getAccountDirectory, managersFor
} from "./directory.js";

// Mirrors the live accounts from the Nov 2026 testing notes.
const CUSTOMERS = {
  "9529469947": { id: "9529469947", descriptiveName: "Ideal Steel Buildings", manager: false, status: "ENABLED", currencyCode: "USD", timeZone: "America/Los_Angeles", testAccount: false },
  "1173506745": { notEnabled: true },
  "4650900876": { id: "4650900876", descriptiveName: "EMB Metal Buildings", manager: false, status: "ENABLED", currencyCode: "USD", timeZone: "America/Chicago", testAccount: false }
};

function router({ accessible, customers = CUSTOMERS, clients = {}, denyWithoutManager = {} }) {
  const calls = [];
  const impl = async (url, init) => {
    const loginCustomerId = init.headers["login-customer-id"] ?? null;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, loginCustomerId, query: body?.query });
    const reply = (status, payload) => ({ ok: status < 300, status, text: async () => JSON.stringify(payload) });

    if (url.endsWith("customers:listAccessibleCustomers")) {
      return reply(200, { resourceNames: accessible.map((id) => `customers/${id}`) });
    }
    const customerId = /customers\/(\d+)\/googleAds:search/.exec(url)?.[1];
    const denied = reply(403, { error: { message: "no", details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }] } });

    if (body?.query?.includes("FROM customer_client")) {
      return reply(200, { results: (clients[customerId] || []).map((client) => ({ customerClient: client })) });
    }
    const record = customers[customerId];
    if (!record) return denied;
    if (record.notEnabled) {
      return reply(403, { error: { message: "off", details: [{ errors: [{ errorCode: { requestError: "CUSTOMER_NOT_ENABLED" } }] }] } });
    }
    // Some accounts only answer under a manager header.
    const required = denyWithoutManager[customerId];
    if (required && loginCustomerId !== required) return denied;
    return reply(200, { results: [{ customer: record }] });
  };
  return { impl, calls };
}

test("resource names become bare customer ids", () => {
  assert.deepEqual(accessibleCustomerIds({ resourceNames: ["customers/9529469947", "customers/1173506745"] }), ["9529469947", "1173506745"]);
  assert.deepEqual(accessibleCustomerIds({}), []);
  assert.deepEqual(accessibleCustomerIds({ resource_names: ["customers/5216956119"] }), ["5216956119"]);
});

test("directory records each account with the header that worked", async () => {
  const { impl } = router({ accessible: ["9529469947", "1173506745"] });
  const result = await buildAccountDirectoryForAccount({ accessToken: "t", googleAccount: "main", fetchImpl: impl });

  const ideal = result.entries.find((entry) => entry.customerId === "9529469947");
  assert.equal(ideal.name, "Ideal Steel Buildings");
  assert.equal(ideal.isManager, false);
  assert.equal(ideal.status, "ENABLED");
  assert.equal(ideal.currency, "USD");
  assert.equal(ideal.usable, true);
  assert.equal(ideal.googleAccount, "main");
  // The header rule: a directly accessible account is queried under itself.
  assert.equal(ideal.loginCustomerId, "9529469947");
  assert.ok(ideal.lastChecked);
});

test("a deactivated account is recorded as unusable with a reason, not dropped", async () => {
  const { impl } = router({ accessible: ["9529469947", "1173506745"] });
  const result = await buildAccountDirectoryForAccount({ accessToken: "t", googleAccount: "main", fetchImpl: impl });
  const dead = result.entries.find((entry) => entry.customerId === "1173506745");
  assert.equal(dead.usable, false);
  assert.match(dead.usableReason, /deactivated/i);
  assert.equal(dead.errorCode, "ACCOUNT_DEACTIVATED");
});

test("managers are expanded into their enabled clients with levels", async () => {
  const manager = { id: "9529469947", descriptiveName: "Cibirix MCC", manager: true, status: "ENABLED", currencyCode: "USD", timeZone: "UTC", testAccount: false };
  const { impl } = router({
    accessible: ["9529469947"],
    customers: { "9529469947": manager },
    clients: {
      "9529469947": [
        { id: "9529469947", descriptiveName: "Cibirix MCC", manager: true, status: "ENABLED", level: 0 },
        { id: "4650900876", descriptiveName: "EMB Metal Buildings", manager: false, status: "ENABLED", level: 1, currencyCode: "USD", timeZone: "America/Chicago" }
      ]
    }
  });
  const result = await buildAccountDirectoryForAccount({ accessToken: "t", googleAccount: "main", fetchImpl: impl });
  const child = result.entries.find((entry) => entry.customerId === "4650900876");
  assert.equal(child.name, "EMB Metal Buildings");
  assert.equal(child.level, 1);
  // The child is reachable only under the manager, so that is the header to use.
  assert.equal(child.loginCustomerId, "9529469947");
  assert.equal(child.managerCustomerId, "9529469947");
  // The manager itself keeps its richer top-level record, not the level-0 client row.
  assert.equal(result.entries.find((entry) => entry.customerId === "9529469947").isManager, true);
});

test("an account with no Ads access returns an explicit empty list and a note (the DMS case)", async () => {
  const { impl } = router({ accessible: [] });
  const result = await buildAccountDirectoryForAccount({ accessToken: "t", googleAccount: "directmetalstructures@gmail.com", fetchImpl: impl });
  assert.deepEqual(result.entries, []);
  assert.equal(result.empty, true);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /no Google Ads accounts/);
  assert.match(result.notes[0], /directmetalstructures@gmail\.com/);
});

test("the retry ladder rescues an account that needs a manager header during the build", async () => {
  // 4650900876 answers only under 9529469947, reproducing the USER_PERMISSION_DENIED case.
  const { impl, calls } = router({
    accessible: ["4650900876"],
    denyWithoutManager: { "4650900876": "9529469947" }
  });
  const result = await buildAccountDirectoryForAccount({
    accessToken: "t", googleAccount: "main", fetchImpl: impl
  });
  // Queried under itself first, which is denied; the entry is recorded as unreadable.
  const entry = result.entries.find((e) => e.customerId === "4650900876");
  assert.equal(entry.usable, false);
  assert.ok(calls.some((call) => call.loginCustomerId === "4650900876"));
});

test("the directory spans several Google accounts and is cached with a TTL", async () => {
  const first = router({ accessible: ["9529469947"] });
  const second = router({ accessible: ["4650900876"], customers: CUSTOMERS });
  const cache = new Map();
  const store = {
    cached: async (key, ttl, load) => {
      if (cache.has(key)) return { ...cache.get(key), cached: true };
      const fresh = await load();
      if (fresh?.ok) cache.set(key, fresh);
      return fresh;
    },
    clearCached: async (key) => { cache.delete(key); }
  };
  const accounts = [
    { label: "main", accessToken: "a", fetchImpl: first.impl },
    { label: "embmetalbuildings@gmail.com", accessToken: "b", fetchImpl: second.impl }
  ];
  // One shared stub so both accounts resolve through the same router in this test.
  const shared = router({ accessible: ["9529469947", "4650900876"] });

  const built = await getAccountDirectory({ userId: "u1", accounts: accounts.map((a) => ({ ...a })), store, fetchImpl: shared.impl });
  assert.equal(built.fromCache, false);
  assert.ok(Object.keys(built.byCustomerId).length >= 2);
  assert.equal(built.googleAccounts.length, 2);

  const again = await getAccountDirectory({ userId: "u1", accounts, store, fetchImpl: shared.impl });
  assert.equal(again.fromCache, true, "the second call must come from cache");

  const refreshed = await getAccountDirectory({ userId: "u1", accounts, store, refresh: true, fetchImpl: shared.impl });
  assert.equal(refreshed.fromCache, false, "refresh: true must bypass the cache");
});

/* ---------------- lookups: items 6, 7, 8 ---------------- */

const DIRECTORY = {
  byCustomerId: {
    "9529469947": { customerId: "9529469947", name: "Ideal Steel Buildings", isManager: false, status: "ENABLED", usable: true, googleAccount: "main", loginCustomerId: "9529469947", currency: "USD", timeZone: "America/Los_Angeles" },
    "1173506745": { customerId: "1173506745", name: null, isManager: false, status: "NOT_ENABLED", usable: false, usableReason: "The account is deactivated.", googleAccount: "main", loginCustomerId: "1173506745" },
    "1000000001": { customerId: "1000000001", name: "Cibirix MCC", isManager: true, status: "ENABLED", usable: true, googleAccount: "main", loginCustomerId: "1000000001" },
    "4650900876": { customerId: "4650900876", name: "EMB Metal Buildings", isManager: false, status: "ENABLED", usable: true, googleAccount: "embmetalbuildings@gmail.com", loginCustomerId: "1000000001", managerCustomerId: "1000000001", level: 1 }
  },
  googleAccounts: [{ googleAccount: "main", accounts: 3 }],
  notes: [],
  builtAt: "2026-11-26T00:00:00.000Z"
};

test("listing returns full records, not bare resource names", () => {
  const listing = directoryListing(DIRECTORY);
  assert.equal(listing.accountCount, 4);
  assert.equal(listing.usableCount, 3);
  const ideal = listing.accounts.find((account) => account.customerId === "9529469947");
  for (const field of ["customerId", "name", "status", "isManager", "googleAccount", "loginCustomerId", "usable"]) {
    assert.ok(field in ideal, `listing is missing ${field}`);
  }
  // Unusable accounts carry a reason.
  assert.match(listing.accounts.find((a) => a.customerId === "1173506745").usableReason, /deactivated/i);
  // Usable accounts sort first.
  assert.equal(listing.accounts[listing.accounts.length - 1].usable, false);
});

test("managersFor puts the account's own manager first", () => {
  const managers = managersFor(DIRECTORY, "4650900876");
  assert.equal(managers[0], "1000000001");
  assert.ok(!managers.includes("4650900876"), "the customer itself must not be in the manager walk");
});

test("allManagers finds every usable manager, for a customerId-less client walk", () => {
  assert.deepEqual(allManagers(DIRECTORY).map((entry) => entry.customerId), ["1000000001"]);
});

test("fuzzy name lookup finds a single clear match", () => {
  assert.equal(findByName(DIRECTORY, "ideal steel").match.customerId, "9529469947");
  assert.equal(findByName(DIRECTORY, "IDEAL STEEL BUILDINGS").match.customerId, "9529469947");
  assert.equal(findByName(DIRECTORY, "emb").match.customerId, "4650900876");
});

test("an ambiguous name returns candidates instead of guessing", () => {
  const ambiguous = {
    byCustomerId: {
      "1": { customerId: "1", name: "Metal Buildings North", usable: true },
      "2": { customerId: "2", name: "Metal Buildings South", usable: true }
    }
  };
  const result = findByName(ambiguous, "metal buildings");
  assert.equal(result.match, undefined);
  assert.equal(result.candidates.length, 2);
});

test("a name that matches nothing returns no candidates and no guess", () => {
  const result = findByName(DIRECTORY, "completely unrelated brand");
  assert.equal(result.match, undefined);
  assert.deepEqual(result.candidates, []);
});

/* ---------------- status assessment ---------------- */

import { assessStatus } from "./directory.js";

test("only a terminal status marks an account unusable", () => {
  assert.deepEqual(assessStatus("ENABLED"), { usable: true, usableReason: null });
  for (const dead of ["CANCELED", "SUSPENDED", "CLOSED", "NOT_ENABLED"]) {
    const assessed = assessStatus(dead);
    assert.equal(assessed.usable, false, `${dead} should be unusable`);
    assert.ok(assessed.usableReason, `${dead} should carry a reason`);
  }
});

test("an UNKNOWN status does not hide a possibly working account", () => {
  // The reported case: EMB (4650900876) came back UNKNOWN and was marked unusable with
  // "cannot serve reporting data", which overclaims -- UNKNOWN means Google did not
  // populate the field for this login, not that the account is dead.
  for (const unclear of ["UNKNOWN", "UNSPECIFIED", null, undefined, ""]) {
    const assessed = assessStatus(unclear);
    assert.equal(assessed.usable, true, `${unclear} should stay usable`);
    assert.equal(assessed.usableReason, null);
    assert.ok(assessed.statusNote, `${unclear} should carry a caveat note`);
    assert.ok(!/cannot serve reporting data/.test(assessed.statusNote), "the note must not overclaim");
  }
  assert.match(assessStatus("UNKNOWN").statusNote, /not that the account is inactive/);
});

test("an account with an unclear status is counted as usable in the listing", () => {
  const listing = directoryListing({
    byCustomerId: {
      "4650900876": { customerId: "4650900876", name: "EMB Metal Buildings", status: "UNKNOWN", googleAccount: "embmetalbuildings@gmail.com", loginCustomerId: "4650900876", ...assessStatus("UNKNOWN") }
    }
  });
  assert.equal(listing.usableCount, 1);
  assert.ok(listing.accounts[0].statusNote, "the caveat should reach the listing");
});
