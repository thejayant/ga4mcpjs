import assert from "node:assert/strict";
import { test } from "node:test";
import {
  META_DEFAULT_VERSION, META_SUPPORT_YEARS, META_VERSION_RELEASES,
  metaGraphBaseUrl, metaGraphVersion, metaVersionInfo
} from "./version.js";

function withVersion(value, run) {
  const previous = process.env.META_GRAPH_API_VERSION;
  if (value === undefined) delete process.env.META_GRAPH_API_VERSION;
  else process.env.META_GRAPH_API_VERSION = value;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.META_GRAPH_API_VERSION;
    else process.env.META_GRAPH_API_VERSION = previous;
  }
}

const NOW = new Date("2026-11-26T00:00:00Z");

test("the built-in default is recognised as past its support window", () => {
  // v21.0 shipped 2024-10-02 and Meta supports a version about two years, so by late 2026
  // it is past sunset. This is the staleness that was shipping silently.
  withVersion(undefined, () => {
    const info = metaVersionInfo(NOW);
    assert.equal(info.version, META_DEFAULT_VERSION);
    assert.equal(info.configured, false);
    assert.equal(info.status, "past-sunset");
    assert.equal(info.estimatedSunset, "2026-10-02");
    assert.match(info.warning, /no longer supported/);
  });
});

test("falling back to a sunset default is refused, with an actionable message", () => {
  withVersion(undefined, () => {
    assert.throws(() => metaGraphBaseUrl(), (error) => {
      assert.equal(error.code, "META_VERSION_UNSUPPORTED");
      assert.match(error.message, /META_GRAPH_API_VERSION/);
      assert.match(error.message, /changelog/);
      return true;
    });
  });
});

test("an explicitly configured version is never blocked, even an old one", () => {
  // A deployment that has deliberately pinned a version keeps working; it is only the
  // silent fallback that is refused.
  withVersion("v21.0", () => {
    assert.equal(metaVersionInfo(NOW).configured, true);
    assert.equal(metaGraphBaseUrl(), "https://graph.facebook.com/v21.0");
  });
});

test("a version newer than this build knows is accepted and reported as unverified", () => {
  withVersion("v23.0", () => {
    const info = metaVersionInfo(NOW);
    assert.equal(info.status, "unknown");
    assert.match(info.note, /no release date for Graph API v23.0/);
    assert.match(info.note, /changelog/);
    // Honest about not knowing rather than asserting it is current.
    assert.ok(!("estimatedSunset" in info));
    assert.equal(metaGraphBaseUrl(), "https://graph.facebook.com/v23.0");
  });
});

test("a version still inside its window reports as supported", () => {
  // v21.0 one day before its estimated sunset.
  withVersion("v21.0", () => {
    const info = metaVersionInfo(new Date("2026-10-01T00:00:00Z"));
    assert.equal(info.status, "supported");
    assert.ok(!info.warning);
  });
});

test("every known release date yields a sunset two years later", () => {
  for (const [version, released] of Object.entries(META_VERSION_RELEASES)) {
    withVersion(version, () => {
      const info = metaVersionInfo(new Date("2000-01-01T00:00:00Z"));
      assert.equal(info.releasedOn, released);
      assert.equal(Number(info.estimatedSunset.slice(0, 4)) - Number(released.slice(0, 4)), META_SUPPORT_YEARS, `${version} sunset`);
    });
  }
});

test("whitespace around a configured version is tolerated", () => {
  withVersion("  v23.0  ", () => assert.equal(metaGraphVersion(), "v23.0"));
});
