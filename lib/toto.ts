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

export function isHit(pick: Pick, outcome: Outcome): boolean {
  return pickToOutcomes(pick).includes(outcome);
}
