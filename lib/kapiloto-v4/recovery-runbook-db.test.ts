import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildMatchLedgerWithdrawalPayload } from "./match-ledger";
import {
  attestTeam,
  attestedWorld,
  createScopedRun,
  ingestV2,
  operatorSql,
  revokeTeam,
} from "./test-support/attestation-fixtures";
import {
  createLedgerDatabase,
  recordObservation,
} from "./test-support/ledger-fixtures";
import { writeFootprint } from "./test-support/provider-ingest-fixtures";

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const M2C_BODY = "docs/operations/sql/kapiloto-v4-m2c-revoke-body.sql";

test("the pre-reviewed M2C body is revoke-only and pauses a simulated M2B grant without data mutation", async () => {
  const body = readFileSync(M2C_BODY, "utf8");
  const sql = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  assert.equal(
    sql,
    "revoke execute on function public.match_ledger_ingest_provider_fixture_v2(jsonb) from service_role;",
  );
  assert.doesNotMatch(sql, /\b(grant|insert|update|delete|truncate|alter|drop|create)\b/);

  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true });
  const before = await writeFootprint(db);

  // Simulate M2B: only the V2 ingest RPC is granted.
  await db.exec(
    "grant execute on function public.match_ledger_ingest_provider_fixture_v2(jsonb) to service_role",
  );
  assert.equal(
    (await db.query<{ enabled: boolean }>(
      "select has_function_privilege('service_role', 'public.match_ledger_ingest_provider_fixture_v2(jsonb)', 'execute') as enabled",
    )).rows[0].enabled,
    true,
  );

  // M2C: the pre-reviewed body immediately removes that capability.
  await db.exec(body);
  const privileges = (await db.query<{ v1: boolean; v2: boolean; anon: boolean; authenticated: boolean }>(
    `select
       has_function_privilege('service_role', 'public.match_ledger_ingest_provider_fixture(jsonb)', 'execute') as v1,
       has_function_privilege('service_role', 'public.match_ledger_ingest_provider_fixture_v2(jsonb)', 'execute') as v2,
       has_function_privilege('anon', 'public.match_ledger_ingest_provider_fixture_v2(jsonb)', 'execute') as anon,
       has_function_privilege('authenticated', 'public.match_ledger_ingest_provider_fixture_v2(jsonb)', 'execute') as authenticated`,
  )).rows[0];

  assert.deepEqual(privileges, { v1: false, v2: false, anon: false, authenticated: false });
  assert.deepEqual(await writeFootprint(db), before);
  await db.close();
});

