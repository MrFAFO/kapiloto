export type RunFinalizationReadiness = {
  ready: boolean;
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assessRunFinalizationReadiness(
  fixtureSet: unknown,
  attemptStatuses: string[],
): RunFinalizationReadiness {
  if (!Array.isArray(fixtureSet) || fixtureSet.length !== 16) {
    return { ready: false, reason: "invalid_fixture_set" };
  }

  let researchCount = 0;

  for (const item of fixtureSet) {
    if (!isRecord(item)) {
      return { ready: false, reason: "invalid_fixture_set" };
    }

    const mode = item.mode;
    if (
      mode !== "research" &&
      mode !== "carried_forward" &&
      mode !== "research_unavailable"
    ) {
      return { ready: false, reason: "invalid_fixture_disposition" };
    }

    if (mode === "research") researchCount += 1;
  }

  const active = attemptStatuses.filter(
    (status) => status === "queued" || status === "running",
  ).length;
  const succeeded = attemptStatuses.filter(
    (status) => status === "succeeded",
  ).length;

  if (active > 0) {
    return { ready: false, reason: `active_attempts:${active}` };
  }

  if (succeeded !== researchCount) {
    return {
      ready: false,
      reason: `succeeded_attempts:${succeeded}/${researchCount}`,
    };
  }

  return { ready: true, reason: "ready" };
}
