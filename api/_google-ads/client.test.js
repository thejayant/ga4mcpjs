import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adsRequest, buildAdsHeaders, countAdsRequest, normalizeCustomerId,
  resolveLoginCustomerId, stripSearchPageSize
} from "./client.js";
import { memoryStore } from "../connections/store.js";

// A fetch stub that records every request and replays scripted responses.
function stubFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
      loginCustomerId: init.headers["login-customer-id"] ?? null
    });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body ?? {})
    };
  };
  return { impl, calls };
}

const denied = { status: 403, body: { error: { message: "no", details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }] } } };
const notEnabled = { status: 403, body: { error: { message: "off", details: [{ errors: [{ errorCode: { requestError: "CUSTOMER_NOT_ENABLED" } }] }] } } };
const ok = { status: 200, body: { results: [{ customer: { id: "9529469947" } }] } };
const search = (overrides = {}) => ({
  path: "customers/9529469947/googleAds:search",
  accessToken: "test-token",
  customerId: "9529469947",
  body: { query: "SELECT customer.id FROM customer" },
  ...overrides
});

/* ---------------- item 1: the header rule ---------------- */

test("header rule: explicit loginCustomerId wins", () => {
  assert.deepEqual(resolveLoginCustomerId({ customerId: "111", loginCustomerId: "222" }), { loginCustomerId: "222", source: "explicit" });
});

test("header rule: directory manager is used when no explicit id", () => {
  assert.deepEqual(
    resolveLoginCustomerId({ customerId: "111", directoryEntry: { loginCustomerId: "333" } }),
    { loginCustomerId: "333", source: "directory" }
  );
});

test("header rule: falls back to the customerId itself, never a global manager", () => {
  const previous = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "7777777777";
  try {
    // The old bug: this env var was sent as login-customer-id for every account.
    const resolved = resolveLoginCustomerId({ customerId: "952-946-9947" });
    assert.deepEqual(resolved, { loginCustomerId: "9529469947", source: "self" });
    assert.notEqual(resolved.loginCustomerId, "7777777777");
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    else process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = previous;
  }
});

test("header rule: ids are normalized and dashes dropped", () => {
  assert.equal(normalizeCustomerId("952-946-9947"), "9529469947");
  assert.equal(normalizeCustomerId(null), "");
});

test("the live request sends the resolved header, not an env manager", async () => {
  const previous = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "7777777777";
  const { impl, calls } = stubFetch([ok]);
  try {
    await adsRequest(search({ fetchImpl: impl }));
    assert.equal(calls[0].loginCustomerId, "9529469947");
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    else process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = previous;
  }
});

/* ---------------- item 2: no pageSize on search ---------------- */

test("no Ads search request body contains pageSize", async () => {
  const { impl, calls } = stubFetch([ok]);
  await adsRequest(search({
    fetchImpl: impl,
    body: { query: "SELECT customer.id FROM customer", pageSize: 500, page_size: 500, pageToken: "tok" }
  }));
  for (const call of calls) {
    assert.ok(!("pageSize" in call.body), "pageSize reached a search request");
    assert.ok(!("page_size" in call.body), "page_size reached a search request");
    assert.equal(call.body.pageToken, "tok", "pageToken must survive");
    assert.ok(!/page_?size/i.test(init(call)), "pageSize appeared anywhere in the serialized body");
  }
  function init(call) { return JSON.stringify(call.body); }
});

test("searchStream also drops pageSize, keyword planner keeps page_size", () => {
  assert.deepEqual(stripSearchPageSize("customers/1/googleAds:searchStream", { query: "q", pageSize: 10 }), { query: "q" });
  // generateKeywordIdeas legitimately accepts page_size (max 10,000).
  assert.deepEqual(stripSearchPageSize("customers/1:generateKeywordIdeas", { pageSize: 10 }), { pageSize: 10 });
});

/* ---------------- item 3: the retry ladder ---------------- */

test("retry ladder: explicit id that works makes exactly one request", async () => {
  const { impl, calls } = stubFetch([ok]);
  const result = await adsRequest(search({ fetchImpl: impl, loginCustomerId: "9529469947" }));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.attempts.map((a) => a.source), ["explicit"]);
});

test("retry ladder: directory hit is used first and not retried on success", async () => {
  const { impl, calls } = stubFetch([ok]);
  const result = await adsRequest(search({ fetchImpl: impl, customerId: "1641460349", directoryEntry: { loginCustomerId: "9529469947" } }));
  assert.equal(calls[0].loginCustomerId, "9529469947");
  assert.equal(calls.length, 1);
  assert.equal(result.attempts[0].source, "directory");
});

