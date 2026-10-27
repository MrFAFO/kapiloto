import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareKapilotoRunPublication,
  type FinalizableResearchRun,
} from "./run-finalizer";
import {
  groundV3,
  patternJudge,
  v3Card,
  v3Output,
} from "./test-support/research-v3-fixtures";

test("v3 rejected descriptive availability evidence is pruned without a false fixture downgrade", async () => {
  const card = v3Card();
  const output = v3Output();
  const availabilityFactor = output.factors.find(
    (factor) => factor.dimension === "availability",
  );
  assert.ok(availabilityFactor);
  availabilityFactor.favors = "none";
  availabilityFactor.magnitude = "small";

  const grounding = groundV3(output, card);

  const fixtureSet: FinalizableResearchRun["fixtureSet"] = [
    {
      gameNumber: 1,
      roundGameId: card.round_game_id,
      fixtureId: card.fixture_id,
      mode: "research",
      taskKey: `fixture:${card.fixture_id}`,
      card,
    },
    ...Array.from({ length: 15 }, (_, index) => {
      const gameNumber = index + 2;
      return {
        gameNumber,
        roundGameId: `game-${gameNumber}`,
        fixtureId: `fixture-${gameNumber}`,
        mode: "research_unavailable" as const,
        reason: "missing_prior" as const,
        context: {
          kickoffAt: card.kickoff_at,
          settlementRule: card.settlement,
          neutralVenue: false,
        },
      };
    }),
  ];

  const run: FinalizableResearchRun = {
    runId: "run-v3-observability",
    roundId: "round-v3",
    status: "running",
    researchCutoffAt: card.research_cutoff_at,
    fixtureSet,
    attempts: [{
      roundGameId: card.round_game_id,
      fixtureId: card.fixture_id,
      validatedOutput: output,
      grounding,
    }],
    carriedSources: [],
  };

  const prepared = await prepareKapilotoRunPublication(
    run,
    patternJudge([/Away FC captain Zed Anchor/]),
  );

  assert.equal(prepared.entailment.unsupported.length, 1);
  assert.deepEqual(prepared.entailment.downgradedFixtureIds, []);

  const analysis = prepared.materialized.analyses[0];
  assert.equal(analysis.outcome, "analyzed");
  assert.notEqual(analysis.p_sol_1_bp, null);
  assert.deepEqual(analysis.availability, []);
  assert.equal(
    analysis.inputs.some(
      (input) =>
        input.input_type === "entailment_verification" &&
        Array.isArray(input.metadata.downgraded_fixture_ids) &&
        input.metadata.downgraded_fixture_ids.length === 0,
    ),
    true,
  );
});
