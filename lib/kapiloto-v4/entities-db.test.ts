import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEntityAlias } from "./aliases";
import { resolveAliasCandidates } from "./entities";
import { createLedgerDatabase, setClock } from "./test-support/ledger-fixtures";

const P1 = "63000000-0000-4000-8000-000000000001";
const P2 = "63000000-0000-4000-8000-000000000002";
const P3 = "63000000-0000-4000-8000-000000000003";
const TEAM = "61000000-0000-4000-8000-000000000001";
const COACH = "62000000-0000-4000-8000-000000000001";

test("provider player mappings reject duplicate provider ids and silent collapses", async () => {
  const db = await createLedgerDatabase();
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Yossi Cohen A'), ($2, 'Yossi Cohen B')", [P1, P2]);
  await db.query(
    "insert into public.provider_player_mappings (provider, provider_player_id, player_id, mapping_status) values ('sportmonks', '101', $1, 'confirmed')",
    [P1],
  );
  // The same provider id cannot point at a second canonical player.
  await assert.rejects(
    db.query("insert into public.provider_player_mappings (provider, provider_player_id, player_id) values ('sportmonks', '101', $1)", [P2]),
    /duplicate key/,
  );
  // A second provider id cannot silently collapse into the same canonical player.
  await assert.rejects(
    db.query("insert into public.provider_player_mappings (provider, provider_player_id, player_id) values ('sportmonks', '102', $1)", [P1]),
    /duplicate key/,
  );
  // Another provider may map the same person under its own id.
  await db.query("insert into public.provider_player_mappings (provider, provider_player_id, player_id) values ('api_football', '9001', $1)", [P1]);
  // Provider names must be canonical lowercase keys.
  await assert.rejects(
    db.query("insert into public.provider_player_mappings (provider, provider_player_id, player_id) values ('SportMonks', '1', $1)", [P2]),
    /check constraint/,
  );
  await db.close();
});

test("merges are explicit, one hop, and mappings cannot target a merged identity", async () => {
  const db = await createLedgerDatabase();
  await db.query(
    "insert into public.players (id, canonical_name) values ($1, 'Dup'), ($2, 'Keep'), ($3, 'Other')",
    [P1, P2, P3],
  );
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [P1, P2]);
  await assert.rejects(
    db.query("insert into public.provider_player_mappings (provider, provider_player_id, player_id) values ('sportmonks', '1', $1)", [P1]),
    /active canonical player/,
  );
  // Merging into a merged player, or merging a merge target, would create chains.
  await assert.rejects(
    db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [P3, P1]),
    /merged into an active player/,
  );
  await assert.rejects(
    db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [P2, P3]),
    /merge target/,
  );
  await assert.rejects(
    db.query("update public.players set identity_status = 'merged' where id = $1", [P3]),
    /check constraint/,
  );
  await db.close();
});

test("Hebrew and English aliases coexist without identity collision", async () => {
  const db = await createLedgerDatabase();
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Yossi Cohen (1999)'), ($2, 'Yossi Cohen (2003)')", [P1, P2]);
  for (const playerId of [P1, P2]) {
    await db.query(
      `insert into public.player_aliases (player_id, alias, language_code, alias_kind)
       values ($1, 'יוסי כהן', 'he', 'canonical'), ($1, 'Yossi Cohen', 'en', 'transliteration')`,
      [playerId],
    );
  }
  await db.query(
    "insert into public.player_aliases (player_id, alias, language_code, alias_kind, provider) values ($1, 'Y. Cohen', 'en', 'provider_spelling', 'sportmonks')",
    [P1],
  );
  // Pointed and geresh variants normalize to an existing alias of the same player.
  await assert.rejects(
    db.query("insert into public.player_aliases (player_id, alias, language_code, alias_kind) values ($1, 'יוֹסִי  כֹּהֵן', 'he', 'official')", [P1]),
    /duplicate key/,
  );
  await assert.rejects(
    db.query("insert into public.player_aliases (player_id, alias, alias_kind) values ($1, 'YC', 'provider_spelling')", [P1]),
    /check constraint/,
  );

  const lookup = async (alias: string) =>
    (
      await db.query<{ player_id: string }>(
        "select player_id from public.player_aliases where normalized_alias = $1",
        [normalizeEntityAlias(alias)],
      )
    ).rows.map((row) => row.player_id);
  assert.deepEqual(resolveAliasCandidates(await lookup("יוֹסִי כֹּהֵן")), { status: "ambiguous", candidateIds: [P1, P2] });
  assert.deepEqual(resolveAliasCandidates(await lookup("YOSSI  COHEN")), { status: "ambiguous", candidateIds: [P1, P2] });
  assert.deepEqual(resolveAliasCandidates(await lookup("y. cohen")), { status: "unique", entityId: P1 });

  // The database normalization and the TypeScript mirror agree.
  for (const sample of ["  שְׁטֵייפְמַן ", "ג׳ורג׳ בן־חיים", "O’Brien Jr.", "Mac\tAllister", "״הבלם״"]) {
    const row = await db.query<{ normalized: string }>("select private.normalize_entity_alias($1) as normalized", [sample]);
    assert.equal(row.rows[0].normalized, normalizeEntityAlias(sample), sample);
  }
  await db.close();
});

