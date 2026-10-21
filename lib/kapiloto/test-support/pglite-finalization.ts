import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import type { EntailmentJudge } from "../entailment-verifier";
import type { KapilotoFixtureCard } from "../fixture-card";
import { KAPILOTO_RESEARCH_DIMENSIONS } from "../research-output";
import type { SolFixtureResearchOutput } from "../research-output";
import {
  FinalizationClaimLostError,
  type FencedPublicationResult,
  type FinalizableResearchRun,
  type FinalizationClaimResult,
  type FinalizationFailure,
  type FinalizationObservability,
  type KapilotoFinalizationLedger,
  type KapilotoRunFinalizationStore,
} from "../run-finalizer";
import type { MaterializedRound } from "../run-materialization";
import type { GroundingResult } from "../source-grounding";
import { parseFinalizationClaim } from "../supabase-finalization-ledger";

const MIGRATION = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20261021090000_kapiloto_finalization_lifecycle_v1.sql",
);

/**
 * Minimal stand-ins for the tables/RPCs the finalization lifecycle migration
 * depends on. The materialization stub keeps the guards that matter to
 * finalization (exactly 16, frozen identity, no partial re-publication,
 * completed-run replay); the production identity-guarded RPC is unchanged.
 */
const STUB_SCHEMA = `
create role anon;
create role authenticated;
create role service_role;
create schema private;

create table public.kapiloto_research_runs (
  id uuid primary key,
  round_id uuid not null,
  status text not null,
  fixture_set jsonb not null,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_class text,
  failure_detail text,
  round_synthesis jsonb
);

create table public.kapiloto_research_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  round_game_id text,
  task_key text not null,
  status text not null
);

create table public.kapiloto_round_research_state (
  round_id uuid primary key,
  active_run_id uuid,
  current_run_id uuid,
  version bigint not null default 0,
  updated_at timestamptz
);

create table public.stub_published_analyses (
  run_id uuid not null,
  fixture_id text not null,
  payload jsonb not null
);

create function public.kapiloto_complete_research_run(
  p_run_id uuid,
  p_round_synthesis jsonb default '{}'::jsonb
) returns jsonb language plpgsql as $$
declare v_run public.kapiloto_research_runs%rowtype;
begin
  select * into v_run from public.kapiloto_research_runs where id = p_run_id for update;
  if v_run.status = 'completed' then
    return jsonb_build_object(
      'run_id', p_run_id, 'round_id', v_run.round_id, 'status', 'completed',
      'analysis_count', 16,
      'published_fixture_count',
        (select count(*) from public.stub_published_analyses where run_id = p_run_id),
      'replayed', true
    );
  end if;
  raise exception 'Kapiloto run is not completable from status %', v_run.status;
end;
$$;

create function public.kapiloto_materialize_and_complete_run(
  p_run_id uuid,
  p_analyses jsonb,
  p_round_synthesis jsonb default '{}'::jsonb
) returns jsonb language plpgsql as $$
declare v_run public.kapiloto_research_runs%rowtype;
begin
  select * into v_run from public.kapiloto_research_runs where id = p_run_id for update;
  if v_run.status = 'completed' then
    return public.kapiloto_complete_research_run(p_run_id, p_round_synthesis);
  end if;
  if jsonb_array_length(p_analyses) <> 16 then
    raise exception 'Kapiloto materialization requires exactly 16 analysis payloads';
  end if;
  if exists (
    select f ->> 'fixtureId' from jsonb_array_elements(v_run.fixture_set) f
    except select a ->> 'fixture_id' from jsonb_array_elements(p_analyses) a
  ) or exists (
    select a ->> 'fixture_id' from jsonb_array_elements(p_analyses) a
    except select f ->> 'fixtureId' from jsonb_array_elements(v_run.fixture_set) f
  ) then
    raise exception 'Kapiloto analysis payload does not match frozen fixture_set';
  end if;
  if exists (select 1 from public.stub_published_analyses where run_id = p_run_id) then
    raise exception 'Kapiloto run already has partially materialized analyses';
  end if;
  insert into public.stub_published_analyses
  select p_run_id, a ->> 'fixture_id', a from jsonb_array_elements(p_analyses) a;
  update public.kapiloto_research_runs
  set status = 'completed', completed_at = now(), round_synthesis = p_round_synthesis
  where id = p_run_id;
  update public.kapiloto_round_research_state
  set active_run_id = null, current_run_id = p_run_id, version = version + 1
  where round_id = v_run.round_id and active_run_id = p_run_id;
  return jsonb_build_object(
    'run_id', p_run_id, 'round_id', v_run.round_id, 'status', 'completed',
    'analysis_count', 16, 'published_fixture_count', 16, 'replayed', false
  );
end;
$$;
`;

