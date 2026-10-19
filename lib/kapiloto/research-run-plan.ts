import {
  assessFixtureResearchEligibility,
  buildKapilotoFixtureCard,
  type FixtureCardInput,
  type KapilotoFixtureCard,
} from "./fixture-card";
import { sha256Hex } from "./snapshot";

export type PreviousFixtureAnalysis = {
  fixtureId: string;
  analysisId: string;
};

export type ResearchFixtureDisposition =
  | {
      gameNumber: number;
      fixtureId: string;
      roundGameId: string;
      mode: "research";
      taskKey: string;
      card: KapilotoFixtureCard;
    }
  | {
      gameNumber: number;
      fixtureId: string;
      roundGameId: string;
      mode: "carried_forward";
      carriedFromAnalysisId: string;
      reason:
        | "kickoff_too_close"
        | "already_started"
        | "missing_prior"
        | "post_cutoff_prior";
    }
  | {
      gameNumber: number;
      fixtureId: string;
      roundGameId: string;
      mode: "research_unavailable";
      reason:
        | "kickoff_too_close"
        | "already_started"
        | "missing_prior"
        | "post_cutoff_prior"
        | "invalid_fixture";
    };

export type KapilotoResearchRunPlan = {
  researchCutoffAt: string;
  fixtures: ResearchFixtureDisposition[];
  taskGameIds: string[];
  taskFixtureIds: string[];
  fixtureSetSha256: string;
};

export function buildKapilotoResearchRunPlan(
  inputs: FixtureCardInput[],
  researchCutoffAt: string,
  previousAnalyses: PreviousFixtureAnalysis[] = [],
): KapilotoResearchRunPlan {
  if (inputs.length !== 16) {
    throw new Error(`Kapiloto run plan requires exactly 16 fixtures; got ${inputs.length}.`);
  }

  const sorted = [...inputs].sort((a, b) => a.gameNumber - b.gameNumber);
  const expected = Array.from({ length: 16 }, (_, index) => index + 1);
  if (
    sorted.some(
      (input, index) =>
        input.gameNumber !== expected[index] ||
        (index > 0 &&
          (input.roundGameId === sorted[index - 1].roundGameId ||
            input.fixtureId === sorted[index - 1].fixtureId)),
    )
  ) {
    throw new Error("Kapiloto run plan requires unique Toto numbers 1..16.");
  }

  const previousByFixture = new Map(
    previousAnalyses.map((analysis) => [
      analysis.fixtureId,
      analysis.analysisId,
    ]),
  );

  const fixtures: ResearchFixtureDisposition[] = sorted.map((input) => {
    const eligibility = assessFixtureResearchEligibility(
      input,
      researchCutoffAt,
    );

    if (eligibility.eligible) {
      return {
        gameNumber: input.gameNumber,
        fixtureId: input.fixtureId,
        roundGameId: input.roundGameId,
        mode: "research",
        taskKey: `fixture:${input.fixtureId}`,
        card: buildKapilotoFixtureCard(input, researchCutoffAt),
      };
    }

    const previousAnalysisId = previousByFixture.get(input.fixtureId);
    if (
      previousAnalysisId &&
      (eligibility.reason === "kickoff_too_close" ||
        eligibility.reason === "already_started" ||
        eligibility.reason === "missing_prior" ||
        eligibility.reason === "post_cutoff_prior")
    ) {
      return {
        gameNumber: input.gameNumber,
        fixtureId: input.fixtureId,
        roundGameId: input.roundGameId,
        mode: "carried_forward",
        carriedFromAnalysisId: previousAnalysisId,
        reason: eligibility.reason,
      };
    }

    return {
      gameNumber: input.gameNumber,
      roundGameId: input.roundGameId,
      mode: "research_unavailable",
      reason: eligibility.reason,
    };
  });

  const taskGameIds = fixtures
    .filter(
      (
        fixture,
      ): fixture is Extract<ResearchFixtureDisposition, { mode: "research" }> =>
        fixture.mode === "research",
    )
    .map((fixture) => fixture.roundGameId);

  const taskFixtureIds = fixtures
    .filter(
      (
        fixture,
      ): fixture is Extract<ResearchFixtureDisposition, { mode: "research" }> =>
        fixture.mode === "research",
    )
    .map((fixture) => fixture.fixtureId);

  const researchCutoffIso = new Date(researchCutoffAt).toISOString();
  const fixtureSetSha256 = sha256Hex({
    research_cutoff_at: researchCutoffIso,
    fixtures,
  });

  return {
    researchCutoffAt: researchCutoffIso,
    fixtures,
    taskGameIds,
    taskFixtureIds,
    fixtureSetSha256,
  };
}
