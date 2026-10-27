import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

/**
 * Loads the REAL Supabase migration chain into PGlite with minimal stand-ins
 * for platform-only pieces (auth, pg_cron, pg_net, vault, pgcrypto digest).
 * Production data-seed migrations that reference rows absent from an empty
 * database are skipped; they do not define schema or functions.
 */
const PLATFORM_STUBS = `
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb,
  raw_app_meta_data jsonb,
  created_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claim.role', true), 'anon')
$$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create schema cron;
create table cron.job (jobid bigint, jobname text);
create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
create function cron.unschedule(text) returns boolean language sql as $$ select true $$;
create function cron.unschedule(bigint) returns boolean language sql as $$ select true $$;
create schema net;
create function net.http_post(
  url text,
  headers jsonb default '{}',
  body jsonb default '{}',
  timeout_milliseconds int default 1000
) returns bigint language sql as $$ select 1::bigint $$;
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  secret text,
  description text
);
create view vault.decrypted_secrets as
  select id, name, secret as decrypted_secret, description from vault.secrets;
create function vault.create_secret(
  secret text,
  name text default null,
  description text default null
) returns uuid language sql as $$
  insert into vault.secrets(secret, name, description)
  values (secret, name, description) returning id
$$;
create function vault.update_secret(
  id uuid,
  secret text default null,
  name text default null,
  description text default null
) returns void language sql as $$
  update vault.secrets s set secret = coalesce(update_secret.secret, s.secret)
  where s.id = update_secret.id
$$;
create schema extensions;
create function extensions.digest(data text, alg text) returns bytea
  language sql immutable as $$ select sha256(convert_to(data, 'UTF8')) $$;
create function extensions.digest(data bytea, alg text) returns bytea
  language sql immutable as $$ select sha256(data) $$;
create function extensions.gen_random_bytes(n int) returns bytea
  language sql as $$ select decode(md5(random()::text), 'hex') $$;
`;

const DATA_SEED_MIGRATIONS = /team_aliases_round|verified_mappings_round/;

export async function createMigratedDatabase(
  options: { exclude?: RegExp } = {},
): Promise<PGlite> {
  const dir = join(process.cwd(), "supabase", "migrations");
  const db = new PGlite();
  await db.exec(PLATFORM_STUBS);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    if (DATA_SEED_MIGRATIONS.test(file)) continue;
    if (options.exclude?.test(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8").replace(
      /create extension if not exists [a-z_]+[^;]*;/gi,
      "",
    );
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(
        `Migration ${file} failed in PGlite: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return db;
}

export type SeededRound = {
  roundId: string;
  runId: string;
  fixtures: Array<{ gameNumber: number; roundGameId: string; fixtureId: string }>;
};

function uuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** One open round with 16 canonical fixtures and a running research run. */
export async function seedRoundWithRunningRun(
  db: PGlite,
  options: { researchProtocolVersion: string },
): Promise<SeededRound> {
  const roundId = uuid("10000000", 1);
  const runId = uuid("20000000", 1);
  const userId = uuid("30000000", 1);
  const requestId = uuid("40000000", 1);
  const competitionId = uuid("50000000", 1);

  await db.query("insert into auth.users (id, email) values ($1, 'v3@example.com')", [userId]);
  await db.query(
    "insert into public.competitions (id, canonical_name) values ($1, 'League')",
    [competitionId],
  );
  await db.query(
    `insert into public.rounds (id, external_round_number, lock_at, source, status)
     values ($1, '990001', '2026-10-30T16:00:00Z', 'test', 'open')`,
    [roundId],
  );

  const fixtures: SeededRound["fixtures"] = [];
  for (let game = 1; game <= 16; game += 1) {
    const home = uuid("60000000", game * 2);
    const away = uuid("60000000", game * 2 + 1);
    const fixtureId = uuid("70000000", game);
    const roundGameId = uuid("80000000", game);
    await db.query(
      "insert into public.teams (id, canonical_name) values ($1, $2), ($3, $4)",
      [home, `Home ${game}`, away, `Away ${game}`],
    );
    await db.query(
      `insert into public.fixtures (id, competition_id, home_team_id, away_team_id, kickoff_at)
       values ($1, $2, $3, $4, '2026-10-30T18:00:00Z')`,
      [fixtureId, competitionId, home, away],
    );
    await db.query(
      `insert into public.round_games
         (id, round_id, game_number, home_team_id, away_team_id,
          competition_name_snapshot, kickoff_at, fixture_id, competition_id)
       values ($1, $2, $3, $4, $5, 'League', '2026-10-30T18:00:00Z', $6, $7)`,
      [roundGameId, roundId, game, home, away, fixtureId, competitionId],
    );
    fixtures.push({ gameNumber: game, roundGameId, fixtureId });
  }

  await db.query(
    `insert into public.kapiloto_research_requests
       (id, user_id, round_id, intent, idempotency_key, request_sha256)
     values ($1, $2, $3, 'consult', 'idem-v3', 'sha-v3')`,
    [requestId, userId, roundId],
  );

  const fixtureSet = fixtures.map((fixture) => ({
    gameNumber: fixture.gameNumber,
    roundGameId: fixture.roundGameId,
    fixtureId: fixture.fixtureId,
    mode: "research_unavailable",
  }));
  await db.query(
    `insert into public.kapiloto_research_runs
       (id, round_id, seq_no, trigger_type, origin_request_id, model_key,
        research_protocol_version, derivation_version, source_policy_version,
        recency_policy_version, reliability_formula_version, blend_policy_version,
        prompt_template_sha256, research_cutoff_at, fixture_set, fixture_set_sha256,
        status, budget_slot)
     values ($1, $2, 1, 'fixture_consult', $3, 'gpt-6.1-sol', $4,
        'kapiloto-derivation-v4', 'kapiloto-source-v5', 'kapiloto-recency-v2',
        'kapiloto-reliability-shadow-v5', 'kapiloto-blend-shadow-v2',
        'prompt-sha', '2026-10-29T12:00:00Z', $5::jsonb, 'fixture-set-sha',
        'running', 1)`,
    [runId, roundId, requestId, options.researchProtocolVersion, JSON.stringify(fixtureSet)],
  );
  await db.query(
    `insert into public.kapiloto_round_research_state (round_id, active_run_id)
     values ($1, $2)
     on conflict (round_id) do update set active_run_id = excluded.active_run_id`,
    [roundId, runId],
  );

  return { roundId, runId, fixtures };
}
