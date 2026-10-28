import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const V4_MIGRATION = /_kapiloto_v4_entities_match_ledger\.sql$/;
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

test("the V4 migration is the latest and strictly additive", () => {
  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  const v4 = files.filter((file) => V4_MIGRATION.test(file));
  assert.equal(v4.length, 1);
  assert.equal(files[files.length - 1], v4[0]);
  const sql = readFileSync(join(dir, v4[0]), "utf8").toLowerCase();

  assert.doesNotMatch(sql, /\bdrop\s+(table|column|function|index|trigger|policy|schema|view)\b/);
  assert.doesNotMatch(sql, /\bcreate\s+policy\b/);
  assert.doesNotMatch(sql, /\bsecurity\s+definer\b/);
  assert.doesNotMatch(sql, /\bgrant\s+(select|insert|update|delete|all)\b[^;]*\bto\s+(anon|authenticated|public)\b/);
  for (const match of sql.matchAll(/\balter\s+table\s+public\.([a-z_]+)/g)) {
    assert.ok(V4_TABLES.has(match[1]), `alters existing table ${match[1]}`);
  }
  for (const match of sql.matchAll(/\bcreate\s+table\s+public\.([a-z_]+)/g)) {
    assert.ok(V4_TABLES.has(match[1]), `unexpected table ${match[1]}`);
  }
});
