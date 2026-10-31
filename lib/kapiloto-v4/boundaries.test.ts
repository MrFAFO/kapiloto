import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const V4_MIGRATIONS = [
  /_kapiloto_v4_entities_match_ledger\.sql$/,
  /_kapiloto_v4_knowledge_prediction_registry\.sql$/,
  /_kapiloto_v4_roster_squad_state\.sql$/,
  /_kapiloto_v4_lineup_prediction_registry_v2\.sql$/,
  /_kapiloto_v4_squad_state_features_v2\.sql$/,
  /_kapiloto_v4_provider_ingest\.sql$/,
  /_kapiloto_v4_identity_mapping_guard\.sql$/,
  /_kapiloto_v4_identity_attestations\.sql$/,
];
const IDENTITY_ATTESTATIONS_MIGRATION = /_kapiloto_v4_identity_attestations\.sql$/;
// The one deliberate exception to "no trigger on a V3 table" (D-057): a
// row-level BEFORE UPDATE guard on the three V3 identity mapping tables.
const IDENTITY_GUARD_MIGRATION = /_kapiloto_v4_identity_mapping_guard\.sql$/;
const IDENTITY_GUARDED_TABLES = ["provider_competition_mappings", "provider_fixture_mappings", "provider_team_mappings"];
const V4_TABLES = new Set([
  "players",
  "player_aliases",
  "provider_player_mappings",
  "coaches",
  "coach_aliases",
  "provider_coach_mappings",
  "team_coach_tenures",
  "match_ledger_observations",
  "match_ledger_team_records",
  "match_ledger_players",
  "match_ledger_substitutions",
  "match_ledger_events",
  "match_ledger_stat_definitions",
  "match_ledger_team_stats",
  "match_ledger_game_state_segments",
  "knowledge_documents",
  "knowledge_document_versions",
  "knowledge_claims",
  "knowledge_claim_observations",
  "knowledge_claim_relations",
  "knowledge_claim_resolutions",
  "knowledge_resolution_evidence",
  "prediction_snapshots",
  "prediction_ledger_inputs",
  "prediction_document_inputs",
  "prediction_claim_inputs",
  "prediction_claim_observation_inputs",
  "prediction_reference_inputs",
  "prediction_identity_bindings",
  "team_player_memberships",
  "prediction_membership_inputs",
  "prediction_tenure_inputs",
  "prediction_squad_state_context",
  "provider_ingest_runs",
  "provider_ingest_items",
  "match_ledger_observation_provider_refs",
  "match_ledger_observation_family_fetches",
  "match_ledger_fixture_mints",
  "match_ledger_observation_identity_attestations",
]);
// V4-owned tables in the unexposed private schema (D-058 attestation state).
const V4_PRIVATE_TABLES = new Set([
  "provider_team_identity_attestation_events",
  "provider_competition_identity_attestation_events",
  "provider_team_identity_attestations",
  "provider_competition_identity_attestations",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

test("V3 production code, the app and components do not import the V4 foundation", () => {
  const offenders = ["lib/kapiloto", "app", "components"]
    .flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .filter((file) => /kapiloto-v4/.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file));
  assert.deepEqual(offenders, []);
});

test("V4 runtime modules depend on nothing in V3 research", () => {
  const offenders = sourceFiles(join(ROOT, "lib", "kapiloto-v4"))
    .filter((file) => !/\.test\.ts$/.test(file) && !/test-support/.test(file))
    .filter((file) => /from\s+["'][^"']*(\.\.\/kapiloto\/|@\/lib\/kapiloto\/)/.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file));
  assert.deepEqual(offenders, []);
});

test("the V4 migrations are the latest, in order, and strictly additive", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  const v4 = V4_MIGRATIONS.map((pattern) => {
    const matches = files.filter((file) => pattern.test(file));
    assert.equal(matches.length, 1, String(pattern));
    return matches[0];
  });
  // 1A, 1B, 1C, 1D, 1E-A1, 1E-A2-A, the D-057 guard, Stage 1 M2A in order, and nothing after them.
  assert.deepEqual(files.slice(-v4.length), v4);
  for (const file of v4) {
    const sql = readFileSync(join(dir, file), "utf8").toLowerCase();

    assert.doesNotMatch(sql, /\bdrop\s+(table|column|function|index|trigger|policy|schema|view)\b/, file);
    assert.doesNotMatch(sql, /\bcreate\s+policy\b/, file);
    assert.doesNotMatch(sql, /\bsecurity\s+definer\b/, file);
    assert.doesNotMatch(sql, /\bgrant\s+(select|insert|update|delete|all)\b[^;]*\bto\s+(anon|authenticated|public)\b/, file);
    for (const match of sql.matchAll(/\balter\s+table\s+public\.([a-z_]+)/g)) {
      assert.ok(V4_TABLES.has(match[1]), `${file} alters existing table ${match[1]}`);
    }
    for (const match of sql.matchAll(/\bcreate\s+table\s+public\.([a-z_]+)/g)) {
      assert.ok(V4_TABLES.has(match[1]), `${file} creates unexpected table ${match[1]}`);
    }
    for (const match of sql.matchAll(/\b(?:create|alter)\s+table\s+private\.([a-z_]+)/g)) {
      assert.ok(V4_PRIVATE_TABLES.has(match[1]), `${file} creates or alters unexpected private table ${match[1]}`);
    }
  }
  // 1B onwards add no trigger, constraint or index to an existing (pre-V4)
  // table, except the D-057 guard checked below.
  for (const file of v4.slice(1)) {
    const sql = readFileSync(join(dir, file), "utf8").toLowerCase();
    const allowed = IDENTITY_GUARD_MIGRATION.test(file) ? new Set(IDENTITY_GUARDED_TABLES) : new Set<string>();
    for (const match of sql.matchAll(/\bon\s+public\.([a-z_]+)/g)) {
      assert.ok(V4_TABLES.has(match[1]) || allowed.has(match[1]), `${file} attaches to existing table ${match[1]}`);
    }
  }
});

test("the D-057 guard migration only adds BEFORE UPDATE row triggers to the V3 mapping tables and pauses ingest", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const file = readdirSync(dir).find((name) => IDENTITY_GUARD_MIGRATION.test(name))!;
  const sql = readFileSync(join(dir, file), "utf8").toLowerCase().replace(/\r\n/g, "\n");
  const code = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  const triggers = [...code.matchAll(
    /create trigger ([a-z_]+)\s+before update on public\.([a-z_]+)\s+for each row\s+when \(old\.provider = 'sportmonks' or old\.mapping_status = 'manual_override'\)\s+execute function private\.guard_v3_identity_mapping_update\(\);/g,
  )].map((match) => [match[2], match[1]]);
  assert.deepEqual(
    triggers.slice().sort(),
    IDENTITY_GUARDED_TABLES.map((table) => [table, `${table}_identity_guard`]),
  );
  assert.equal((code.match(/\bcreate trigger\b/g) ?? []).length, 3);
  assert.doesNotMatch(code, /\b(alter table|create (unique )?index|constraint|insert into|update public\.|delete from)\b/);
  assert.match(code, /revoke execute on function public\.match_ledger_ingest_provider_fixture\(jsonb\) from service_role;/);
  assert.doesNotMatch(code, /\bgrant\b/);
});

// 1D adds V2 alongside V1: it never redefines the V1 RPC or the V1 hashing.
test("the 1D migration does not redefine any V1 prediction registry function", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const file = readdirSync(dir).find((name) => /_kapiloto_v4_lineup_prediction_registry_v2\.sql$/.test(name))!;
  const sql = readFileSync(join(dir, file), "utf8").toLowerCase();
  for (const fn of ["public.prediction_record_snapshot", "private.prediction_canonical_inputs", "private.prediction_input_bundle_sha256", "private.prediction_output_sha256"]) {
    assert.ok(!sql.includes(`create or replace function ${fn}(`), fn);
  }
  assert.ok(sql.includes("create or replace function public.prediction_record_snapshot_v2("));
});