test("synthetic recovery: revoke -> impact -> withdraw -> repair mapping -> re-attest -> attach -> idempotent re-ingest", async () => {
  const db = await createLedgerDatabase();
  const w = await attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED });

  // The first ingest is internally consistent but represents the provider home
  // ref as the wrong canonical team. It mints the wrong canonical fixture.
  const wrong = await ingestV2(db, w.observation(), SEEN);
  assert.deepEqual([wrong.status, wrong.fixture_resolution], ["recorded", "minted"]);
  assert.ok(wrong.fixture_id && wrong.observation_id);
  const wrongFixture = wrong.fixture_id;
  const oldGeneration = wrong.attestation_generations?.team_home;
  assert.ok(oldGeneration);

  // Operator review discovers the real canonical home team and an already
  // reviewed canonical fixture for the same provider match.
  const correctHome = (await db.query<{ id: string }>(
    "insert into public.teams (canonical_name) values ('Synthetic Correct Home') returning id",
  )).rows[0].id;
  const correctFixture = (await db.query<{ id: string }>(
    `insert into public.fixtures
       (competition_id, home_team_id, away_team_id, kickoff_at, status)
     values ($1, $2, $3, $4, 'finished')
     returning id`,
    [w.seed.competitionId, correctHome, w.seed.awayTeamId, KICKOFF],
  )).rows[0].id;

  // Containment first: revoke immediately makes the old generation unusable
  // to attestation-aware V2 reads.
  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, "synthetic wrong canonical team");
  const impact = (await db.query<{
    impact_kind: string;
    observation_id: string | null;
    fixture_id: string | null;
    provider_fixture_id: string | null;
    generation_state: string | null;
  }>(
    "select impact_kind, observation_id, fixture_id, provider_fixture_id, generation_state from public.provider_identity_revocation_impact('sportmonks', 'team', $1)",
    [w.ids.homeTeamId],
  )).rows;
  assert.ok(impact.some((row) => row.impact_kind === "observation_under_generation" && row.observation_id === wrong.observation_id && row.generation_state === "revoked"));
  assert.ok(impact.some((row) => row.impact_kind === "fixture_mapping" && row.fixture_id === wrongFixture));
  assert.ok(impact.some((row) => row.impact_kind === "fixture_mint" && row.fixture_id === wrongFixture));

  const oldVisibleAfterRevoke = (await db.query<{ id: string | null }>(
    "select public.match_ledger_observation_as_of_v2($1, 'sportmonks', $2) as id",
    [wrongFixture, "2026-10-30T10:00:00.000Z"],
  )).rows[0].id;
  assert.equal(oldVisibleAfterRevoke, null);

  // Historical correction is append-only: write a withdrawal, never delete the
  // bad observation.
  const withdrawal = await recordObservation(
    db,
    buildMatchLedgerWithdrawalPayload({
      fixtureId: wrongFixture,
      provider: "sportmonks",
      providerFixtureId: w.providerFixtureId,
      captureMode: "manual_import",
      ingestVersion: "kapiloto-v4-recovery-rehearsal-v1",
      retrievedAt: "2026-10-30T10:05:00.000Z",
      withdrawalReason: "synthetic recovery: wrong canonical home team",
    }),
    "2026-10-30T10:05:00.000Z",
  );
  assert.equal(withdrawal.status, "recorded");
  const latestWrong = (await db.query<{ observation_kind: string; observation_version: number }>(
    `select observation_kind, observation_version
       from public.match_ledger_observations
      where fixture_id = $1 and provider = 'sportmonks'
      order by observation_version desc
      limit 1`,
    [wrongFixture],
  )).rows[0];
  assert.deepEqual(latestWrong, { observation_kind: "withdrawal", observation_version: 2 });

  // Compare-and-set style pointer repair: remove only the exact old fixture
  // mapping. The immutable mint row remains as audit evidence.
  await operatorSql(
    db,
    `delete from public.provider_fixture_mappings
      where provider = 'sportmonks'
        and provider_fixture_id = $1
        and fixture_id = $2`,
    [w.providerFixtureId, wrongFixture],
  );
  assert.equal(
    Number((await db.query<{ n: number }>(
      "select count(*)::int as n from public.provider_fixture_mappings where provider = 'sportmonks' and provider_fixture_id = $1",
      [w.providerFixtureId],
    )).rows[0].n),
    0,
  );
  assert.equal(
    Number((await db.query<{ n: number }>(
      "select count(*)::int as n from public.match_ledger_fixture_mints where provider = 'sportmonks' and provider_fixture_id = $1 and fixture_id = $2",
      [w.providerFixtureId, wrongFixture],
    )).rows[0].n),
    1,
  );

  // Identity correction is a separate operator transaction after revoke.
  await operatorSql(
    db,
    `update public.provider_team_mappings
        set team_id = $2, mapping_status = 'manual_override', mapping_confidence = 1
      where provider = 'sportmonks'
        and provider_team_id = $1
        and team_id = $3`,
    [w.ids.homeTeamId, correctHome, w.seed.homeTeamId],
  );
  const mapping = (await db.query<{ team_id: string; mapping_status: string }>(
    "select team_id, mapping_status from public.provider_team_mappings where provider = 'sportmonks' and provider_team_id = $1",
    [w.ids.homeTeamId],
  )).rows[0];
  assert.deepEqual(mapping, { team_id: correctHome, mapping_status: "manual_override" });

  // Re-attestation opens a new generation. It never rehabilitates the old
  // observation sealed under the revoked generation.
  await attestTeam(db, w.ids.homeTeamId, correctHome);
  const newGeneration = (await db.query<{ generation: string }>(
    "select attestation_generation_id as generation from private.provider_team_identity_attestations where provider = 'sportmonks' and provider_team_id = $1",
    [w.ids.homeTeamId],
  )).rows[0].generation;
  assert.notEqual(newGeneration, oldGeneration);

  // Recovery always uses a fresh immutable allow-listed run.
  const recoveryRun = await createScopedRun(db, [w.providerFixtureId]);
  assert.notEqual(recoveryRun, w.runId);
  const recovered = await ingestV2(
    db,
    w.observation({}, { runId: recoveryRun }),
    "2026-10-30T11:00:00.000Z",
  );
  assert.deepEqual(
    [recovered.status, recovered.fixture_resolution, recovered.fixture_id, recovered.observation_version],
    ["recorded", "attached", correctFixture, 1],
  );
  assert.ok(recovered.observation_id);

  const currentMapping = (await db.query<{ fixture_id: string }>(
    "select fixture_id from public.provider_fixture_mappings where provider = 'sportmonks' and provider_fixture_id = $1",
    [w.providerFixtureId],
  )).rows[0].fixture_id;
  assert.equal(currentMapping, correctFixture);

  const oldVisible = (await db.query<{ id: string | null }>(
    "select public.match_ledger_observation_as_of_v2($1, 'sportmonks', $2) as id",
    [wrongFixture, "2026-10-30T12:00:00.000Z"],
  )).rows[0].id;
  const correctedVisible = (await db.query<{ id: string | null }>(
    "select public.match_ledger_observation_as_of_v2($1, 'sportmonks', $2) as id",
    [correctFixture, "2026-10-30T12:00:00.000Z"],
  )).rows[0].id;
  assert.equal(oldVisible, null);
  assert.equal(correctedVisible, recovered.observation_id);

  // Historical drift on the withdrawn chain may remain visible for audit, but
  // there must be no conflict on a CURRENT observation.
  const currentRefConflicts = Number((await db.query<{ n: number }>(
    "select count(*)::int as n from public.match_ledger_provider_ref_conflicts_v2('sportmonks') where is_current_version",
  )).rows[0].n);
  assert.equal(currentRefConflicts, 0);
  const blockingIdentityConflicts = Number((await db.query<{ n: number }>(
    "select count(*)::int as n from public.provider_identity_attestation_conflicts('sportmonks') where severity = 'blocking'",
  )).rows[0].n);
  assert.equal(blockingIdentityConflicts, 0);

  // Exact corrected content is idempotent under the same reviewed run.
  const again = await ingestV2(
    db,
    w.observation({}, { runId: recoveryRun }),
    "2026-10-30T12:30:00.000Z",
  );
  assert.deepEqual([again.status, again.observation_id], ["unchanged", recovered.observation_id]);

  await db.close();
});
