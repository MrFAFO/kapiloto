/**
 * Sampling status of fixtures used while Research v2 is still in development.
 * Formal predictive sampling stays off until Research v2 is explicitly
 * approved; live-development fixtures are never part of a formal sample, and
 * nothing is researched after kickoff.
 */

export const FORMAL_SAMPLING_ENABLED = false as const;

export type LiveDevFixture = { roundId: string; gameNumber: number; fixtureId: string; label: string };

/** Round 264201 fixtures still unplayed when Research v2 development started. */
export const ROUND_264201_LIVE_DEV_FIXTURES: readonly LiveDevFixture[] = [
  { roundId: "a2928290-46dc-4321-a89f-085b95001f5d", gameNumber: 1, fixtureId: "d9b088d3-b3d3-40e4-84da-a17b4cd3692a", label: "Maccabi Haifa – Hapoel Beer Sheva" },
  { roundId: "a2928290-46dc-4321-a89f-085b95001f5d", gameNumber: 7, fixtureId: "e0cddc44-6967-4b72-b9e9-95d62c6bbb40", label: "Hull – Brentford" },
  { roundId: "a2928290-46dc-4321-a89f-085b95001f5d", gameNumber: 8, fixtureId: "f9b08b39-7471-4a38-9973-7d2d702c67b6", label: "Crystal Palace – Newcastle" },
  { roundId: "a2928290-46dc-4321-a89f-085b95001f5d", gameNumber: 9, fixtureId: "d1be42bc-ef42-4488-b250-8bb7d5a1e2e9", label: "Sunderland – Leeds" },
  { roundId: "a2928290-46dc-4321-a89f-085b95001f5d", gameNumber: 12, fixtureId: "35097a2f-7cf8-4282-af3e-651229800099", label: "Celta Vigo – Betis" },
];

export type SamplingClassification =
  | { status: "live_dev"; formalSample: false }
  | { status: "excluded_started"; formalSample: false }
  | { status: "excluded_not_live_dev"; formalSample: false };

/**
 * Whether a fixture may be used for a live-development run now. A fixture
 * whose kickoff has passed (or whose status is no longer upcoming) is always
 * excluded; nothing is ever researched retrospectively.
 */
export function classifyLiveDevFixture(input: {
  fixtureId: string;
  kickoffAt: string;
  status: string;
  now: Date;
  safetyMarginMinutes?: number;
}): SamplingClassification {
  const margin = (input.safetyMarginMinutes ?? 15) * 60_000;
  const kickoffMs = Date.parse(input.kickoffAt);
  if (!Number.isFinite(kickoffMs) || input.status !== "upcoming" || input.now.getTime() >= kickoffMs - margin) {
    return { status: "excluded_started", formalSample: false };
  }
  if (!ROUND_264201_LIVE_DEV_FIXTURES.some((fixture) => fixture.fixtureId === input.fixtureId)) {
    return { status: "excluded_not_live_dev", formalSample: false };
  }
  return { status: "live_dev", formalSample: false };
}
