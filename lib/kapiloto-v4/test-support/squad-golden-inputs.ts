import { historySelectionPolicy, type SquadStateInputs } from "../squad-state";

/**
 * Fixed synthetic 1C raw inputs used by the squad-state goldens and the V1/V2
 * comparison tests. Never change these values: the V1 goldens were captured
 * from them on main 5cd6c86.
 */
export const GOLDEN_TEAM = "a0000000-0000-4000-8000-000000000001";
const OPPONENT = "b0000000-0000-4000-8000-000000000001";
const COACH = "d0000000-0000-4000-8000-000000000001";
export const P = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const row = (id: string, role: "starter" | "bench" | "unknown", minutes: number | null, appeared: boolean | null) => ({
  observed_player_id: id, canonical_player_id: id, lineup_role: role, appeared,
  position_code: role === "starter" ? ("MF" as const) : null, formation_position: null, is_captain: false,
  minutes_played: minutes, entered_minute: role === "starter" ? 0 : null, exited_minute: null,
});

/** Rich, fixed raw inputs: complete and partial lineups, two providers, memberships of every coverage, claims and a tenure. */
export const GOLDEN_INPUTS: SquadStateInputs = {
  contract_version: "kapiloto-squad-state-inputs-v1",
  fixture_id: "f0000000-0000-4000-8000-000000000099",
  team_id: GOLDEN_TEAM,
  opponent_team_id: OPPONENT,
  side: "home",
  kickoff_at: "2026-11-02T18:00:00+00:00",
  cutoff: "2026-10-30T12:00:00+00:00",
  target_date: "2026-11-02",
  target_date_policy: "kapiloto-target-date-utc-v1",
  history: [5, 12, 19, 25].flatMap((d) => {
    const day = String(d).padStart(2, "0");
    const players = [
      ...Array.from({ length: 10 }, (_, k) => row(P(k + 1), "starter", 90, true)),
      d >= 20 ? row(P(20), "starter", 90, true) : row(P(11), "starter", 90, true),
      row(P(12), "bench", d === 12 ? 25 : 0, d === 12),
      row(P(13), d === 19 ? "unknown" : "bench", null, null),
    ];
    const base = {
      observation_id: `obs-${day}-sm`, fixture_id: `fx-${day}`, provider: "sportmonks", observation_version: 1,
      first_seen_at: `2026-10-${day}T21:00:00+00:00`, kickoff_at: `2026-10-${day}T18:00:00+00:00`,
      side: "home" as const, opponent_team_id: OPPONENT, observed_coach_id: COACH, canonical_coach_id: COACH,
      lineup_status: (d === 19 ? "partial" : "complete") as "partial" | "complete", substitutions_status: "complete" as const,
      players, substitutions: [],
    };
    return d === 12 ? [base, { ...base, observation_id: "obs-12-af", provider: "api_football", lineup_status: "partial" as const }] : [base];
  }),
  memberships: [
    { id: P(1), from: "2026-07-01", to: null, cov: "certain" },
    { id: P(11), from: "2026-07-01", to: "2026-10-15", cov: "outside" },
    { id: P(20), from: "2026-10-18", to: null, cov: "certain" },
    { id: P(21), from: "2026-10-10", to: null, cov: "certain", latest: "2026-11-05" },
  ].map((m, i) => ({
    membership_id: `m-${i}`, membership_key: `k-${i}`, membership_version: 1, team_id: GOLDEN_TEAM,
    observed_player_id: m.id, canonical_player_id: m.id, squad_group: "first_team" as const, shirt_number: null,
    starts_on_earliest: m.from, starts_on_latest: m.latest ?? m.from, ends_on_earliest: m.to, ends_on_latest: m.to,
    coverage: (m.latest ? "possible" : m.cov) as "certain" | "possible" | "outside",
    source_kind: "official_club" as const, provider: null, provider_record_id: null, source_reference: null,
    document_version_id: null, first_seen_at: "2026-09-01T00:00:00+00:00",
  })),
  claims: [{
    claim_id: "claim-1", canonical_claim_id: "claim-1", member_claim_ids: ["claim-1"], claim_kind: "reported_expectation",
    claim_type: "player_availability", predicate: "availability_status", team_id: GOLDEN_TEAM, observed_player_id: P(3),
    canonical_player_id: P(3), object_value: { status: "doubtful" }, polarity: "affirmed",
    claim_first_seen_at: "2026-10-28T09:00:00+00:00", resolution_id: "res-1", resolution_claim_id: "claim-1",
    resolution_status: "verified", resolution_first_seen_at: "2026-10-29T09:00:00+00:00", quality_flags: [],
  }],
  tenures: [{
    tenure_id: "t-1", tenure_key: "tk-1", tenure_version: 1, observed_coach_id: COACH, canonical_coach_id: COACH,
    role: "head_coach", starts_on_earliest: "2026-07-01", starts_on_latest: "2026-07-01", ends_on_earliest: null,
    ends_on_latest: null, first_seen_at: "2026-07-01T00:00:00+00:00",
  }],
};
export const GOLDEN_POLICY = historySelectionPolicy(["sportmonks", "api_football"]);