export const RUN_ID = "11111111-1111-4111-8111-111111111111";
export const ROUND_ID = "22222222-2222-4222-8222-222222222222";

export function card(gameNumber: number): KapilotoFixtureCard {
  const fixtureId = `fixture-${gameNumber}`;
  return {
    fixture_card_version: "kapiloto-fixture-card-v2",
    fixture_key: fixtureId,
    fixture_id: fixtureId,
    round_game_id: `game-${gameNumber}`,
    toto_number: gameNumber,
    settlement: "result_after_90_minutes_including_stoppage_time",
    orientation: { "1": `home-${gameNumber}`, "2": `away-${gameNumber}` },
    teams: {
      home: { id: `home-${gameNumber}`, names: ["Home"] },
      away: { id: `away-${gameNumber}`, names: ["Away"] },
    },
    competition: { id: "competition", name: "League", stage: null, leg: null, aggregate: null },
    kickoff_at: "2026-10-21T18:00:00.000Z",
    neutral_venue: false,
    research_cutoff_at: "2026-10-20T10:00:00.000Z",
    structured: {
      table_snapshot_id: null,
      recent_matches: [],
      squad_snapshot_id: null,
      coach: null,
      prior: {
        type: "market",
        snapshot_id: `market-${gameNumber}`,
        captured_at: "2026-10-20T09:55:00.000Z",
        p_home_bp: 4500,
        p_draw_bp: 3000,
        p_away_bp: 2500,
      },
    },
  };
}

function output(gameNumber: number): SolFixtureResearchOutput {
  return {
    protocol_version: "kapiloto-research-v1",
    fixture_key: `fixture-${gameNumber}`,
    home_team_id: `home-${gameNumber}`,
    away_team_id: `away-${gameNumber}`,
    outcome: "analyzed",
    evidence: [],
    availability: [],
    factors: [],
    dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "no_material_signal" as const,
    })),
    conflicts: [],
    p_sol: { home_bp: 4600, draw_bp: 3000, away_bp: 2400 },
    market_deviation: null,
    key_assumptions: ["Assumption that must not survive a downgrade."],
    main_risk: "Late news.",
    summary: "Grounded test summary.",
    watch_items: [],
    data_quality: { sparse_coverage: false, language_limited: false, notes: "" },
    suspicious_content_observed: [],
    model_self_confidence: "medium",
  };
}

function grounding(gameNumber: number): GroundingResult {
  const evidenceId = `e-${gameNumber}`;
  return {
    accepted: [
      {
        modelEvidenceId: evidenceId,
        canonicalUrl: `https://example.com/report-${gameNumber}`,
        domain: "example.com",
        claimType: "baseline_form",
        aboutTeam: "home",
        quote: "The home side has won four of its last five league matches.",
        claim: "The home side has strong recent league form.",
        sourceEventTime: null,
        publishedAt: "2026-10-20T08:00:00.000Z",
        retrievedAt: "2026-10-20T09:00:00.000Z",
        trustTier: 2,
        quoteVerified: true,
        entailment: "not_checked",
        syndicationClusterId: null,
        contentSha256: "abc123",
      },
    ],
    rejected: [],
    requiresEntailmentVerification: [evidenceId],
  };
}

export function finalizableRun(): FinalizableResearchRun {
  const fixtureSet = Array.from({ length: 16 }, (_, index) => {
    const gameNumber = index + 1;
    return {
      gameNumber,
      roundGameId: `game-${gameNumber}`,
      fixtureId: `fixture-${gameNumber}`,
      mode: "research" as const,
      taskKey: `fixture:fixture-${gameNumber}`,
      card: card(gameNumber),
    };
  });

  return {
    runId: RUN_ID,
    roundId: ROUND_ID,
    status: "running",
    researchCutoffAt: "2026-10-20T10:00:00.000Z",
    fixtureSet,
    attempts: fixtureSet.map((fixture) => ({
      roundGameId: fixture.roundGameId,
      fixtureId: fixture.fixtureId,
      validatedOutput: output(fixture.gameNumber),
      grounding: grounding(fixture.gameNumber),
    })),
    carriedSources: [],
  };
}

