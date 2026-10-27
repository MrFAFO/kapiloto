import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderFixture } from "@/lib/providers/types";
import {
  completeMissingKickoffsFromFixtures,
  crossScriptTeamSimilarity,
  deriveConservativeOperationalLock,
  romanizeTeamName,
  sportmonksCompletionWindow,
} from "./automatic-resolution";
import type { TotoRoundDiscovery } from "./toto-source";

function round(): TotoRoundDiscovery {
  return {
    source: "telesport-winner16",
    sourceUrl: "https://example.test",
    externalRoundNumber: "264201",
    sourceVersion: "sha256:test",
    fetchedAt: "2026-10-20T08:00:00.000Z",
    completeKickoffs: false,
    games: Array.from({ length: 16 }, (_, i) => ({
      gameNumber: i + 1,
      rawKickoff: i >= 14 ? "ת. סיום" : "24/10 19:00",
      kickoffAt: i >= 14 ? null : new Date(Date.UTC(2026, 9, 24, 16, i)).toISOString(),
      homeTeam: i === 14 ? "פ.צ. קלן" : i === 15 ? "פאדרבורן" : `בית ${i + 1}`,
      awayTeam: i === 14 ? "שאלקה 04" : i === 15 ? "המבורג" : `חוץ ${i + 1}`,
      competition: {
        canonicalName: i >= 14 ? "Bundesliga" : "Ligat Ha'al",
        countryCode: i >= 14 ? "DE" : "IL",
        competitionType: "league",
        sourceLabel: i >= 14 ? "גרמניה - בונדסליגה" : "ישראל - ליגת Winner",
      },
    })),
  };
}

function fx(id: string, home: string, away: string, kickoffAt: string): ProviderFixture {
  return {
    provider: "sportmonks",
    providerFixtureId: id,
    kickoffAt,
    status: "NS",
    season: 2026,
    competition: { id: "82", name: "Bundesliga", country: "Germany", round: "8" },
    home: { id: `h-${id}`, name: home },
    away: { id: `a-${id}`, name: away },
  };
}

test("cross-script club matching covers common source spellings", () => {
  assert.equal(romanizeTeamName("פאדרבורן"), "paderborn");
  assert.ok(crossScriptTeamSimilarity("פ.צ. קלן", "FC Köln") >= 0.8);
  assert.ok(crossScriptTeamSimilarity("שאלקה 04", "Schalke 04") >= 0.8);
});

test("fills unresolved kickoffs from clear Sportmonks matches", () => {
  const result = completeMissingKickoffsFromFixtures(round(), [
    fx("1001", "FC Köln", "Schalke 04", "2026-10-25T14:30:00Z"),
    fx("1002", "Paderborn", "Hamburger SV", "2026-10-25T16:30:00Z"),
  ]);

  assert.equal(result.discovery.completeKickoffs, true);
  assert.deepEqual(result.unresolvedGameNumbers, []);
  assert.equal(result.resolvedBySportmonks.length, 2);
});

test("builds completion window and conservative lock", () => {
  assert.deepEqual(sportmonksCompletionWindow(round()), {
    startDate: "2026-10-23",
    endDate: "2026-10-26",
  });

  const input = round();
  input.games[14].kickoffAt = "2026-10-25T14:30:00.000Z";
  input.games[15].kickoffAt = "2026-10-25T16:30:00.000Z";
  input.completeKickoffs = true;

  const lock = deriveConservativeOperationalLock(input, 30);
  assert.equal(lock.lockAt, "2026-10-24T15:30:00.000Z");
  assert.equal(lock.sourceRef, "earliest_fixture_minus_30m");
  assert.equal(lock.derived, true);
});
