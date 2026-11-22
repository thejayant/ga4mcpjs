import test from "node:test";
import assert from "node:assert/strict";
import { freshAccessToken } from "./connections/oauth.js";

const provider = { name: "YouTube", oauth: { tokenUrl: "https://oauth2.googleapis.com/token", clientId: () => "id", clientSecret: () => "secret" } };
const record = { oauth: { accessToken: "old", refreshToken: "r", expiresAt: 0 } };

function fakeStore() {
  const removed = [];
  return { removed, save: async () => {}, remove: async (userId, providerId) => { removed.push([userId, providerId]); } };
}

test("a revoked Google grant deletes the stored sign-in", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }));
  const store = fakeStore();
  await assert.rejects(freshAccessToken({ store, userId: "u1", providerId: "youtube", provider, record }), /expired or was removed/);
  assert.deepEqual(store.removed, [["u1", "youtube"]]);
});

test("a temporary token error keeps the stored sign-in", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "server_error" }), { status: 503 }));
  const store = fakeStore();
  await assert.rejects(freshAccessToken({ store, userId: "u1", providerId: "youtube", provider, record }));
  assert.deepEqual(store.removed, []);
});
