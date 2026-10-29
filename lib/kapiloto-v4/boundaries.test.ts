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
];
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
  // 1A, 1B, 1C, 1D, 1E-A1 in order, and nothing after them.
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
  }
  // 1B onwards add no trigger, constraint or index to an existing (pre-V4) table.
  for (const file of v4.slice(1)) {
    const sql = readFileSync(join(dir, file), "utf8").toLowerCase();
    for (const match of sql.matchAll(/\bon\s+public\.([a-z_]+)/g)) {
      assert.ok(V4_TABLES.has(match[1]), `${file} attaches to existing table ${match[1]}`);
    }
  }
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

// Foundation 1A, 1B, 1C and 1D are applied to production; their migrations
// must never change (line endings normalized so CRLF checkouts hash the same).
test("the applied V4 migrations are byte-for-byte unchanged", () => {
  const applied: Record<string, string> = {
    "20261028010437_kapiloto_v4_entities_match_ledger.sql": "8e9ebcebe0e930c85f929a9906926f52c95c9d784edd3a70dc8d8e94b357b0a9",
    "20261028132857_kapiloto_v4_knowledge_prediction_registry.sql": "baf08e5b5616568bf1a929823413163f3cd3d57d2ee47c9337319e722853132e",
    "20261029074019_kapiloto_v4_roster_squad_state.sql": "48fcddd3fa9588afaf7a5a8f461b92fe7bf9d956c27a39a6a7b79a9e9ceb0199",
    "20261029085303_kapiloto_v4_lineup_prediction_registry_v2.sql": "0e9b51be73b69544864a1a2dd53b350d0942cb9ec883e638a941ffc0917e9297",
  };
  for (const [file, sha256] of Object.entries(applied)) {
    const text = readFileSync(join(ROOT, "supabase", "migrations", file), "utf8").replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(text).digest("hex"), sha256, file);
  }
});