test("coaches and team-coach tenures enforce references, bounds and versioning", async () => {
  const db = await createLedgerDatabase();
  await db.query("insert into public.teams (id, canonical_name) values ($1, 'Test FC')", [TEAM]);
  await db.query("insert into public.coaches (id, canonical_name) values ($1, 'Test Coach')", [COACH]);
  await db.query("insert into public.coach_aliases (coach_id, alias, language_code, alias_kind) values ($1, 'מאמן בדיקה', 'he', 'canonical')", [COACH]);
  await db.query("insert into public.provider_coach_mappings (provider, provider_coach_id, coach_id, mapping_status) values ('sportmonks', '77', $1, 'confirmed')", [COACH]);

  const insertTenure = (overrides: Record<string, unknown> = {}) => {
    const row = {
      tenure_key: "90000000-0000-4000-8000-000000000001",
      team_id: TEAM,
      coach_id: COACH,
      starts_on_earliest: "2026-06-01",
      starts_on_latest: "2026-06-30",
      ends_on_earliest: null,
      ends_on_latest: null,
      source_kind: "official_club",
      provider: null,
      ingest_version: "tenure-test-v1",
      ...overrides,
    };
    return db.query(
      `insert into public.team_coach_tenures
         (tenure_key, team_id, coach_id, starts_on_earliest, starts_on_latest,
          ends_on_earliest, ends_on_latest, source_kind, provider, ingest_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning tenure_version, first_seen_at`,
      Object.values(row),
    );
  };

  await setClock(db, "2026-09-01T00:00:00Z");
  const first = await insertTenure();
  assert.equal((first.rows[0] as { tenure_version: number }).tenure_version, 1);
  await assert.rejects(insertTenure({ tenure_key: "90000000-0000-4000-8000-000000000002", team_id: "61000000-0000-4000-8000-000000000099" }), /foreign key/);
  await assert.rejects(insertTenure({ tenure_key: "90000000-0000-4000-8000-000000000003", coach_id: P1 }), /foreign key/);
  await assert.rejects(insertTenure({ tenure_key: "90000000-0000-4000-8000-000000000004", starts_on_latest: "2026-05-01" }), /check constraint/);
  await assert.rejects(insertTenure({ tenure_key: "90000000-0000-4000-8000-000000000005", ends_on_earliest: "2026-07-01" }), /check constraint/);
  await assert.rejects(insertTenure({ tenure_key: "90000000-0000-4000-8000-000000000006", source_kind: "provider" }), /check constraint/);

  await setClock(db, "2026-11-03T00:00:00Z");
  const second = await insertTenure({ ends_on_earliest: "2026-10-30", ends_on_latest: "2026-10-30" });
  assert.equal((second.rows[0] as { tenure_version: number }).tenure_version, 2);

  // A later version may not move the tenure to another coach.
  await db.query("insert into public.coaches (id, canonical_name) values ($1, 'Another Coach')", [P3]);
  await assert.rejects(insertTenure({ coach_id: P3 }), /cannot change its team or coach/);

  await assert.rejects(db.query("update public.team_coach_tenures set ends_on_earliest = null, ends_on_latest = null"), /immutable/);
  await assert.rejects(db.query("delete from public.team_coach_tenures"), /immutable/);
  await db.close();
});
