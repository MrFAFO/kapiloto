import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const V4_MIGRATIONS = [/_kapiloto_v4_entities_match_ledger\.sql$/, /_kapiloto_v4_knowledge_prediction_registry\.sql$/];
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
  // 1A then 1B, and nothing after them.
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
  // 1B adds no trigger, constraint or index to an existing (pre-V4) table.
  const knowledge = readFileSync(join(dir, v4[1]), "utf8").toLowerCase();
  for (const match of knowledge.matchAll(/\bon\s+public\.([a-z_]+)/g)) {
    assert.ok(V4_TABLES.has(match[1]), `1B attaches to existing table ${match[1]}`);
  }
});
