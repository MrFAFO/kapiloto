import assert from "node:assert/strict";
import test from "node:test";

import { shadowResultsIngestEnabled } from "./env";
import { DEFAULT_INCREMENTAL_INGEST_CONFIG, incrementalIngestDue, planIncrementalIngest } from "./results-ingest";

const now = new Date("2026-10-24T12:00:00Z");

test("incremental ingestion re-reads from the latest stored kickoff minus the overlap, up to yesterday", () => {
  const plan = planIncrementalIngest(now, ["8", "372"], new Map([["8", "2026-10-19T14:00:00Z"], ["372", null]]));
  assert.deepEqual(plan, [
    { leagueId: "372", startDate: "2026-09-24", endDate: "2026-10-23" },
    { leagueId: "8", startDate: "2026-10-12", endDate: "2026-10-23" },
  ]);
});

test("a league with no stored rows only looks back the short initial window, never a silent backfill", () => {
  const [item] = planIncrementalIngest(now, ["82"], new Map());
  const days = (Date.parse(item.endDate) - Date.parse(item.startDate)) / 86_400_000 + 1;
  assert.equal(days, DEFAULT_INCREMENTAL_INGEST_CONFIG.initialLookbackDays);
});

test("incremental ingestion is due at most once per configured interval", () => {
  assert.equal(incrementalIngestDue(null, now), true);
  assert.equal(incrementalIngestDue("2026-10-24T10:00:00Z", now), false);
  assert.equal(incrementalIngestDue("2026-10-23T10:00:00Z", now), true);
});

test("recurring results ingestion is off unless explicitly enabled", () => {
  assert.equal(shadowResultsIngestEnabled({}), false);
  assert.equal(shadowResultsIngestEnabled({ KAPILOTO_SHADOW_RESULTS_INGEST_ENABLED: "true" }), false);
  assert.equal(
    shadowResultsIngestEnabled({ KAPILOTO_SHADOW_EVALUATION_ENABLED: "true", KAPILOTO_SHADOW_RESULTS_INGEST_ENABLED: "true" }),
    true,
  );
});
