import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ApiFootballClient } from "../lib/providers/api-football";
import { SportmonksClient } from "../lib/providers/sportmonks";
import type {
  ProviderFixtureCoverage,
  ProviderName,
  ProviderSpikeFixtureInput,
  ProviderSpikeReport,
} from "../lib/providers/types";

type Args = {
  provider: ProviderName;
  input: string;
  out: string | null;
  concurrency: number;
};

function parseArgs(argv: string[]): Args {
  let provider: ProviderName = "api-football";
  let input = "";
  let out: string | null = null;
  let concurrency = 2;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--provider") {
      const value = argv[++index];
      if (value !== "api-football" && value !== "sportmonks") {
        throw new Error("--provider must be api-football or sportmonks.");
      }
      provider = value;
      continue;
    }
    if (arg === "--input") {
      input = argv[++index] ?? "";
      continue;
    }
    if (arg === "--out") {
      out = argv[++index] ?? null;
      continue;
    }
    if (arg === "--concurrency") {
      concurrency = Number(argv[++index] ?? "2");
      continue;
    }
  }

  if (!input) {
    throw new Error(
      "Usage: npm run spike:provider -- --provider <api-football|sportmonks> --input <fixtures.json> [--out report.json] [--concurrency 2]",
    );
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("--concurrency must be an integer between 1 and 8.");
  }

  return { provider, input, out, concurrency };
}

function validateFixtures(value: unknown): ProviderSpikeFixtureInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Input must be a non-empty JSON array.");
  }

  return value.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw new Error(`Fixture at index ${index} must be an object.`);
    }

    const fixture = row as Partial<ProviderSpikeFixtureInput>;
    if (
      !Number.isInteger(fixture.gameNumber) ||
      typeof fixture.homeTeam !== "string" ||
      typeof fixture.awayTeam !== "string" ||
      typeof fixture.kickoffAt !== "string" ||
      Number.isNaN(Date.parse(fixture.kickoffAt))
    ) {
      throw new Error(
        `Fixture at index ${index} requires gameNumber, homeTeam, awayTeam and ISO kickoffAt.`,
      );
    }

    return fixture as ProviderSpikeFixtureInput;
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      result[index] = await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => consume()),
  );

  return result;
}

function buildReport(
  provider: ProviderName,
  fixtures: ProviderFixtureCoverage[],
): ProviderSpikeReport {
  const observedOdds = fixtures.filter((item) => item.completeBookmakers > 0);
  const bookmakerAverage =
    observedOdds.length === 0
      ? 0
      : observedOdds.reduce(
          (sum, item) => sum + item.completeBookmakers,
          0,
        ) / observedOdds.length;

  return {
    provider,
    generatedAt: new Date().toISOString(),
    fixtures,
    summary: {
      requestedFixtures: fixtures.length,
      resolvedFixtures: fixtures.filter((item) => item.resolvedFixture).length,
      fixturesWithLineupCoverage: fixtures.filter(
        (item) => item.capabilities.lineups === true,
      ).length,
      fixturesWithObservedLineups: fixtures.filter(
        (item) => item.lineupEntries > 0,
      ).length,
      fixturesWithInjuryCoverage: fixtures.filter(
        (item) => item.capabilities.injuries === true,
      ).length,
      fixturesWithObservedInjuries: fixtures.filter(
        (item) => item.injuryEntries > 0,
      ).length,
      fixturesWithOddsCoverage: fixtures.filter(
        (item) => item.capabilities.odds === true,
      ).length,
      fixturesWithObservedOdds: observedOdds.length,
      averageCompleteBookmakersWhenAvailable:
        Math.round(bookmakerAverage * 100) / 100,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readFile(args.input, "utf8");
  const fixtures = validateFixtures(JSON.parse(raw) as unknown);

  const client =
    args.provider === "api-football"
      ? new ApiFootballClient(
          process.env.API_FOOTBALL_API_KEY ??
            (() => {
              throw new Error(
                "API_FOOTBALL_API_KEY is missing. Add it to your local environment; never commit it.",
              );
            })(),
        )
      : new SportmonksClient(
          process.env.SPORTMONKS_API_TOKEN ??
            (() => {
              throw new Error(
                "SPORTMONKS_API_TOKEN is missing. Add it to your local environment; never commit it.",
              );
            })(),
        );

  const coverage = await mapWithConcurrency(
    fixtures,
    args.concurrency,
    async (fixture) => {
      process.stderr.write(
        `Probing game ${fixture.gameNumber}: ${fixture.homeTeam} vs ${fixture.awayTeam}\n`,
      );
      return client.probeFixture(fixture);
    },
  );

  const report = buildReport(args.provider, coverage);
  const serialized = JSON.stringify(report, null, 2) + "\n";

  if (args.out) {
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, serialized, "utf8");
    process.stderr.write(`Wrote ${args.out}\n`);
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
