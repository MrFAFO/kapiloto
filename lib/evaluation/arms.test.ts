import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeterministicArmPredictions,
  EVAL_ARM,
  type ShadowFixtureContext,
} from "./arms";
import {
  KAPILOTO_PUBLISHED_PROJECTION_VERSION,
  projectKapilotoPublication,
  type PublishedKapilotoAnalysis,
} from "./kapiloto-projection";
import type { MarketQuoteRecord } from "./market-prior";
import { syntheticLeague } from "./test-fixtures";

const league = syntheticLeague({ teams: 10, seasons: 3 });
const lastKickoff = Date.parse(league[league.length - 1].kickoffAt);
const KICKOFF = new Date(lastKickoff + 7 * 86_400_000).toISOString();
const CUTOFF = new Date(Date.parse(KICKOFF) - 6 * 3_600_000).toISOString();

const context: ShadowFixtureContext = {
  fixtureId: "00000000-0000-4000-8000-000000000f01",
  roundGameId: "00000000-0000-4000-8000-000000000r01",
  homeTeamId: "00000000-0000-4000-8000-0000000000a1",
  awayTeamId: "00000000-0000-4000-8000-0000000000a2",
  kickoffAt: KICKOFF,
  neutralVenue: false,
  competitionKey: "sportmonks:8",
  homeTeamKey: "sportmonks:t0",
  awayTeamKey: "sportmonks:t9",
};

const quotes: MarketQuoteRecord[] = [1, 2, 3].map((index) => ({
  id: `q${index}`,
  fixtureId: context.fixtureId,
  provider: "api-football",
  bookmakerId: String(index),
  bookmakerName: `Book ${index}`,
  capturedAt: new Date(Date.parse(CUTOFF) - index * 600_000).toISOString(),
  sourceUpdatedAt: null,
  odds: { home: 1.6 + index / 100, draw: 3.9, away: 5.5 },
}));

const build = (overrides: Partial<Parameters<typeof buildDeterministicArmPredictions>[0]> = {}) =>
  buildDeterministicArmPredictions({
    context,
    cutoffAt: CUTOFF,
    mode: "forward",
    history: league,
    quotes,
    ...overrides,
  });

