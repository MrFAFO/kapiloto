import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildProviderMatchObservationPayload } from "./provider-ingest";
import { createLedgerDatabase, setClock } from "./test-support/ledger-fixtures";
import {
  advisoryLockModes,
  createInspectableLedgerDatabase,
  heldRowLocks,
  withNestedPlans,
  type NestedPlan,
} from "./test-support/lock-inspection";
import {
  countRows,
  ingest,
  observationFrom,
  seedIngestIdentities,
  syntheticCapture,
  writeFootprint,
  type IngestSeed,
  type SyntheticCaptureOptions,
} from "./test-support/provider-ingest-fixtures";

/**
 * Identity mappings are V3 rows that V3 can upsert concurrently. These tests
 * show which row locks the ingest transaction HOLDS (heap tuple header bits),
 * the order in which every lock is taken (auto_explain plans of the nested
 * statements, in execution order), and that a mapping changed behind the
 * locks can never leave a ledger observation under a stale identity. PGlite
 * cannot run a second session, so the blocking itself is PostgreSQL's
 * row-lock conflict table (FOR SHARE vs FOR NO KEY UPDATE / FOR UPDATE).
 */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const LATER = "2026-10-30T10:00:00.000Z";
const INGEST = "select public.match_ledger_ingest_provider_fixture($1::jsonb) as r";

type Ids = { leagueId: string; homeTeamId: string; awayTeamId: string; providerFixtureId: string };
let counter = 0;

async function world(db: PGlite, options: { mapTeams?: boolean } = {}): Promise<{ seed: IngestSeed; ids: Ids; capture: (o?: Partial<SyntheticCaptureOptions>) => ReturnType<typeof syntheticCapture> }> {
  counter += 1;
  const ids = {
    leagueId: String(6100 + counter),
    homeTeamId: String(66_000 + counter * 2),
    awayTeamId: String(66_001 + counter * 2),
    providerFixtureId: String(16_000_000 + counter),
  };
  const seed = await seedIngestIdentities(db, { leagueId: ids.leagueId, homeTeamId: ids.homeTeamId, awayTeamId: ids.awayTeamId, mapTeams: options.mapTeams });
  const capture = (o: Partial<SyntheticCaptureOptions> = {}) =>
    syntheticCapture({ ...ids, playerIdBase: [7_000_000 + counter * 100, 8_000_000 + counter * 100], kickoffAt: KICKOFF, capturedAt: CAPTURED, ...o });
  return { seed, ids, capture };
}

const payloadOf = (capture: ReturnType<typeof syntheticCapture>, mint = true) =>
  JSON.stringify(buildProviderMatchObservationPayload(observationFrom(capture, { mint })));

async function canonicalFixture(db: PGlite, seed: IngestSeed, kickoffAt: string, swap = false): Promise<string> {
  const [home, away] = swap ? [seed.awayTeamId, seed.homeTeamId] : [seed.homeTeamId, seed.awayTeamId];
  return (
    await db.query<{ id: string }>("insert into public.fixtures (competition_id, home_team_id, away_team_id, kickoff_at) values ($1, $2, $3, $4) returning id", [
      seed.competitionId,
      home,
      away,
      kickoffAt,
    ])
  ).rows[0].id;
}

const mapFixture = (db: PGlite, fixtureId: string, providerFixtureId: string) =>
  db.query("insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id, mapping_confidence) values ($1, 'sportmonks', $2, 1)", [fixtureId, providerFixtureId]);

const competitionLocks = (db: PGlite, ids: Ids) => heldRowLocks(db, "provider_competition_mappings", "provider = 'sportmonks' and provider_competition_id = $1", [ids.leagueId]);
const teamLocks = (db: PGlite, ids: Ids) =>
  heldRowLocks(db, "provider_team_mappings", "provider = 'sportmonks' and provider_team_id = any($1::text[])", [[ids.homeTeamId, ids.awayTeamId]]);
const fixtureMappingLocks = (db: PGlite, providerFixtureId: string) =>
  heldRowLocks(db, "provider_fixture_mappings", "provider = 'sportmonks' and provider_fixture_id = $1", [providerFixtureId]);

