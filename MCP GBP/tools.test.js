import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { GBP_SCOPE } from "./client.js";
import { GBP_TOOL_NAMES, registerGbpTools } from "./tools.js";

let originalFetch;
let calls;
let tools;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  tools = new Map();
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(JSON.stringify({ name: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  registerGbpTools({ registerTool(name, config, handler) { tools.set(name, { config, handler }); } }, {
    req: {},
    withVerifiedToolAuth: async (_req, scopes, callback) => {
      assert.deepEqual(scopes, [GBP_SCOPE]);
      return callback({ googleCredentials: { accessToken: "test-token" } });
    },
    buildToolResult: (body, error) => ({ body, error: Boolean(error) })
  });
});

afterEach(() => { globalThis.fetch = originalFetch; });

test("registers the declared catalog without excluded access or verification writes", () => {
  assert.deepEqual([...tools.keys()], GBP_TOOL_NAMES);
  assert.equal(GBP_TOOL_NAMES.some((name) => /verif|notification|invitation_(accept|decline)|transfer/.test(name)), false);
});

test("category and attribute discovery use required query formats", async () => {
  await tools.get("gbp_list_categories").handler({ regionCode: "US", languageCode: "en" });
  assert.equal(calls[0].url.searchParams.get("view"), "FULL");
  await tools.get("gbp_list_available_attributes").handler({ categoryName: "gcid:restaurant", regionCode: "US", languageCode: "en" });
  assert.equal(calls[1].url.searchParams.get("categoryName"), "categories/gcid:restaurant");
});

test("write tools cannot make requests without explicit confirmation", async () => {
  const result = await tools.get("gbp_delete_location").handler({ locationId: "123" });
  assert.equal(result.error, true);
  assert.equal(calls.length, 0);
  await tools.get("gbp_delete_location").handler({ locationId: "123", confirmed: true });
  assert.equal(calls[0].options.method, "DELETE");
});

test("review reply rejects an existing owner reply", async () => {
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(JSON.stringify({ reviewReply: { comment: "Already replied" } }), { status: 200 });
  };
  const result = await tools.get("gbp_publish_review_reply").handler({ accountId: "1", locationId: "2", reviewId: "3", comment: "Thanks", confirmed: true });
  assert.equal(result.error, true);
  assert.equal(result.body.error.error, "existing_reply");
  assert.equal(calls.length, 1);
});

test("location updates require a supported mask and explicit confirmation", async () => {
  const blocked = await tools.get("gbp_update_location").handler({ locationId: "123", location: { languageCode: "fr" }, updateMask: "languageCode", confirmed: true });
  assert.equal(blocked.error, true);
  assert.equal(calls.length, 0);
  const result = await tools.get("gbp_update_location").handler({ locationId: "123", location: { title: "New title" }, updateMask: "title", confirmed: true });
  assert.equal(result.error, false);
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(calls[0].url.searchParams.get("updateMask"), "title");
});

test("action metadata uses the API filter rather than ad hoc parameters", async () => {
  await tools.get("gbp_list_action_types").handler({ locationId: "123", languageCode: "en" });
  assert.equal(calls[0].url.searchParams.get("filter"), "location=locations/123");
  assert.equal(calls[0].url.searchParams.has("locationId"), false);
});