test("retry ladder: permission denied retries with the customer id itself", async () => {
  // First attempt uses a (wrong) manager, second falls back to the account itself.
  const { impl, calls } = stubFetch([denied, ok]);
  const result = await adsRequest(search({
    fetchImpl: impl, customerId: "9529469947", directoryEntry: { loginCustomerId: "1173506745" }
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((c) => c.loginCustomerId), ["1173506745", "9529469947"]);
  assert.deepEqual(result.attempts.map((a) => a.source), ["directory", "self"]);
});

test("retry ladder: walks each manager when the account itself is still denied", async () => {
  const { impl, calls } = stubFetch([denied, denied, denied, ok]);
  const result = await adsRequest(search({
    fetchImpl: impl,
    customerId: "4650900876",
    directoryEntry: { loginCustomerId: "1111111111" },
    managerIds: ["2222222222", "9529469947"]
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((c) => c.loginCustomerId), ["1111111111", "4650900876", "2222222222", "9529469947"]);
  assert.deepEqual(result.attempts.map((a) => a.source), ["directory", "self", "manager-walk", "manager-walk"]);
});

test("retry ladder: a deactivated account is never retried", async () => {
  const { impl, calls } = stubFetch([notEnabled]);
  const result = await adsRequest(search({
    fetchImpl: impl, customerId: "1173506745", managerIds: ["9529469947", "2222222222"]
  }));
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1, "a deactivated account must not burn quota on retries");
  assert.equal(result.error.code, "ACCOUNT_DEACTIVATED");
  assert.match(result.error.fix, /Nothing to retry/);
});

test("retry ladder: a non-permission error is not retried either", async () => {
  const { impl, calls } = stubFetch([{ status: 400, body: { error: { message: "bad field", details: [{ errors: [{ errorCode: { queryError: "BAD_FIELD_NAME" } }] }] } } }]);
  const result = await adsRequest(search({ fetchImpl: impl, managerIds: ["9529469947"] }));
  assert.equal(calls.length, 1);
  assert.equal(result.error.code, "INVALID_QUERY");
});

test("retry ladder: duplicate header candidates are not retried twice", async () => {
  const { impl, calls } = stubFetch([denied, denied]);
  // directory manager == the customer itself, so the ladder has one distinct value.
  await adsRequest(search({ fetchImpl: impl, customerId: "9529469947", directoryEntry: { loginCustomerId: "9529469947" } }));
  assert.equal(calls.length, 1);
});

test("exhausted ladder reports every attempt", async () => {
  const { impl } = stubFetch([denied]);
  const result = await adsRequest(search({ fetchImpl: impl, customerId: "4650900876", managerIds: ["9529469947"] }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PERMISSION_DENIED");
  assert.equal(result.error.attempts.length, 2);
  assert.ok(result.error.attempts.every((attempt) => attempt.ok === false));
});

/* ---------------- the gate still applies on this path ---------------- */

test("adsRequest refuses a write path without calling fetch", async () => {
  let called = 0;
  await assert.rejects(
    () => adsRequest({ path: "customers/1/campaigns:mutate", accessToken: "t", body: {}, fetchImpl: async () => { called += 1; } }),
    /ADS_READ_ONLY/
  );
  assert.equal(called, 0);
});

/* ---------------- items 20 / 23 / 25 ---------------- */

test("developer token is optional and omitted when unset", () => {
  const previous = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  try {
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const headers = buildAdsHeaders({ accessToken: "t", loginCustomerId: "1" });
    assert.ok(!("developer-token" in headers), "a token header was sent with no token configured");
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev-tok";
    assert.equal(buildAdsHeaders({ accessToken: "t" })["developer-token"], "dev-tok");
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = previous;
  }
});

test("quota counts per Cloud project and warns at 80%", async () => {
  const store = memoryStore();
  const wrapped = { incrementCounter: (key, by, ttl) => store.increment(key, by, ttl) };
  const previousLevel = process.env.GOOGLE_ADS_ACCESS_LEVEL;
  const previousClient = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_ADS_ACCESS_LEVEL = "explorer";
  process.env.GOOGLE_CLIENT_ID = "123456789012-abc.apps.googleusercontent.com";
  try {
    const first = await countAdsRequest(wrapped, 1);
    assert.equal(first.usedToday, 1);
    assert.equal(first.limit, 2880);
    assert.equal(first.project, "123456789012");
    assert.ok(!first.warning);
    const loud = await countAdsRequest(wrapped, 2303);
    assert.match(loud.warning, /80%/);
  } finally {
    if (previousLevel === undefined) delete process.env.GOOGLE_ADS_ACCESS_LEVEL; else process.env.GOOGLE_ADS_ACCESS_LEVEL = previousLevel;
    if (previousClient === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = previousClient;
  }
});

test("quota tracking never fails a request when the store cannot count", async () => {
  const quota = await countAdsRequest(null, 1);
  assert.equal(quota.usedToday, null);
  assert.ok(quota.limit);
});
