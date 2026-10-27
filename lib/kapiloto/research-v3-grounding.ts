import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";
import {
  AVAILABILITY_ITEM_RULE,
  factorRule,
  formationRule,
  freshnessFailure,
  isRealCalendarDate,
  matchupRule,
  normalizeFormationText,
  regimeRule,
  ROLE_RULE,
  starterRule,
  TACTICAL_FACT_RULE,
  V3_DIRECTIONAL_MATCHUP_RECENT_DAYS,
  V3_REGIME_MAX_AGE_DAYS,
  DAY_MS,
  type V3EvidenceRule,
} from "./research-v3-rules";
import type {
  GroundedEvidence,
  GroundingItemEntailmentRequest,
} from "./source-grounding";

export type V3ItemGrounding = {
  itemEntailmentRequests: GroundingItemEntailmentRequest[];
  itemEvidenceExclusions: Record<string, string[]>;
  policyFailures: string[];
};

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function label(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * Item-level grounding for research v3.
 *
 * Every v3 object is checked against the rule derived from its own kind
 * (allowed claim types, side, freshness) before a server-written entailment
 * request is created. An item whose cited evidence fails any check gets no
 * entailment request, so grounding policy removes it (fail closed).
 */
export function groundResearchV3Items(
  output: SolFixtureResearchOutput,
  card: KapilotoFixtureCard,
  acceptedById: Map<string, GroundedEvidence>,
): V3ItemGrounding {
  const requests: GroundingItemEntailmentRequest[] = [];
  const exclusions: Record<string, string[]> = {};
  const failures: string[] = [];
  const teamName = (side: "home" | "away") =>
    card.teams[side].names[0] ?? side;

  /** Evidence ids of `ids` that fail `rule` for this item. */
  const unusable = (
    ids: string[],
    rule: V3EvidenceRule,
    side: "home" | "away" | null,
  ): Array<{ id: string; reason: string }> =>
    ids.flatMap((id) => {
      const evidence = acceptedById.get(id);
      if (!evidence) return [{ id, reason: "not_grounded" }];
      if (!rule.allowedClaimTypes.includes(evidence.claimType)) {
        return [{ id, reason: `claim_type_incompatible:${evidence.claimType}` }];
      }
      if (
        side != null &&
        evidence.aboutTeam !== side &&
        evidence.aboutTeam !== "both"
      ) {
        return [{ id, reason: "about_team_incompatible" }];
      }
      const stale = freshnessFailure(evidence, rule.freshness, card);
      return stale ? [{ id, reason: stale }] : [];
    });

  /** Returns the grounded evidence when every cited row passes the rule. */
  const usableFor = (
    key: string,
    ids: string[],
    rule: V3EvidenceRule,
    side: "home" | "away" | null,
  ): GroundedEvidence[] | null => {
    if (ids.length === 0) {
      failures.push(`${key} has no evidence.`);
      return null;
    }
    const bad = unusable(ids, rule, side);
    if (bad.length > 0) {
      failures.push(
        `${key} failed item provenance: ${bad.map((item) => `${item.id}=${item.reason}`).join(", ")}.`,
      );
      return null;
    }
    return ids.map((id) => acceptedById.get(id)!);
  };

  const request = (verificationId: string, ids: string[], claim: string) => {
    requests.push({
      verificationId,
      evidenceIds: [...new Set(ids)].sort(),
      claim,
    });
  };

  for (const side of ["home", "away"] as const) {
    const lineup = output.expected_lineups?.[side];
    if (!lineup) continue;
    const enabled = card.lineup_research === "enabled";

    if (lineup.formation != null && enabled) {
      const key = `lineup:${side}:formation`;
      const supporting = usableFor(
        key,
        lineup.formation_evidence_ids,
        formationRule(side),
        side,
      );
      const formation = normalizeFormationText(lineup.formation);
      if (
        supporting &&
        supporting.every((item) =>
          normalizeFormationText(normalizedText(item.quote)).includes(formation),
        )
      ) {
        request(
          key,
          lineup.formation_evidence_ids,
          `${teamName(side)} is expected to use the ${lineup.formation} formation.`,
        );
      } else if (supporting) {
        failures.push(`${key} quote does not state the formation.`);
      }
    }

    lineup.starters.forEach((starter, index) => {
      if (!enabled) return;
      const key = `lineup:${side}:starter:${index}`;
      const supporting = usableFor(
        key,
        starter.evidence_ids,
        starterRule(side),
        side,
      );
      const name = normalizedText(starter.player_name);
      if (
        supporting &&
        supporting.every((item) => normalizedText(item.quote).includes(name))
      ) {
        request(
          key,
          starter.evidence_ids,
          `${starter.player_name} is expected to start for ${teamName(side)}.`,
        );
      } else if (supporting) {
        failures.push(`${key} quote does not name the player.`);
      }
    });
  }

  output.availability.forEach((item, index) => {
    const bad = unusable(item.evidence_ids, AVAILABILITY_ITEM_RULE, item.team);
    if (bad.length > 0) {
      exclusions[`availability:${index}`] = bad.map((entry) => entry.id);
      failures.push(
        `availability:${index} evidence failed item provenance: ${bad.map((entry) => `${entry.id}=${entry.reason}`).join(", ")}.`,
      );
    }

    const functions = item.functions ?? [];
    if (functions.length === 0) return;
    const supporting = usableFor(
      `availability:functions:${index}`,
      item.function_evidence_ids ?? [],
      ROLE_RULE,
      item.team,
    );
    if (!supporting) return;
    const name = normalizedText(item.player_name);
    if (!supporting.every((evidence) => normalizedText(evidence.quote).includes(name))) {
      failures.push(`availability:functions:${index} quote does not name the player.`);
      return;
    }
    for (const role of functions) {
      request(
        `availability:functions:${index}:${role}`,
        item.function_evidence_ids ?? [],
        `${item.player_name} functions as ${label(role)} for ${teamName(item.team)}.`,
      );
    }
  });

  for (const fact of output.tactical_facts ?? []) {
    const key = `tactical_fact:${fact.fact_id}`;
    if (usableFor(key, fact.evidence_ids, TACTICAL_FACT_RULE, fact.team)) {
      request(
        key,
        fact.evidence_ids,
        `${teamName(fact.team)}'s ${label(fact.phase)} ${label(fact.attribute)} is ${label(fact.value)}.`,
      );
    }
  }

  const cutoffMs = Date.parse(card.research_cutoff_at);
  for (const matchup of output.matchup_analysis ?? []) {
    const key = `matchup:${matchup.matchup_id}`;
    const facts = (output.tactical_facts ?? []).filter((fact) =>
      matchup.fact_ids.includes(fact.fact_id),
    );
    const ids = [
      ...new Set([
        ...matchup.evidence_ids,
        ...facts.flatMap((fact) => fact.evidence_ids),
      ]),
    ];
    const supporting = usableFor(key, ids, matchupRule(matchup.kind), null);
    if (!supporting) continue;

    if (matchup.favors !== "none") {
      const own = matchup.evidence_ids
        .map((id) => acceptedById.get(id))
        .filter((item): item is GroundedEvidence => item != null);
      const recent = own.some(
        (item) =>
          item.publishedAt != null &&
          cutoffMs - Date.parse(item.publishedAt) <=
            V3_DIRECTIONAL_MATCHUP_RECENT_DAYS * DAY_MS,
      );
      if (!recent) {
        failures.push(
          `${key} has no matchup evidence from the last ${V3_DIRECTIONAL_MATCHUP_RECENT_DAYS} days.`,
        );
        continue;
      }
    }

    const outcome =
      matchup.favors === "home"
        ? teamName("home")
        : matchup.favors === "away"
          ? teamName("away")
          : matchup.favors === "draw"
            ? "a draw"
            : "neither side";
    request(
      key,
      ids,
      `${matchup.description} This ${label(matchup.kind)} interaction between ${teamName("home")} and ${teamName("away")} favors ${outcome}.`,
    );
  }

  (output.regime_changes ?? []).forEach((regime, index) => {
    const key = `regime:${index}`;
    if (!isRealCalendarDate(regime.effective_date)) {
      failures.push(`${key} has an invalid effective date.`);
      return;
    }
    const effectiveMs = Date.parse(`${regime.effective_date}T00:00:00.000Z`);
    if (effectiveMs > cutoffMs || cutoffMs - effectiveMs > V3_REGIME_MAX_AGE_DAYS * DAY_MS) {
      failures.push(`${key} effective date is outside the regime window.`);
      return;
    }
    if (usableFor(key, regime.evidence_ids, regimeRule(regime.type), regime.team)) {
      request(
        key,
        regime.evidence_ids,
        regime.type === "coach_change"
          ? `${teamName(regime.team)} changed head coach on ${regime.effective_date}.`
          : `${teamName(regime.team)} changed its formation on ${regime.effective_date}.`,
      );
    }
  });

  output.factors.forEach((factor, index) => {
    const bad = unusable(
      factor.evidence_ids,
      factorRule(factor.dimension, card),
      null,
    );
    if (bad.length > 0) {
      exclusions[`factor:${index}`] = bad.map((entry) => entry.id);
      failures.push(
        `factor:${index}:${factor.dimension} evidence failed item provenance: ${bad.map((entry) => `${entry.id}=${entry.reason}`).join(", ")}.`,
      );
    }
  });

  return {
    itemEntailmentRequests: requests,
    itemEvidenceExclusions: exclusions,
    policyFailures: failures,
  };
}
