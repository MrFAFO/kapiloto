export type Outcome = "1" | "X" | "2";
export type Pick = Outcome | "1X" | "X2" | "12";

export const OUTCOMES: Outcome[] = ["1", "X", "2"];

export function pickToOutcomes(pick: Pick): Outcome[] {
  if (pick === "1X") return ["1", "X"];
  if (pick === "X2") return ["X", "2"];
  if (pick === "12") return ["1", "2"];
  return [pick];
}

export function outcomesToPick(outcomes: Outcome[]): Pick {
  const normalized = OUTCOMES.filter((outcome) => outcomes.includes(outcome));

  if (normalized.length === 1) return normalized[0];
  if (normalized.length !== 2) {
    throw new Error("A Toto pick must contain one or two outcomes.");
  }

  if (normalized.includes("1") && normalized.includes("X")) return "1X";
  if (normalized.includes("X") && normalized.includes("2")) return "X2";
  return "12";
}

/**
 * Applies a user tap on a 1/X/2 control. This is the only way a draft pick
 * changes; Kapiloto recommendations never call it.
 */
export function toggleOutcomeInPicks<K extends string | number>(
  picks: Record<K, Pick>,
  key: K,
  outcome: Outcome,
  maxDoubles: number,
): Record<K, Pick> {
  const currentOutcomes = pickToOutcomes(picks[key]);
  const isSelected = currentOutcomes.includes(outcome);

  let nextOutcomes: Outcome[];

  if (isSelected) {
    if (currentOutcomes.length === 1) return picks;
    nextOutcomes = currentOutcomes.filter((value) => value !== outcome);
  } else if (currentOutcomes.length === 2) {
    nextOutcomes = [outcome];
  } else {
    const doublesNow = (Object.values(picks) as Pick[]).filter(
      (pick) => pickToOutcomes(pick).length === 2,
    ).length;

    if (doublesNow >= maxDoubles) return picks;
    nextOutcomes = [...currentOutcomes, outcome];
  }

  return {
    ...picks,
    [key]: outcomesToPick(nextOutcomes),
  };
}

export function isHit(pick: Pick, outcome: Outcome): boolean {
  return pickToOutcomes(pick).includes(outcome);
}
