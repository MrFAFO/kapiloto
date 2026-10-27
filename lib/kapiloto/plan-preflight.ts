import type { PreparedKapilotoRun } from "./research-request-service";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type KapilotoPlanPreflightSummary = {
  fixtureCount: number;
  taskCount: number;
  researchCount: number;
  carriedForwardCount: number;
  researchUnavailableCount: number;
  marketPriorCount: number;
  ratingPriorCount: number;
  leagueBasePriorCount: number;
  fixtures: Array<{
    gameNumber: number;
    fixtureId: string;
    roundGameId: string;
    mode: string;
    priorType: string | null;
  }>;
};

export function summarizeKapilotoPreparedRun(
  prepared: PreparedKapilotoRun,
): KapilotoPlanPreflightSummary {
  const fixtures = prepared.fixtureSet.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`Prepared fixture ${index + 1} is not an object.`);
    }

    const mode = typeof raw.mode === "string" ? raw.mode : "";
    const gameNumber = Number(raw.gameNumber);
    const fixtureId =
      typeof raw.fixtureId === "string" ? raw.fixtureId : "";
    const roundGameId =
      typeof raw.roundGameId === "string" ? raw.roundGameId : "";

    if (
      !Number.isInteger(gameNumber) ||
      gameNumber < 1 ||
      gameNumber > 16 ||
      !fixtureId ||
      !roundGameId ||
      !["research", "carried_forward", "research_unavailable"].includes(mode)
    ) {
      throw new Error(
        `Prepared fixture ${index + 1} has invalid identity/disposition.`,
      );
    }

    let priorType: string | null = null;
    if (mode === "research") {
      const card = raw.card;
      if (!isRecord(card) || !isRecord(card.structured)) {
        throw new Error(
          `Prepared research fixture ${gameNumber} is missing structured card data.`,
        );
      }
      const prior = card.structured.prior;
      if (!isRecord(prior) || typeof prior.type !== "string") {
        throw new Error(
          `Prepared research fixture ${gameNumber} is missing prior metadata.`,
        );
      }
      priorType = prior.type;
    }

    return {
      gameNumber,
      fixtureId,
      roundGameId,
      mode,
      priorType,
    };
  });

  return {
    fixtureCount: fixtures.length,
    taskCount: prepared.taskGameIds.length,
    researchCount: fixtures.filter((item) => item.mode === "research").length,
    carriedForwardCount: fixtures.filter(
      (item) => item.mode === "carried_forward",
    ).length,
    researchUnavailableCount: fixtures.filter(
      (item) => item.mode === "research_unavailable",
    ).length,
    marketPriorCount: fixtures.filter((item) => item.priorType === "market")
      .length,
    ratingPriorCount: fixtures.filter((item) => item.priorType === "rating")
      .length,
    leagueBasePriorCount: fixtures.filter(
      (item) => item.priorType === "league_base",
    ).length,
    fixtures,
  };
}
