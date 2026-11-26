import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSelectQuery, isSelectQuery, withGaqlLimit } from "./gaql.js";

test("non-SELECT GAQL is rejected", () => {
  const rejected = [
    "", "   ", "SELECT 1", "campaign.id FROM campaign",
    "UPDATE campaign SET status = 'PAUSED'",
    "DELETE FROM campaign",
    "INSERT INTO campaign VALUES (1)",
    "DROP TABLE campaign",
    "SELECT campaign.id FROM campaign; DROP TABLE x",
    "MUTATE campaign",
    "  \n\t ",
    "{\"query\": \"SELECT campaign.id FROM campaign\"}"
  ];
  for (const query of rejected) {
    assert.throws(() => assertSelectQuery(query), (error) => {
      assert.equal(error.code, "INVALID_QUERY");
      return true;
    }, `${JSON.stringify(query)} was accepted`);
    assert.equal(isSelectQuery(query), false);
  }
});

test("valid SELECT reads are accepted", () => {
  const accepted = [
    "SELECT campaign.id FROM campaign",
    "select campaign.id from campaign",
    "SELECT customer.id, customer.descriptive_name FROM customer",
    "SELECT campaign.id FROM campaign WHERE segments.date BETWEEN '2026-01-01' AND '2026-01-31' ORDER BY metrics.clicks DESC LIMIT 50",
    "SELECT campaign.id FROM campaign;"
  ];
  for (const query of accepted) assert.ok(isSelectQuery(query), `${query} was rejected`);
});

test("a literal containing a write keyword does not trip the filter", () => {
  // A campaign really can be called "Update 2026" or "Create Leads".
  const query = "SELECT campaign.id FROM campaign WHERE campaign.name = 'Update 2026 - Create Leads'";
  assert.equal(assertSelectQuery(query), query);
});

test("withGaqlLimit expresses a row ceiling in the query, since v26 search has no pageSize", () => {
  assert.equal(withGaqlLimit("SELECT a FROM b", 50), "SELECT a FROM b LIMIT 50");
  assert.equal(withGaqlLimit("SELECT a FROM b LIMIT 9", 50), "SELECT a FROM b LIMIT 50");
  assert.equal(withGaqlLimit("SELECT a FROM b;", 10), "SELECT a FROM b LIMIT 10");
  assert.equal(withGaqlLimit("SELECT a FROM b", 0), "SELECT a FROM b");
  assert.equal(withGaqlLimit("SELECT a FROM b", undefined), "SELECT a FROM b");
});