export class MemoryStore implements KapilotoRunFinalizationStore {
  loads = 0;
  constructor(readonly run: FinalizableResearchRun) {}
  async load() {
    this.loads += 1;
    return structuredClone(this.run);
  }
}

/** Judge returning `supported` except for listed verification ids. */
export function countingJudge(
  unsupported: string[] = [],
  delay?: () => Promise<void>,
): EntailmentJudge & { calls: number } {
  const judge = {
    calls: 0,
    async verify(items: Parameters<EntailmentJudge["verify"]>[0]) {
      judge.calls += 1;
      if (delay) await delay();
      return {
        verdicts: items.map((item) => ({
          verificationId: item.verificationId,
          verdict: unsupported.includes(item.verificationId)
            ? ("unsupported" as const)
            : ("supported" as const),
        })),
        provenance: {
          responseId: `entail-${judge.calls}`,
          model: "sol-model",
          usage: {
            inputTokens: 1_000,
            cachedInputTokens: 0,
            outputTokens: 200,
            reasoningTokens: 150,
            totalTokens: 1_200,
          },
        },
      };
    },
  };
  return judge;
}

let shared: Promise<PGlite> | null = null;

/**
 * One embedded Postgres per test process (many WASM instances can crash V8),
 * reset to a fresh 16-fixture run before every test.
 */
export async function createFinalizationDb(
  options: { activeAttempts?: number; succeededTasks?: number } = {},
): Promise<PGlite> {
  shared ??= (async () => {
    const instance = new PGlite();
    await instance.exec(STUB_SCHEMA);
    await instance.exec(readFileSync(MIGRATION, "utf8"));
    return instance;
  })();
  const db = await shared;

  await db.exec(`
    truncate public.kapiloto_run_finalization_attempts,
             public.kapiloto_research_attempts,
             public.kapiloto_round_research_state,
             public.stub_published_analyses;
    delete from public.kapiloto_research_runs;
  `);

  const fixtureSet = finalizableRun().fixtureSet.map((fixture) => ({
    gameNumber: fixture.gameNumber,
    roundGameId: fixture.roundGameId,
    fixtureId: fixture.fixtureId,
    mode: fixture.mode,
    taskKey: fixture.mode === "research" ? fixture.taskKey : null,
  }));

  await db.query(
    `insert into public.kapiloto_research_runs (id, round_id, status, fixture_set)
     values ($1, $2, 'running', $3::jsonb)`,
    [RUN_ID, ROUND_ID, JSON.stringify(fixtureSet)],
  );
  await db.query(
    `insert into public.kapiloto_round_research_state (round_id, active_run_id)
     values ($1, $2)`,
    [ROUND_ID, RUN_ID],
  );

  const succeeded = options.succeededTasks ?? 16;
  // Mirror production: the research RPC keys attempts by round game
  // ('fixture:<round_game_id>'), unlike fixture_set.taskKey.
  for (const fixture of fixtureSet.slice(0, succeeded)) {
    await db.query(
      `insert into public.kapiloto_research_attempts (run_id, round_game_id, task_key, status)
       values ($1, $2, $3, 'succeeded')`,
      [RUN_ID, fixture.roundGameId, `fixture:${fixture.roundGameId}`],
    );
  }
  for (let index = 0; index < (options.activeAttempts ?? 0); index += 1) {
    await db.query(
      `insert into public.kapiloto_research_attempts (run_id, task_key, status)
       values ($1, $2, 'queued')`,
      [RUN_ID, `fixture:retry-${index}`],
    );
  }

  return db;
}

async function rpc(db: PGlite, sql: string, params: unknown[]): Promise<unknown> {
  const result = await db.query<{ r: unknown }>(`select ${sql} as r`, params);
  return result.rows[0]?.r;
}

/** Ledger adapter that calls the real migration RPCs inside PGlite. */
export class PgliteFinalizationLedger implements KapilotoFinalizationLedger {
  publishCalls = 0;

  constructor(private readonly db: PGlite) {}

  async claim(runId: string, workerId: string, leaseSeconds: number): Promise<FinalizationClaimResult> {
    return parseFinalizationClaim(
      await rpc(this.db, "public.kapiloto_claim_run_finalization($1, $2, $3, 3)", [
        runId,
        workerId,
        leaseSeconds,
      ]),
    );
  }

