import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { RUNBOOK_SQL } from "./test-support/recovery-runbook";

const ROOT = process.cwd();
// The reviewed real-PostgreSQL M2B/M2C rehearsal (PR-R): operator tool + harness.
const REHEARSAL_TOOL = "tools/kapiloto-v4-m2b-real-postgres-rehearsal.ts";
const REHEARSAL_HARNESS = "lib/kapiloto-v4/test-support/real-postgres-rehearsal.ts";
const IMPORT_FROM = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;
const V4_MIGRATIONS = [
  /_kapiloto_v4_entities_match_ledger\.sql$/,
  /_kapiloto_v4_knowledge_prediction_registry\.sql$/,
  /_kapiloto_v4_roster_squad_state\.sql$/,
  /_kapiloto_v4_lineup_prediction_registry_v2\.sql$/,
  /_kapiloto_v4_squad_state_features_v2\.sql$/,
  /_kapiloto_v4_provider_ingest\.sql$/,
  /_kapiloto_v4_identity_mapping_guard\.sql$/,
  /_kapiloto_v4_identity_attestations\.sql$/,
  /_kapiloto_v4_attestation_aware_consumer_reads\.sql$/,
];
// Reviewed non-V4 migrations allowed after the V4 foundation (they touch no V4
// object): the D-064 pg_cron target guard.
const POST_V4_NON_V4_MIGRATIONS = [/_kapiloto_scheduler_target_guard_v1\.sql$/];
const IDENTITY_ATTESTATIONS_MIGRATION = /_kapiloto_v4_identity_attestations\.sql$/;
const ATTESTATION_AWARE_READS_MIGRATION = /_kapiloto_v4_attestation_aware_consumer_reads\.sql$/;
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
  // 1A, 1B, 1C, 1D, 1E-A1, 1E-A2-A, D-057, Stage 1 M2A and
  // the attestation-aware consumer reads in order, with nothing between or
  // after them except reviewed non-V4 migrations that touch no V4 object.
  const tail = files.slice(files.indexOf(v4[0]));
  const nonV4 = tail.filter((file) => POST_V4_NON_V4_MIGRATIONS.some((pattern) => pattern.test(file)));
  assert.deepEqual(tail.filter((file) => !nonV4.includes(file)), v4);
  for (const file of nonV4) {
    const sql = readFileSync(join(dir, file), "utf8").toLowerCase();
    assert.doesNotMatch(sql, /kapiloto_v4|match_ledger|provider_identity|prediction_record/, file);
    for (const table of [...V4_TABLES, ...V4_PRIVATE_TABLES]) {
      assert.doesNotMatch(sql, new RegExp(`\\b(public|private)\\.${table}\\b`), `${file} touches V4 table ${table}`);
    }
  }
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