test("competition and both team mapping rows are held FOR SHARE by the ingest transaction until commit", async () => {
  const db = await createInspectableLedgerDatabase();
  const w = await world(db);
  const bystander = await world(db);
  await setClock(db, SEEN);

  await db.exec("begin");
  const result = (await db.query<{ r: { status: string; fixture_resolution: string } }>(INGEST, [payloadOf(w.capture())])).rows[0].r;
  assert.deepEqual([result.status, result.fixture_resolution], ["recorded", "minted"]);
  assert.deepEqual(await competitionLocks(db, w.ids), ["for share"]);
  assert.deepEqual(await teamLocks(db, w.ids), ["for share", "for share"]);
  // Only the rows this call resolved are locked.
  assert.deepEqual(await competitionLocks(db, bystander.ids), ["none"]);
  assert.deepEqual(await teamLocks(db, bystander.ids), ["none", "none"]);
  await db.exec("commit");
  assert.deepEqual(await competitionLocks(db, w.ids), ["none"]);
  assert.deepEqual(await teamLocks(db, w.ids), ["none", "none"]);

  // Rows are locked before their status is checked: a quarantine holds them too.
  const unverified = await world(db, { mapTeams: false });
  await db.query("insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status, mapping_confidence) values ('sportmonks', $1, $2, 'confirmed', 1), ('sportmonks', $3, $4, 'unverified', 1)", [
    unverified.ids.homeTeamId,
    unverified.seed.homeTeamId,
    unverified.ids.awayTeamId,
    unverified.seed.awayTeamId,
  ]);
  await db.exec("begin");
  const quarantined = (await db.query<{ r: { reason_code: string } }>(INGEST, [payloadOf(unverified.capture())])).rows[0].r;
  assert.equal(quarantined.reason_code, "team_untrusted");
  assert.deepEqual(await teamLocks(db, unverified.ids), ["for share", "for share"]);
  await db.exec("rollback");
  await db.close();
});

test("an existing provider fixture mapping is locked FOR SHARE before it is validated and stays locked to commit", async () => {
  const db = await createInspectableLedgerDatabase();
  const w = await world(db);
  const fixtureId = await canonicalFixture(db, w.seed, KICKOFF);
  await mapFixture(db, fixtureId, w.ids.providerFixtureId);
  await setClock(db, SEEN);

  await db.exec("begin");
  const result = (await db.query<{ r: { status: string; fixture_resolution: string; fixture_id: string } }>(INGEST, [payloadOf(w.capture())])).rows[0].r;
  assert.deepEqual([result.status, result.fixture_resolution, result.fixture_id], ["recorded", "existing_mapping", fixtureId]);
  assert.deepEqual(await fixtureMappingLocks(db, w.ids.providerFixtureId), ["for share"]);
  await db.exec("commit");
  assert.deepEqual(await fixtureMappingLocks(db, w.ids.providerFixtureId), ["none"]);

  // A mapping that fails validation was locked before the check as well.
  const conflict = await world(db);
  await mapFixture(db, await canonicalFixture(db, conflict.seed, KICKOFF, true), conflict.ids.providerFixtureId);
  await db.exec("begin");
  assert.equal((await db.query<{ r: { reason_code: string } }>(INGEST, [payloadOf(conflict.capture())])).rows[0].r.reason_code, "fixture_mapping_conflict");
  assert.deepEqual(await fixtureMappingLocks(db, conflict.ids.providerFixtureId), ["for share"]);
  await db.exec("rollback");
  await db.close();
});

