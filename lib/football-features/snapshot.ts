import type {
  ProviderCompletedMatch,
  ProviderName,
  ProviderStanding,
} from "@/lib/providers/types";
import { sha256Hex } from "@/lib/kapiloto/snapshot";
import {
  buildTeamStructuredFeaturesV1,
  KAPILOTO_FEATURE_VERSION,
  type FixtureStructuredFeaturesV1,
} from "./v1";

export type TeamStructuredProviderInput = {
  provider: ProviderName;
  providerTeamId: string;
  providerCompetitionId: string;
  providerSeason: number | null;
  matches: ProviderCompletedMatch[];
  standings: ProviderStanding[];
  observedAt: string;
};

export type FixtureStructuredSnapshotInput = {
  fixtureId: string;
  researchCutoffAt: string;
  targetKickoffAt: string;
  home: TeamStructuredProviderInput;
  away: TeamStructuredProviderInput;
};

export type FixtureStructuredSnapshotDraft = {
  fixture_id: string;
  feature_version: typeof KAPILOTO_FEATURE_VERSION;
  research_cutoff_at: string;
  computed_at: string;
  features: FixtureStructuredFeaturesV1;
  input_payload: {
    home: {
      provider: ProviderName;
      provider_team_id: string;
      provider_competition_id: string;
      provider_season: number | null;
      matches: ProviderCompletedMatch[];
      standings: ProviderStanding[];
    };
    away: {
      provider: ProviderName;
      provider_team_id: string;
      provider_competition_id: string;
      provider_season: number | null;
      matches: ProviderCompletedMatch[];
      standings: ProviderStanding[];
    };
  };
  sha256: string;
};

function validIso(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return new Date(parsed).toISOString();
}

function standingFor(
  input: TeamStructuredProviderInput,
): ProviderStanding | null {
  return (
    input.standings.find(
      (row) =>
        row.provider === input.provider &&
        row.teamId === input.providerTeamId &&
        row.competitionId === input.providerCompetitionId &&
        (input.providerSeason == null || row.season === input.providerSeason),
    ) ?? null
  );
}

export function buildFixtureStructuredSnapshotV1(
  input: FixtureStructuredSnapshotInput,
  computedAt = new Date().toISOString(),
): FixtureStructuredSnapshotDraft {
  const cutoff = validIso(input.researchCutoffAt, "researchCutoffAt");
  const kickoff = validIso(input.targetKickoffAt, "targetKickoffAt");
  const computed = validIso(computedAt, "computedAt");

  if (Date.parse(cutoff) >= Date.parse(kickoff)) {
    throw new Error("Structured snapshot cutoff must be before target kickoff.");
  }

  const home = buildTeamStructuredFeaturesV1({
    teamId: input.home.providerTeamId,
    venue: "home",
    targetCompetitionId: input.home.providerCompetitionId,
    targetSeason: input.home.providerSeason,
    targetKickoffAt: kickoff,
    researchCutoffAt: cutoff,
    matches: input.home.matches,
    standing: standingFor(input.home),
  });
  const away = buildTeamStructuredFeaturesV1({
    teamId: input.away.providerTeamId,
    venue: "away",
    targetCompetitionId: input.away.providerCompetitionId,
    targetSeason: input.away.providerSeason,
    targetKickoffAt: kickoff,
    researchCutoffAt: cutoff,
    matches: input.away.matches,
    standing: standingFor(input.away),
  });

  const features: FixtureStructuredFeaturesV1 = {
    feature_version: KAPILOTO_FEATURE_VERSION,
    home,
    away,
    sources: [
      {
        provider: input.home.provider,
        capability: "results",
        observed_at: validIso(input.home.observedAt, "home.observedAt"),
      },
      {
        provider: input.home.provider,
        capability: "standings",
        observed_at: validIso(input.home.observedAt, "home.observedAt"),
      },
      {
        provider: input.away.provider,
        capability: "results",
        observed_at: validIso(input.away.observedAt, "away.observedAt"),
      },
      {
        provider: input.away.provider,
        capability: "standings",
        observed_at: validIso(input.away.observedAt, "away.observedAt"),
      },
    ],
  };

  const inputPayload = {
    home: {
      provider: input.home.provider,
      provider_team_id: input.home.providerTeamId,
      provider_competition_id: input.home.providerCompetitionId,
      provider_season: input.home.providerSeason,
      matches: input.home.matches,
      standings: input.home.standings,
    },
    away: {
      provider: input.away.provider,
      provider_team_id: input.away.providerTeamId,
      provider_competition_id: input.away.providerCompetitionId,
      provider_season: input.away.providerSeason,
      matches: input.away.matches,
      standings: input.away.standings,
    },
  };

  const hashPayload = {
    fixture_id: input.fixtureId,
    feature_version: KAPILOTO_FEATURE_VERSION,
    research_cutoff_at: cutoff,
    features,
    input_payload: inputPayload,
  };

  return {
    fixture_id: input.fixtureId,
    feature_version: KAPILOTO_FEATURE_VERSION,
    research_cutoff_at: cutoff,
    computed_at: computed,
    features,
    input_payload: inputPayload,
    sha256: sha256Hex(hashPayload),
  };
}