  async heartbeat(
    attemptId: string,
    workerId: string,
    leaseSeconds: number,
    observability?: FinalizationObservability,
  ): Promise<boolean> {
    return (
      (await rpc(this.db, "public.kapiloto_heartbeat_run_finalization($1, $2, $3, $4::jsonb)", [
        attemptId,
        workerId,
        leaseSeconds,
        observability ? JSON.stringify(observability) : null,
      ])) === true
    );
  }

  async publish(
    attemptId: string,
    workerId: string,
    materialized: MaterializedRound,
    observability: FinalizationObservability,
  ): Promise<FencedPublicationResult> {
    this.publishCalls += 1;
    let row: Record<string, unknown>;
    try {
      row = (await rpc(
        this.db,
        "public.kapiloto_publish_run_finalization($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)",
        [
          attemptId,
          workerId,
          JSON.stringify(materialized.analyses),
          JSON.stringify(materialized.synthesis),
          JSON.stringify(observability),
        ],
      )) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/finalization claim lost/i.test(message)) {
        throw new FinalizationClaimLostError(message);
      }
      throw error;
    }

    return {
      runId: String(row.run_id),
      roundId: String(row.round_id),
      analysisCount: Number(row.analysis_count),
      publishedFixtureCount: Number(row.published_fixture_count),
      replayed: row.replayed === true,
      claimOutcome: row.claim_outcome === "already_completed" ? "already_completed" : "published",
    };
  }

  async fail(
    attemptId: string,
    workerId: string,
    failure: FinalizationFailure,
    observability: FinalizationObservability,
  ): Promise<{ outcome: "claim_lost" | "retry_scheduled" | "run_failed" }> {
    const row = (await rpc(
      this.db,
      "public.kapiloto_fail_run_finalization($1, $2, $3, $4, $5, $6, $7::jsonb, 3)",
      [
        attemptId,
        workerId,
        failure.retryable,
        failure.code,
        failure.detail,
        failure.retryDelaySeconds,
        JSON.stringify(observability),
      ],
    )) as { outcome: "claim_lost" | "retry_scheduled" | "run_failed" };
    return { outcome: row.outcome };
  }
}

export async function expireLeases(db: PGlite): Promise<void> {
  await db.query(
    `update public.kapiloto_run_finalization_attempts
     set lease_expires_at = now() - interval '1 second'
     where status = 'running'`,
  );
}

export async function clearBackoff(db: PGlite): Promise<void> {
  await db.query(
    `update public.kapiloto_run_finalization_attempts
     set next_available_at = now() - interval '1 second'
     where status = 'failed'`,
  );
}

export async function runRow(db: PGlite) {
  const run = await db.query<{ status: string; failure_class: string | null; failure_detail: string | null }>(
    "select status, failure_class, failure_detail from public.kapiloto_research_runs where id = $1",
    [RUN_ID],
  );
  const state = await db.query<{ active_run_id: string | null; current_run_id: string | null }>(
    "select active_run_id, current_run_id from public.kapiloto_round_research_state where round_id = $1",
    [ROUND_ID],
  );
  return { ...run.rows[0], ...state.rows[0] };
}

export async function finalizationAttempts(db: PGlite) {
  return (
    await db.query<{
      attempt_no: number;
      status: string;
      worker_id: string;
      failure_class: string | null;
      failure_code: string | null;
      retryable: boolean | null;
      checked_claims: number | null;
      unsupported_claims: number | null;
      entailment_response_ids: string[];
      entailment_model: string | null;
      total_tokens: number | null;
      claimed_at: string;
      started_at: string;
      finished_at: string | null;
    }>(
      `select attempt_no, status, worker_id, failure_class, failure_code, retryable,
              checked_claims, unsupported_claims, entailment_response_ids,
              entailment_model, total_tokens, claimed_at, started_at, finished_at
       from public.kapiloto_run_finalization_attempts
       where run_id = $1 order by attempt_no`,
      [RUN_ID],
    )
  ).rows;
}

export async function publishedAnalyses(db: PGlite) {
  return (
    await db.query<{ fixture_id: string; payload: Record<string, unknown> }>(
      "select fixture_id, payload from public.stub_published_analyses where run_id = $1 order by fixture_id",
      [RUN_ID],
    )
  ).rows;
}