test("candidate mapping rows used as identity evidence are locked FOR SHARE under the team-pair lock", async () => {
  const db = await createInspectableLedgerDatabase();
  const w = await world(db);
  await mapFixture(db, await canonicalFixture(db, w.seed, KICKOFF), "88000001");
  const bystander = await world(db);
  await mapFixture(db, await canonicalFixture(db, bystander.seed, KICKOFF), "88000002");
  const pairKey = `kapiloto_canonical_fixture_pair:${[w.seed.homeTeamId, w.seed.awayTeamId].sort().join(":")}`;
  await setClock(db, SEEN);

  await db.exec("begin");
  const result = (await db.query<{ r: { reason_code: string } }>(INGEST, [payloadOf(w.capture())])).rows[0].r;
  assert.equal(result.reason_code, "fixture_provider_identity_conflict");
  assert.deepEqual(await advisoryLockModes(db, pairKey), ["ExclusiveLock"]);
  assert.deepEqual(await fixtureMappingLocks(db, "88000001"), ["for share"]);
  assert.deepEqual(await fixtureMappingLocks(db, "88000002"), ["none"]);
  await db.exec("rollback");
  await db.close();
});

/** Labels the lock-taking statements of one ingest call, in execution order (first occurrence). */
function lockSequence(plans: NestedPlan[]): string[] {
  const rules: Array<[string, (p: NestedPlan) => boolean]> = [
    ["provider_fixture_advisory", (p) => p.queryText.includes("'kapiloto_match_ledger_provider_fixture:' || v.provider")],
    ["competition_row_share", (p) => p.queryText.includes("from public.provider_competition_mappings m") && p.plan.startsWith("LockRows")],
    ["team_rows_share", (p) => p.queryText.includes("from public.provider_team_mappings m") && p.plan.startsWith("LockRows")],
    ["fixture_mapping_row_share", (p) => /from public\.provider_fixture_mappings m\s+where m\.provider = v\.provider and m\.provider_fixture_id/.test(p.queryText) && p.plan.startsWith("LockRows")],
    ["team_pair_advisory", (p) => p.queryText.includes("'kapiloto_canonical_fixture_pair:'")],
    ["candidate_mapping_rows_share", (p) => p.queryText.includes("join public.fixtures f on f.id = m.fixture_id") && p.plan.startsWith("LockRows")],
    ["ledger_fixture_advisory", (p) => p.queryText.includes("'kapiloto_match_ledger_fixture:'")],
    ["players_identity_advisory", (p) => p.queryText.includes("'kapiloto_identity:'")],
  ];
  const firsts = rules
    .map(([label, match]) => [label, plans.findIndex(match)] as const)
    .filter(([, index]) => index >= 0)
    .sort((a, b) => a[1] - b[1]);
  return firsts.map(([label]) => label);
}

test("lock order: every ingest takes its locks in the documented global order, on every path", async () => {
  const db = await createInspectableLedgerDatabase();
  await setClock(db, SEEN);

  const minted = await world(db);
  await db.exec("begin");
  const mintPlans = (await withNestedPlans(db, INGEST, [payloadOf(minted.capture())])).plans;
  await db.exec("rollback");
  assert.deepEqual(lockSequence(mintPlans), [
    "provider_fixture_advisory",
    "competition_row_share",
    "team_rows_share",
    "fixture_mapping_row_share",
    "team_pair_advisory",
    "candidate_mapping_rows_share",
    "ledger_fixture_advisory",
    "players_identity_advisory",
  ]);

  // With an existing mapping there is no team-pair lock and no candidate search.
  const mapped = await world(db);
  await mapFixture(db, await canonicalFixture(db, mapped.seed, KICKOFF), mapped.ids.providerFixtureId);
  await db.exec("begin");
  const mappedPlans = (await withNestedPlans(db, INGEST, [payloadOf(mapped.capture())])).plans;
  await db.exec("rollback");
  assert.deepEqual(lockSequence(mappedPlans), [
    "provider_fixture_advisory",
    "competition_row_share",
    "team_rows_share",
    "fixture_mapping_row_share",
    "ledger_fixture_advisory",
    "players_identity_advisory",
  ]);
  await db.close();
});

