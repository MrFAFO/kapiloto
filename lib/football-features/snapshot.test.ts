import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderCompletedMatch,
  ProviderStanding,
} from "@/lib/providers/types";
import { buildFixtureStructuredSnapshotV1 } from "./snapshot";

function history(
  provider: "sportmonks" | "api-football",
  teamId: string,
  opponentId: string,
  competitionId: string,
  season: number,
): ProviderCompletedMatch[] {
  return Array.from({ length: 6 }, (_, index) => {
    const home = index % 2 === 0;
    return {
      provider,
      providerFixtureId: `${provider}-${teamId}-${index}`,
      kickoffAt: new Date(
        Date.parse("2026-10-30T18:00:00Z") -
          (index + 2) * 3 * 86_400_000,
      ).toISOString(),
      competition: {
        id: competitionId,
        name: "League",
        country: "Israel",
      },
      season,
      home: {
        id: home ? teamId : opponentId,
        name: home ? teamId : opponentId,
      },
      away: {
        id: home ? opponentId : teamId,
        name: home ? opponentId : teamId,
      },
      homeScore: home ? 2 : 0,
      awayScore: home ? 1 : 1,
    };
  });
}

function standing(
  provider: "sportmonks" | "api-football",
  teamId: string,
  competitionId: string,
  season: number,
): ProviderStanding {
  return {
    provider,
    competitionId,
    season,
    teamId,
    position: 4,
    points: 17,
    played: 9,
    goalDifference: 5,
    pointsDeducted: null,
  };
}

test("builds a deterministic replayable snapshot with provider lineage", () => {
  const input = {
    fixtureId: "fixture-1",
    researchCutoffAt: "2026-10-29T12:00:00Z",
    targetKickoffAt: "2026-10-30T18:00:00Z",
    home: {
      provider: "sportmonks" as const,
      providerTeamId: "10",
      providerCompetitionId: "372",
      providerSeason: 20260,
      matches: history("sportmonks", "10", "99", "372", 20260),
      standings: [standing("sportmonks", "10", "372", 20260)],
      observedAt: "2026-10-29T11:00:00Z",
    },
    away: {
      provider: "api-football" as const,
      providerTeamId: "20",
      providerCompetitionId: "383",
      providerSeason: 2026,
      matches: history("api-football", "20", "98", "383", 2026),
      standings: [standing("api-football", "20", "383", 2026)],
      observedAt: "2026-10-29T11:05:00Z",
    },
  };

  const one = buildFixtureStructuredSnapshotV1(
    input,
    "2026-10-29T11:10:00Z",
  );
  const two = buildFixtureStructuredSnapshotV1(
    {
      ...input,
      home: {
        ...input.home,
        matches: [...input.home.matches].reverse(),
      },
    },
    "2026-10-29T11:11:00Z",
  );

  assert.equal(one.features.home.form?.played, 6);
  assert.equal(one.features.away.form?.played, 6);
  assert.equal(one.features.home.table?.position, 4);
  assert.equal(one.input_payload.home.provider, "sportmonks");
  assert.equal(one.input_payload.away.provider, "api-football");
  assert.equal(one.sha256, two.sha256);
});

test("snapshot hash changes when a provider fact changes", () => {
  const base = {
    fixtureId: "fixture-1",
    researchCutoffAt: "2026-10-29T12:00:00Z",
    targetKickoffAt: "2026-10-30T18:00:00Z",
    home: {
      provider: "sportmonks" as const,
      providerTeamId: "10",
      providerCompetitionId: "372",
      providerSeason: 20260,
      matches: history("sportmonks", "10", "99", "372", 20260),
      standings: [standing("sportmonks", "10", "372", 20260)],
      observedAt: "2026-10-29T11:00:00Z",
    },
    away: {
      provider: "sportmonks" as const,
      providerTeamId: "20",
      providerCompetitionId: "372",
      providerSeason: 20260,
      matches: history("sportmonks", "20", "98", "372", 20260),
      standings: [standing("sportmonks", "20", "372", 20260)],
      observedAt: "2026-10-29T11:00:00Z",
    },
  };

  const original = buildFixtureStructuredSnapshotV1(base);
  const changedMatches = structuredClone(base.home.matches);
  changedMatches[0].homeScore += 1;
  const changed = buildFixtureStructuredSnapshotV1({
    ...base,
    home: { ...base.home, matches: changedMatches },
  });

  assert.notEqual(original.sha256, changed.sha256);
});
