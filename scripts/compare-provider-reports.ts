import { readFile } from "node:fs/promises";

import type { ProviderSpikeReport } from "../lib/providers/types";

type Args = {
  left: string;
  right: string;
};

function parseArgs(argv: string[]): Args {
  let left = "";
  let right = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--left") left = argv[++index] ?? "";
    if (arg === "--right") right = argv[++index] ?? "";
  }

  if (!left || !right) {
    throw new Error(
      "Usage: npm run spike:compare -- --left <report-a.json> --right <report-b.json>",
    );
  }

  return { left, right };
}

async function loadReport(file: string): Promise<ProviderSpikeReport> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as ProviderSpikeReport;
  if (!parsed?.provider || !Array.isArray(parsed.fixtures) || !parsed.summary) {
    throw new Error(`Invalid provider spike report: ${file}`);
  }
  return parsed;
}

function nullableBoolean(value: boolean | null): string {
  if (value == null) return "unknown";
  return value ? "yes" : "no";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [left, right] = await Promise.all([
    loadReport(args.left),
    loadReport(args.right),
  ]);

  const rightByGame = new Map(
    right.fixtures.map((fixture) => [fixture.gameNumber, fixture]),
  );

  const fixtureComparison = left.fixtures.map((leftFixture) => {
    const rightFixture = rightByGame.get(leftFixture.gameNumber);
    if (!rightFixture) {
      throw new Error(
        `Right report is missing game ${leftFixture.gameNumber}.`,
      );
    }

    return {
      gameNumber: leftFixture.gameNumber,
      match: `${leftFixture.input.homeTeam} - ${leftFixture.input.awayTeam}`,
      [left.provider]: {
        resolved: Boolean(leftFixture.resolvedFixture),
        resolution: leftFixture.fixtureResolution,
        lineupsSupported: nullableBoolean(leftFixture.capabilities.lineups),
        lineupEntries: leftFixture.lineupEntries,
        injuriesSupported: nullableBoolean(leftFixture.capabilities.injuries),
        injuryEntries: leftFixture.injuryEntries,
        oddsSupported: nullableBoolean(leftFixture.capabilities.odds),
        completeBookmakers: leftFixture.completeBookmakers,
        marketPrior: leftFixture.marketPrior?.probabilitiesBp ?? null,
        analytics: leftFixture.analytics ?? null,
        errors: leftFixture.providerErrors,
      },
      [right.provider]: {
        resolved: Boolean(rightFixture.resolvedFixture),
        resolution: rightFixture.fixtureResolution,
        lineupsSupported: nullableBoolean(rightFixture.capabilities.lineups),
        lineupEntries: rightFixture.lineupEntries,
        injuriesSupported: nullableBoolean(rightFixture.capabilities.injuries),
        injuryEntries: rightFixture.injuryEntries,
        oddsSupported: nullableBoolean(rightFixture.capabilities.odds),
        completeBookmakers: rightFixture.completeBookmakers,
        marketPrior: rightFixture.marketPrior?.probabilitiesBp ?? null,
        analytics: rightFixture.analytics ?? null,
        errors: rightFixture.providerErrors,
      },
    };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    providers: [left.provider, right.provider],
    summary: {
      [left.provider]: left.summary,
      [right.provider]: right.summary,
      deltasRightMinusLeft: {
        resolvedFixtures:
          right.summary.resolvedFixtures - left.summary.resolvedFixtures,
        fixturesWithObservedLineups:
          right.summary.fixturesWithObservedLineups -
          left.summary.fixturesWithObservedLineups,
        fixturesWithObservedInjuries:
          right.summary.fixturesWithObservedInjuries -
          left.summary.fixturesWithObservedInjuries,
        fixturesWithObservedOdds:
          right.summary.fixturesWithObservedOdds -
          left.summary.fixturesWithObservedOdds,
        fixturesWithObservedStatistics:
          right.summary.fixturesWithObservedStatistics -
          left.summary.fixturesWithObservedStatistics,
        fixturesWithObservedXg:
          right.summary.fixturesWithObservedXg -
          left.summary.fixturesWithObservedXg,
        fixturesWithObservedPressure:
          right.summary.fixturesWithObservedPressure -
          left.summary.fixturesWithObservedPressure,
        averageCompleteBookmakersWhenAvailable:
          Math.round(
            (right.summary.averageCompleteBookmakersWhenAvailable -
              left.summary.averageCompleteBookmakersWhenAvailable) *
              100,
          ) / 100,
      },
    },
    fixtures: fixtureComparison,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