test("home=A/away=B and home=B/away=A lock the two team mapping rows in the same deterministic order", async () => {
  const db = await createInspectableLedgerDatabase();
  const w = await world(db);
  await setClock(db, SEEN);
  const teamPlan = async (capture: ReturnType<typeof syntheticCapture>) => {
    await db.exec("begin");
    const { plans } = await withNestedPlans(db, INGEST, [payloadOf(capture)]);
    await db.exec("rollback");
    const plan = plans.find((p) => p.queryText.includes("from public.provider_team_mappings m") && p.plan.startsWith("LockRows"));
    assert.ok(plan, "team mapping statement not found");
    return plan;
  };
  const forward = await teamPlan(w.capture());
  const reversed = await teamPlan(w.capture({ homeTeamId: w.ids.awayTeamId, awayTeamId: w.ids.homeTeamId, providerFixtureId: String(Number(w.ids.providerFixtureId) + 1) }));

  // One statement; rows are locked by LockRows ABOVE the Sort, i.e. in
  // provider_team_id COLLATE "C" order, whatever the home/away order of the IN list.
  assert.match(forward.plan, /^LockRows\n\s+->\s+Sort\n\s+Sort Key: (m\.)?provider_team_id COLLATE "C"/);
  assert.match(forward.queryText, /order by m\.provider_team_id collate "C"\s+for share$/);
  assert.equal(reversed.queryText, forward.queryText);
  // The IN list arrives in swapped home/away order (visible in the index
  // condition); everything above it, including the sort that orders the
  // lock acquisitions, is identical.
  const inList = (p: NestedPlan) => /ANY \('\{([^}]*)\}'/.exec(p.plan)?.[1];
  assert.equal(inList(forward), `${w.ids.homeTeamId},${w.ids.awayTeamId}`);
  assert.equal(inList(reversed), `${w.ids.awayTeamId},${w.ids.homeTeamId}`);
  const shape = (p: NestedPlan) => p.plan.replace(/ANY \('\{[^}]*\}'/, "ANY ('{in-list}'");
  assert.equal(shape(reversed), shape(forward));
  await db.close();
});

test("a repoint committed after the ingest is detected later; the earlier observation keeps the identity it was written under", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const first = await ingest(db, observationFrom(w.capture()), SEEN);
  assert.equal(first.fixture_resolution, "minted");
  const otherTeam = "00000099-0000-4000-8000-000000000001";
  await db.query("insert into public.teams (id, canonical_name) values ($1, 'Repointed Team')", [otherTeam]);
  // The statement shape the V3 Sportmonks store uses: upsert on (provider, provider_team_id).
  await db.query(
    `insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status) values ('sportmonks', $1, $2, 'confirmed')
     on conflict (provider, provider_team_id) do update set team_id = excluded.team_id`,
    [w.ids.homeTeamId, otherTeam],
  );
  const before = await writeFootprint(db);
  const corrected = await ingest(db, observationFrom(w.capture({ score90: [3, 1] })), LATER);
  assert.deepEqual([corrected.status, corrected.reason_code], ["quarantined", "fixture_mapping_conflict"]);
  assert.deepEqual(await writeFootprint(db), before);
  const teams = await db.query<{ side: string; team_id: string }>("select side, team_id from public.match_ledger_team_records where observation_id = $1 order by side", [first.observation_id]);
  assert.deepEqual(teams.rows.map((r) => [r.side, r.team_id]), [["away", w.seed.awayTeamId], ["home", w.seed.homeTeamId]]);

  const c = await world(db);
  await ingest(db, observationFrom(c.capture()), SEEN);
  const otherCompetition = await seedIngestIdentities(db, { mapCompetition: false, mapTeams: false });
  await db.query(
    `insert into public.provider_competition_mappings (provider, provider_competition_id, competition_id) values ('sportmonks', $1, $2)
     on conflict (provider, provider_competition_id) do update set competition_id = excluded.competition_id`,
    [c.ids.leagueId, otherCompetition.competitionId],
  );
  assert.equal((await ingest(db, observationFrom(c.capture({ score90: [3, 1] })), LATER)).reason_code, "fixture_mapping_conflict");
  await db.close();
});

test("a mapping changed behind the row locks inside the call aborts it: no observation under a stale identity, full rollback", async () => {
  const db = await createLedgerDatabase();
  // Test-only simulation of a writer that ignores the row locks: it runs in
  // the ingest's own transaction, after resolution, as the ledger header is written.
  await db.exec(`
    create function public.test_bypass_mapping_write() returns trigger language plpgsql as $$
    begin
      execute current_setting('kapiloto.test_bypass_sql');
      return new;
    end $$;
    create trigger test_bypass_mapping_write before insert on public.match_ledger_observations
    for each row execute function public.test_bypass_mapping_write();
  `);
  const bypass = (sql: string) => db.query("select set_config('kapiloto.test_bypass_sql', $1, false)", [sql]);
  const otherTeam = "00000099-0000-4000-8000-000000000002";
  await db.query("insert into public.teams (id, canonical_name) values ($1, 'Bypass Team')", [otherTeam]);
  const otherCompetition = await seedIngestIdentities(db, { mapCompetition: false, mapTeams: false });

  const w = await world(db);
  const mappedFixture = await canonicalFixture(db, w.seed, KICKOFF);
  await mapFixture(db, mappedFixture, w.ids.providerFixtureId);
  const cases: Array<[string, string]> = [
    ["home team repointed", `update public.provider_team_mappings set team_id = '${otherTeam}' where provider = 'sportmonks' and provider_team_id = '${w.ids.homeTeamId}'`],
    ["away team demoted", `update public.provider_team_mappings set mapping_status = 'unverified' where provider = 'sportmonks' and provider_team_id = '${w.ids.awayTeamId}'`],
    // The re-check applies exactly the resolution trust rules, not a looser one.
    ["home team confidence lowered to 0.9", `update public.provider_team_mappings set mapping_confidence = 0.9 where provider = 'sportmonks' and provider_team_id = '${w.ids.homeTeamId}'`],
    ["competition demoted to confirmed", `update public.provider_competition_mappings set mapping_status = 'confirmed' where provider = 'sportmonks' and provider_competition_id = '${w.ids.leagueId}'`],
    ["fixture mapping confidence lowered to 0.5", `update public.provider_fixture_mappings set mapping_confidence = 0.5 where provider = 'sportmonks' and provider_fixture_id = '${w.ids.providerFixtureId}'`],
    ["competition repointed", `update public.provider_competition_mappings set competition_id = '${otherCompetition.competitionId}' where provider = 'sportmonks' and provider_competition_id = '${w.ids.leagueId}'`],
    ["fixture mapping repointed", `update public.provider_fixture_mappings set provider_fixture_id = 'repointed' where provider = 'sportmonks' and provider_fixture_id = '${w.ids.providerFixtureId}'`],
    ["fixture mapping deleted", `delete from public.provider_fixture_mappings where provider = 'sportmonks' and provider_fixture_id = '${w.ids.providerFixtureId}'`],
  ];
  for (const [label, sql] of cases) {
    await bypass(sql);
    const before = await writeFootprint(db);
    await assert.rejects(ingest(db, observationFrom(w.capture()), SEEN), /provider identity mappings changed during ingest/, label);
    // Everything rolled back, including the bypassing write itself.
    assert.deepEqual(await writeFootprint(db), before, label);
    assert.equal(await countRows(db, "provider_team_mappings", "provider_team_id = $1 and team_id = $2 and mapping_status = 'confirmed'", [w.ids.homeTeamId, w.seed.homeTeamId]), 1, label);
    assert.equal(await countRows(db, "provider_fixture_mappings", "provider_fixture_id = $1 and fixture_id = $2", [w.ids.providerFixtureId, mappedFixture]), 1, label);
  }

  // A minted fixture is checked the same way (its new mapping must survive the call).
  const fresh = await world(db);
  await bypass(`update public.provider_team_mappings set team_id = '${otherTeam}' where provider = 'sportmonks' and provider_team_id = '${fresh.ids.awayTeamId}'`);
  const before = await writeFootprint(db);
  await assert.rejects(ingest(db, observationFrom(fresh.capture()), SEEN), /provider identity mappings changed during ingest/);
  assert.deepEqual(await writeFootprint(db), before);

  await bypass("select 1");
  assert.equal((await ingest(db, observationFrom(w.capture()), SEEN)).status, "recorded");
  assert.equal((await ingest(db, observationFrom(fresh.capture()), SEEN)).fixture_resolution, "minted");
  await db.close();
});