// Foundation 1A, 1B, 1C, 1D, 1E-A1, 1E-A2-A and the D-057 guard are applied;
// their migrations must never change (line endings normalized so CRLF
// checkouts hash the same).
test("the applied V4 migrations are byte-for-byte unchanged", () => {
  const applied: Record<string, string> = {
    "20261028010437_kapiloto_v4_entities_match_ledger.sql": "8e9ebcebe0e930c85f929a9906926f52c95c9d784edd3a70dc8d8e94b357b0a9",
    "20261028132857_kapiloto_v4_knowledge_prediction_registry.sql": "baf08e5b5616568bf1a929823413163f3cd3d57d2ee47c9337319e722853132e",
    "20261029074019_kapiloto_v4_roster_squad_state.sql": "48fcddd3fa9588afaf7a5a8f461b92fe7bf9d956c27a39a6a7b79a9e9ceb0199",
    "20261029085303_kapiloto_v4_lineup_prediction_registry_v2.sql": "0e9b51be73b69544864a1a2dd53b350d0942cb9ec883e638a941ffc0917e9297",
    "20261029211641_kapiloto_v4_squad_state_features_v2.sql": "421b3df180e9a745d44c184111838a423e771b12bee0e74b3a35419aee51ca6b",
    "20261030101247_kapiloto_v4_provider_ingest.sql": "5ab815c4c74f08b5505c8cc850f972fd7fd9847f032dcdd97f3e5afe64379cf8",
    "20261030211645_kapiloto_v4_identity_mapping_guard.sql": "6f2e1a4b5b7a091481eca9b6c435bda47952fd4b4bace46ae3dfe4446cd207b3",
  };
  for (const [file, sha256] of Object.entries(applied)) {
    const text = readFileSync(join(ROOT, "supabase", "migrations", file), "utf8").replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(text).digest("hex"), sha256, file);
  }
});