// Foundation 1A, 1B, 1C, 1D, 1E-A1, 1E-A2-A, the D-057 guard and Stage 1 M2A
// are applied; their migrations must never change (line endings normalized so
// CRLF checkouts hash the same). M2A is pinned at its merged bytes (5327dc3).
test("the applied V4 migrations are byte-for-byte unchanged", () => {
  const applied: Record<string, string> = {
    "20261028010437_kapiloto_v4_entities_match_ledger.sql": "8e9ebcebe0e930c85f929a9906926f52c95c9d784edd3a70dc8d8e94b357b0a9",
    "20261028132857_kapiloto_v4_knowledge_prediction_registry.sql": "baf08e5b5616568bf1a929823413163f3cd3d57d2ee47c9337319e722853132e",
    "20261029074019_kapiloto_v4_roster_squad_state.sql": "48fcddd3fa9588afaf7a5a8f461b92fe7bf9d956c27a39a6a7b79a9e9ceb0199",
    "20261029085303_kapiloto_v4_lineup_prediction_registry_v2.sql": "0e9b51be73b69544864a1a2dd53b350d0942cb9ec883e638a941ffc0917e9297",
    "20261029211641_kapiloto_v4_squad_state_features_v2.sql": "421b3df180e9a745d44c184111838a423e771b12bee0e74b3a35419aee51ca6b",
    "20261030101247_kapiloto_v4_provider_ingest.sql": "5ab815c4c74f08b5505c8cc850f972fd7fd9847f032dcdd97f3e5afe64379cf8",
    "20261030211645_kapiloto_v4_identity_mapping_guard.sql": "6f2e1a4b5b7a091481eca9b6c435bda47952fd4b4bace46ae3dfe4446cd207b3",
    "20261031100000_kapiloto_v4_identity_attestations.sql": "073905d4ee69dae957e09cc9315bece980a7321fc77a8514384a886335b59759",
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

// The attestation-aware consumer reads (PR #43) add V2 reads next to the
// frozen V1 ones and bind the registry to the read a lineup forecast used. It
// redefines exactly the three V2 registry functions that canonicalize, record
// and verify that binding, adds one column, never touches provider ingest
// privileges (M2A owns them; only the M2B grant migration may change them),
// and de-authorizes the V1 consumer reads from service_role.
test("the attestation-aware read migration is additive, binds the registry read, and leaves ingest privileges alone", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const file = readdirSync(dir).find((name) => ATTESTATION_AWARE_READS_MIGRATION.test(name))!;
  const sql = readFileSync(join(dir, file), "utf8").toLowerCase().replace(/\r\n/g, "\n");
  const code = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

  const defined = [...code.matchAll(/create or replace function ([a-z_]+\.[a-z_0-9]+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(defined, [
    "private.check_prediction_input_bundle",
    "private.prediction_canonical_inputs_v2",
    "public.match_ledger_observation_as_of_v2",
    "public.match_ledger_provider_player_matches_as_of_v2",
    "public.match_ledger_provider_team_matches_as_of_v2",
    "public.prediction_record_snapshot_v2",
    "public.squad_state_inputs_as_of_v2",
  ]);
  // Outside function bodies: the only DDL is the read-version column (with a
  // default for frozen rows), and no data is written.
  const topLevel = code.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
  assert.deepEqual([...topLevel.matchAll(/alter table ([a-z_.]+)/g)].map((m) => m[1]), ["public.prediction_squad_state_context"]);
  assert.match(topLevel, /add column squad_state_read_version text not null\s+default 'kapiloto-squad-state-read-v1'/);
  assert.doesNotMatch(topLevel, /\b(insert into|update public\.|delete from|drop|truncate)\b/);
  assert.doesNotMatch(code, /\bsecurity definer\b/);
  // Ingest privileges: neither granted nor re-revoked here.
  assert.doesNotMatch(code, /\b(grant|revoke)\b[^;]*\bmatch_ledger_ingest_provider_fixture(_v2)?\(/);
  // The V2 reads go to service_role only; the V1 consumer reads lose it.
  assert.deepEqual([...code.matchAll(/grant ([^;]+);/g)].map((m) => m[1].replace(/\s+/g, " ")).sort(), [
    "execute on function public.match_ledger_observation_as_of_v2(uuid, text, timestamptz) to service_role",
    "execute on function public.match_ledger_provider_player_matches_as_of_v2(text, uuid, timestamptz, integer) to service_role",
    "execute on function public.match_ledger_provider_team_matches_as_of_v2(text, uuid, timestamptz, integer) to service_role",
    "execute on function public.squad_state_inputs_as_of_v2(uuid, uuid, timestamptz, integer) to service_role",
  ]);
  for (const v1 of [
    "public.match_ledger_observation_as_of(uuid, text, timestamptz)",
    "public.match_ledger_provider_team_matches_as_of(text, uuid, timestamptz, integer)",
    "public.match_ledger_provider_player_matches_as_of(text, uuid, timestamptz, integer)",
    "public.squad_state_inputs_as_of(uuid, uuid, timestamptz, integer)",
  ]) {
    assert.ok(code.includes(`revoke all on function ${v1} from service_role;`), v1);
  }
  // Every V2 read applies the trust gate; the squad read names itself.
  assert.equal([...code.matchAll(/private\.match_ledger_observation_attestation_issue\(/g)].length, 4);
  assert.match(code, /'read_version', 'kapiloto-squad-state-read-v2'/);
});

// D-058 M2B gate: attestation-aware V2 successors now exist, but no
// production app/script/cron path may activate V4 ingest/consumers before the
// separately reviewed M2B activation and tiny-ingest gate.
test("no production app/script/tool/edge-function/cron path calls V4 ingest/read consumers before M2B activation", () => {
  const consumers = /squad_state_inputs_as_of|match_ledger_observation_as_of|match_ledger_provider_(team|player)_matches_as_of|prediction_record_snapshot(_v2)?|match_ledger_ingest_provider_fixture(_v2)?|match_ledger_team_match_stats|provider_identity_(attest|revoke)|kapiloto-v4/;
  const reviewedNonProduction = new Set([
    // A2-B evidence capture only: imports the V4 read-only pilot runner but has
    // no Supabase client and cannot call an ingest/identity/read RPC.
    "tools/kapiloto-v4-sportmonks-pilot.ts",
    // Read-only Sportmonks season-roster capture: names a kapiloto-v4 artifact
    // directory and contract, imports only node built-ins (pinned below).
    "tools/kapiloto-v4-sportmonks-season-roster.mjs",
    // Operator-only real-PostgreSQL M2B/M2C rehearsal against a DISPOSABLE
    // database; pinned by the rehearsal-harness test below.
    REHEARSAL_TOOL,
  ]);
  const runtimeRoots = ["app", "components", "scripts", "lib", "tools", "supabase/functions"];
  const jsRuntimeFiles = ["scripts", "tools"].flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .filter((name) => /\.(mjs|js)$/.test(name))
      .map((name) => join(ROOT, dir, name)),
  );
  const productionFiles = runtimeRoots
    .flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .concat(jsRuntimeFiles)
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter((file) => !relative(ROOT, file).replace(/\\/g, "/").startsWith("lib/kapiloto-v4/"))
    .filter((file) => relative(ROOT, file).replace(/\\/g, "/") !== "lib/supabase/database.types.ts")
    .filter((file) => !reviewedNonProduction.has(relative(ROOT, file).replace(/\\/g, "/")));
  const offenders = productionFiles.filter((file) => consumers.test(readFileSync(file, "utf8"))).map((file) => relative(ROOT, file));
  assert.deepEqual(offenders, []);

  const reviewedPilot = readFileSync(join(ROOT, "tools", "kapiloto-v4-sportmonks-pilot.ts"), "utf8");
  assert.doesNotMatch(
    reviewedPilot,
    /match_ledger_ingest_provider_fixture|provider_identity_(attest|revoke)|squad_state_inputs_as_of|match_ledger_observation_as_of|prediction_record_snapshot/,
  );
  const roster = readFileSync(join(ROOT, "tools", "kapiloto-v4-sportmonks-season-roster.mjs"), "utf8");
  assert.deepEqual([...new Set([...roster.matchAll(IMPORT_FROM)].map((match) => match[1]))].sort(), ["node:crypto", "node:fs/promises", "node:path"]);
  assert.doesNotMatch(roster, /supabase|\.rpc\s*\(|postgres|service_role|match_ledger_|provider_identity_|squad_state_|prediction_record_|import\s*\(|require\s*\(/i);

  assert.doesNotMatch(readFileSync(join(ROOT, "vercel.json"), "utf8"), consumers);
  // Database cron jobs (pg_cron) never schedule them either.
  const dir = join(ROOT, "supabase", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql"))) {
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(/cron\.schedule\(([\s\S]*?)\);/g)) {
      assert.doesNotMatch(match[1], consumers, file);
    }
  }
});

// PR-R: the one tool allowed to call V2 / identity RPCs is the reviewed
// real-PostgreSQL rehearsal, and only against a DISPOSABLE database. It is
// operator-run (no workflow, no production import), uses the reviewed M2C
// operator SQL verbatim, and its only privilege change is the simulated M2B
// grant, which its own cleanup revokes with that M2C body.
test("the real-PostgreSQL M2B rehearsal is operator-only, disposable-only, and changes no privilege but the simulated M2B grant", () => {
  const posix = (file: string) => relative(ROOT, file).replace(/\\/g, "/");
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
  const imports = (text: string) => [...new Set([...text.matchAll(IMPORT_FROM)].map((match) => match[1]))].sort();
  // Comments dropped; a "//" right after ":" is a URL scheme, not a comment.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const tool = read(REHEARSAL_TOOL);
  const harness = read(REHEARSAL_HARNESS);

  // Exact import surface: the pg client lives in the tool only.
  assert.deepEqual(imports(tool), ["../lib/kapiloto-v4/test-support/real-postgres-rehearsal", "node:fs", "node:path", "pg"]);
  assert.deepEqual(imports(harness), ["../provider-ingest", "./attestation-fixtures", "./provider-ingest-fixtures", "./recovery-runbook", "node:crypto", "node:fs", "node:path"]);
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
  assert.equal(pkg.dependencies.pg, undefined, "pg is a dev-only dependency");
  assert.equal(pkg.devDependencies.pg, "8.23.1");
  assert.deepEqual(
    Object.entries(pkg.scripts).filter(([, command]) => /real-postgres-rehearsal|rehearsal:v4-m2b/.test(command)),
    [["rehearsal:v4-m2b-real-postgres", `tsx ${REHEARSAL_TOOL}`]],
  );

  // Nothing but the tool (and tests) imports the harness or pg; no workflow runs it.
  const sources = ["app", "components", "scripts", "lib", "tools", "supabase/functions"]
    .flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .concat(["scripts", "tools"].flatMap((dir) => readdirSync(join(ROOT, dir)).filter((name) => /\.(mjs|js)$/.test(name)).map((name) => join(ROOT, dir, name))))
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .map(posix);
  for (const file of sources.filter((name) => name !== REHEARSAL_TOOL && name !== REHEARSAL_HARNESS)) {
    const text = read(file);
    assert.doesNotMatch(text, /real-postgres-rehearsal/, file);
    assert.ok(!imports(text).includes("pg"), `${file} imports pg`);
  }
  const workflows = join(ROOT, ".github", "workflows");
  for (const name of readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file))) {
    assert.doesNotMatch(read(join(".github", "workflows", name)), /real-postgres-rehearsal|rehearsal:v4-m2b|KAPILOTO_REHEARSAL_/, name);
  }

  // The tool only turns the validated target into pg connections.
  const toolCode = code(tool);
  assert.equal((toolCode.match(/new pg\.Client\(/g) ?? []).length, 1);
  assert.doesNotMatch(toolCode, /connectionString|@supabase|createClient|\.rpc\s*\(|\bfetch\s*\(|child_process|SUPABASE_|service_role|\bgrant\b|\brevoke\b/i);

  // The harness: no Supabase/HTTP client, no DDL, no test clock, no operator override.
  const harnessCode = code(harness);
  assert.doesNotMatch(
    harnessCode,
    /@supabase|createClient|\.rpc\s*\(|\bfetch\s*\(|child_process|with\s+grant\s+option|alter\s+default\s+privileges|security\s+definer|\bcreate\s+(or\s+replace\s+)?(function|procedure|role|trigger|table|policy)|\balter\s+(role|function|table|schema|policy)|\bdrop\s+(table|function|role|schema|policy)|\btruncate\b|kapiloto\.test_clock|kapiloto\.identity_operator|cron\.schedule/i,
  );
  // Its only privilege statement is the simulated M2B grant (the reviewed grant-only M2B text).
  assert.deepEqual(
    [...harnessCode.matchAll(/\b(?:grant|revoke)\s+[a-z_, ]+\s+on\s+(?:function|table|schema|sequence|all)\b[^"`;]*/gi)].map((match) => match[0]),
    ["grant execute on function public.match_ledger_ingest_provider_fixture_v2(jsonb) to service_role"],
  );
  assert.match(harnessCode, /export const SIMULATED_M2B_GRANT = "grant execute on function public\.match_ledger_ingest_provider_fixture_v2\(jsonb\) to service_role";/);
  // M2C is the reviewed operator SQL, read from docs/operations/sql and never copied.
  assert.match(harnessCode, /read\(RUNBOOK_SQL\.m2cRevoke\)/);
  assert.match(harnessCode, /read\(RUNBOOK_SQL\.m2cVerify\)/);
  assert.doesNotMatch(harnessCode, /M2C verification PASSED: ingest RPC ownership|from public, anon, authenticated, service_role/);
  // Once anything was written, the run always ends with that M2C body and the double verification.
  assert.match(harnessCode, /\} finally \{\n\s+if \(ctx && writesStarted\) \{\n\s+await cleanup\(ctx, evidence\);/);
  assert.match(harnessCode, /await session\.execute\(ctx\.sql\.m2cRevoke\);\n\s+evidence\.cleanup\.m2c_body_executed = true;\n\s+const passed = await verifyDoublePass\(/);
});

// M2C and the recovery steps are reviewed operator SQL (docs/operations/sql),
// never migrations: a normal `db push` must not pause ingest or rewrite
// identity. Until the separately reviewed M2B grant (and a recorded M2C)
// exist, only these migrations may touch provider ingest privileges: the one
// grant ever made is A2-A's V1 grant, revoked again by D-057 and M2A, and V2
// is never granted.
test("provider ingest privileges change only in reviewed migrations, and the M2C/recovery SQL stays out of supabase/migrations", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const ingestPrivilege = /\b(grant|revoke)\b[^;]*\bmatch_ledger_ingest_provider_fixture(_v2)?\(jsonb\)[^;]*;/gi;
  const sqlCode = (name: string) => readFileSync(join(dir, name), "utf8").replace(/--[^\n]*/g, "");
  const touching = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => [...sqlCode(name).matchAll(ingestPrivilege)].length > 0)
    .map((name) => name.replace(/^\d+_/, ""));
  assert.deepEqual(touching, [
    "kapiloto_v4_provider_ingest.sql",
    "kapiloto_v4_identity_mapping_guard.sql",
    "kapiloto_v4_identity_attestations.sql",
  ]);
  const grants: string[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".sql"))) {
    const code = sqlCode(name);
    for (const [statement, verb] of code.matchAll(ingestPrivilege)) {
      if (verb.toLowerCase() === "grant") grants.push(`${name.replace(/^\d+_/, "")}: ${statement.replace(/\s+/g, " ")}`);
    }
    assert.doesNotMatch(code, /kapiloto_recovery\.|M2C verification/, name);
  }
  assert.deepEqual(grants, [
    "kapiloto_v4_provider_ingest.sql: grant execute on function public.match_ledger_ingest_provider_fixture(jsonb) to service_role;",
  ]);

  const operatorSql = join(ROOT, "docs", "operations", "sql");
  const strip = (sql: string) => sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  for (const file of Object.values(RUNBOOK_SQL)) {
    assert.ok(readdirSync(operatorSql).includes(file), file);
    assert.ok(!readdirSync(dir).includes(file), file);
    const code = strip(readFileSync(join(operatorSql, file), "utf8"));
    // The M2C body's exact text is pinned by m2c-pause-db.test.ts.
    if (file === RUNBOOK_SQL.m2cRevoke) continue;
    // Templates and reports are DML/reads in one DO block or query: no DDL
    // (so no function, let alone a SECURITY DEFINER one), no privilege change.
    // Messages in string literals are not statements.
    assert.doesNotMatch(code.replace(/'(?:[^']|'')*'/g, "''"), /\b(create|alter|drop|grant|revoke|truncate|comment\s+on)\b/i, file);
  }
});