test("B1-B4 drafts carry provenance and valid probabilities", () => {
  const drafts = build();
  assert.deepEqual(
    drafts.map((draft) => [draft.arm, draft.valid]),
    [
      [EVAL_ARM.uniform, true],
      [EVAL_ARM.leagueBase, true],
      [EVAL_ARM.pStat, true],
      [EVAL_ARM.market, true],
    ],
  );
  for (const draft of drafts) {
    assert.equal(draft.fixture_id, context.fixtureId);
    assert.equal(draft.information_cutoff_at, CUTOFF);
    assert.equal(draft.kickoff_at_snapshot, KICKOFF);
    assert.equal(draft.home_team_id, context.homeTeamId);
    assert.equal(draft.issued_at_source, "recorded");
    assert.equal(draft.deterministic, true);
    assert.match(draft.input_sha256, /^[0-9a-f]{64}$/);
    const total = (draft.p_home ?? 0) + (draft.p_draw ?? 0) + (draft.p_away ?? 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
  }
  const market = drafts.find((draft) => draft.arm === EVAL_ARM.market);
  assert.equal(market?.arm_version, "kapiloto-market-prior-v1;devig-power-v1");
  assert.equal((market?.basis as { quality: string }).quality, "standard");
});

test("drafts are reproducible and unaffected by post-cutoff data", () => {
  const first = build();
  assert.deepEqual(build(), first);

  const futureMatches = league.slice(0, 30).map((item, index) => ({
    ...item,
    providerFixtureId: `future-${index}`,
    kickoffAt: new Date(Date.parse(CUTOFF) - 60_000 + index * 3_600_000).toISOString(),
    homeGoals: 0,
    awayGoals: 7,
  }));
  const futureQuote: MarketQuoteRecord = {
    ...quotes[0],
    id: "late",
    capturedAt: new Date(Date.parse(CUTOFF) + 60_000).toISOString(),
    odds: { home: 9, draw: 9, away: 1.05 },
  };
  const withFuture = build({
    history: [...league, ...futureMatches],
    quotes: [...quotes, futureQuote],
  });
  for (const [index, draft] of withFuture.entries()) {
    assert.equal(draft.p_home, first[index].p_home);
    assert.equal(draft.p_away, first[index].p_away);
    if (draft.arm !== EVAL_ARM.market) {
      assert.equal(draft.input_sha256, first[index].input_sha256);
    }
  }
});

test("missing mappings and missing market produce explicit unavailable drafts", () => {
  const drafts = build({
    context: { ...context, competitionKey: null, homeTeamKey: null },
    quotes: [],
  });
  assert.deepEqual(
    drafts.map((draft) => [draft.arm, draft.valid, draft.invalid_reason]),
    [
      [EVAL_ARM.uniform, true, null],
      [EVAL_ARM.leagueBase, false, "competition_unmapped"],
      [EVAL_ARM.pStat, false, "competition_unmapped"],
      [EVAL_ARM.market, false, "no_quotes_before_cutoff"],
    ],
  );
  for (const draft of drafts.filter((item) => !item.valid)) {
    assert.equal(draft.p_home, null);
  }
});

test("a cutoff inside the kickoff safety margin is refused", () => {
  assert.throws(
    () => build({ cutoffAt: new Date(Date.parse(KICKOFF) - 10 * 60_000).toISOString() }),
    /safety margin/,
  );
});

function publication(overrides: Partial<PublishedKapilotoAnalysis> = {}): PublishedKapilotoAnalysis {
  return {
    publicationId: "pub-1",
    publishedAt: "2026-10-24T08:00:00.000Z",
    analysisId: "00000000-0000-4000-8000-0000000000b1",
    researchRunId: "run-1",
    fixtureId: context.fixtureId,
    roundGameId: "round-game-1",
    outcome: "analyzed",
    orientationVerified: true,
    researchCutoffAt: "2026-10-24T06:00:00.000Z",
    kickoffAtSnapshot: KICKOFF,
    roundGameHomeTeamId: context.homeTeamId,
    roundGameAwayTeamId: context.awayTeamId,
    priorType: "league_base",
    pFinal: { home: 3573, draw: 3250, away: 3177 },
    pSol: { home: 4100, draw: 3050, away: 2850 },
    derivationVersion: "kapiloto-derivation-v4",
    blendPolicyVersion: "kapiloto-blend-shadow-v2",
    reliabilityFormulaVersion: "kapiloto-reliability-shadow-v4",
    calibrationVersion: null,
    ...overrides,
  };
}

test("B5 projects published p_final and raw p_sol without altering them", () => {
  const [published, sol] = projectKapilotoPublication(publication());
  assert.equal(published.arm, EVAL_ARM.kapilotoPublished);
  assert.equal(published.arm_version, KAPILOTO_PUBLISHED_PROJECTION_VERSION);
  assert.equal(published.evaluation_mode, "forward");
  assert.equal(published.deterministic, false);
  assert.equal(published.issued_at_source, "kapiloto_publication");
  assert.equal(published.source_analysis_id, publication().analysisId);
  assert.deepEqual([published.p_home, published.p_draw, published.p_away], [0.3573, 0.325, 0.3177]);
  assert.equal(sol.arm, EVAL_ARM.kapilotoSol);
  assert.deepEqual([sol.p_home, sol.p_draw, sol.p_away], [0.41, 0.305, 0.285]);
});

test("B5 marks unpublishable analyses as unavailable instead of inventing probabilities", () => {
  const [insufficient] = projectKapilotoPublication(
    publication({ outcome: "insufficient_data", pFinal: null, pSol: null }),
  );
  assert.equal(insufficient.valid, false);
  assert.equal(insufficient.invalid_reason, "kapiloto_outcome_insufficient_data");

  const [unverified] = projectKapilotoPublication(publication({ orientationVerified: false }));
  assert.equal(unverified.invalid_reason, "orientation_unverified");
});