// 1E-A2-A resolves provider identities and then calls the 1A RPC; it never
// redefines 1A writes, reads or hashing, and touches no V3 table definition.
test("the provider-ingest migration does not redefine 1A functions or alter V3 tables", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const file = readdirSync(dir).find((name) => /_kapiloto_v4_provider_ingest\.sql$/.test(name))!;
  const sql = readFileSync(join(dir, file), "utf8").toLowerCase();
  for (const fn of [
    "public.match_ledger_record_observation",
    "private.match_ledger_record_withdrawal",
    "public.match_ledger_observation_as_of",
    "public.match_ledger_provider_team_matches_as_of",
    "public.match_ledger_provider_player_matches_as_of",
    "private.stamp_match_ledger_observation",
    "private.lock_match_ledger_fixture",
    "private.kapiloto_information_clock",
  ]) {
    assert.ok(!sql.includes(`create or replace function ${fn}(`), fn);
  }
  for (const v3 of ["fixtures", "teams", "competitions", "provider_team_mappings", "provider_competition_mappings", "provider_fixture_mappings"]) {
    assert.ok(!sql.includes(`alter table public.${v3} `), v3);
    assert.ok(!sql.includes(` on public.${v3}\n`) && !sql.includes(` on public.${v3} `), v3);
  }
  assert.ok(sql.includes("public.match_ledger_record_observation(v_ledger)"));
  // Canonical teams and competitions are never created by ingest.
  for (const table of ["teams", "competitions", "provider_team_mappings", "provider_competition_mappings"]) {
    assert.ok(!sql.includes(`insert into public.${table} `) && !sql.includes(`insert into public.${table}\n`), table);
  }
});

// The retrospective training read must never reach live prediction code.
test("only training code imports the retrospective team-stats loader", () => {
  const v4 = join(ROOT, "lib", "kapiloto-v4");
  const offenders = sourceFiles(v4)
    .filter((file) => !/\.test\.ts$/.test(file) && !/test-support/.test(file) && !relative(v4, file).startsWith("training"))
    .filter((file) => /from\s+["'][^"']*training\//.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file));
  assert.deepEqual(offenders, []);
  for (const name of ["squad-state.ts", "lineup-snapshot.ts", "lineup-model.ts", "prediction-registry.ts", "index.ts"]) {
    const text = readFileSync(join(v4, name), "utf8");
    assert.ok(!text.includes("training/") && !text.includes("ForTraining") && !text.includes("retrospective-training"), name);
  }
});

// Stage 1 M2A (D-058) adds versioned V2 contracts next to the V1 ones: it
// never redefines a V1/1A/A2-A function or the D-057 guard, never alters a V3
// table, never creates teams/competitions/team or competition mappings, and
// never grants V2 ingest (only the separate M2B migration may).
test("the M2A migration is additive: no V1 redefinition, no V3 table change, V2 ingest explicitly revoked from service_role and never granted", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const file = readdirSync(dir).find((name) => IDENTITY_ATTESTATIONS_MIGRATION.test(name))!;
  const sql = readFileSync(join(dir, file), "utf8").toLowerCase().replace(/\r\n/g, "\n");
  const code = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  for (const fn of [
    "public.match_ledger_ingest_provider_fixture",
    "public.match_ledger_record_observation",
    "public.match_ledger_team_match_stats_as_of",
    "public.match_ledger_team_match_stats_for_training",
    "public.match_ledger_retrospective_training_exclusions",
    "public.match_ledger_provider_ref_conflicts",
    "public.match_ledger_mapping_conflicts",
    "public.squad_state_inputs_as_of",
    "public.match_ledger_observation_as_of",
    "public.match_ledger_provider_team_matches_as_of",
    "public.match_ledger_provider_player_matches_as_of",
    "private.provider_mapping_trusted",
    "private.provider_competition_mapping_trusted",
    "private.match_ledger_team_match_stats",
    "private.match_ledger_effective_versions",
    "private.match_ledger_retrospective_exclusions",
    "private.guard_v3_identity_mapping_update",
    "private.seal_match_ledger_observation_annotation",
  ]) {
    assert.ok(!code.includes(`create or replace function ${fn}(`), fn);
  }
  for (const v3 of ["fixtures", "teams", "competitions", "provider_team_mappings", "provider_competition_mappings", "provider_fixture_mappings", "round_games"]) {
    assert.ok(!code.includes(`alter table public.${v3} `), v3);
    assert.ok(!new RegExp(`\\bon\\s+public\\.${v3}\\b`).test(code), v3);
  }
  for (const table of ["teams", "competitions", "provider_team_mappings", "provider_competition_mappings"]) {
    assert.ok(!new RegExp(`insert\\s+into\\s+public\\.${table}\\b`).test(code), table);
  }
  assert.doesNotMatch(code, /\bgrant\b[^;]*\bmatch_ledger_ingest_provider_fixture(_v2)?\(/);
  assert.match(code, /revoke all on function public\.match_ledger_ingest_provider_fixture_v2\(jsonb\) from public, anon, authenticated, service_role;/);
  assert.doesNotMatch(code, /\bdrop\s+trigger\b|\bdisable\s+trigger\b/);
});

// D-058 M2B gate: the 1A/1C Match Ledger reads are not attestation-aware, so
// no production path may activate them (or any V4 consumer) until
// attestation-aware successors exist. This guard keeps that true.
test("no production app/script/cron path calls the uncovered Match Ledger consumers or any V4 ingest/read RPC", () => {
  const consumers = /squad_state_inputs_as_of|match_ledger_observation_as_of|match_ledger_provider_(team|player)_matches_as_of|prediction_record_snapshot(_v2)?|match_ledger_ingest_provider_fixture(_v2)?|match_ledger_team_match_stats|provider_identity_(attest|revoke)|kapiloto-v4/;
  const productionFiles = ["app", "components", "scripts", "lib"]
    .flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .concat(readdirSync(join(ROOT, "scripts")).filter((name) => /\.(mjs|js)$/.test(name)).map((name) => join(ROOT, "scripts", name)))
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter((file) => !relative(ROOT, file).replace(/\\/g, "/").startsWith("lib/kapiloto-v4/"))
    .filter((file) => relative(ROOT, file).replace(/\\/g, "/") !== "lib/supabase/database.types.ts");
  const offenders = productionFiles.filter((file) => consumers.test(readFileSync(file, "utf8"))).map((file) => relative(ROOT, file));
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(readFileSync(join(ROOT, "vercel.json"), "utf8"), consumers);
  // Database cron jobs (pg_cron) never schedule them either.
  const dir = join(ROOT, "supabase", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql"))) {
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(/cron\.schedule\(([\s\S]*?)\);/g)) {
      assert.doesNotMatch(match[1], consumers, file);
    }
  }
});
