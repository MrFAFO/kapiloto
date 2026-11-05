import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

/**
 * Static boundaries of the read-only Sportmonks A2-B pilot. The pilot calls a
 * real provider, so these pin what it can reach: an operator-dispatched
 * workflow only, a step-scoped token, the tools/ location, and an import graph
 * with no Supabase client, no RPC and no network call other than Sportmonks.
 */

const ROOT = process.cwd();
const WORKFLOWS = join(ROOT, ".github", "workflows");
const A2B_WORKFLOW = "kapiloto-v4-sportmonks-a2b-readiness.yml";
const TOOL = "tools/kapiloto-v4-sportmonks-pilot.ts";
const RUNNER = "lib/kapiloto-v4/sportmonks-pilot-runner.ts";
const PILOT_MODULES = ["lib/kapiloto-v4/sportmonks-pilot.ts", "lib/kapiloto-v4/sportmonks-pilot-io.ts", RUNNER];

const read = (file: string) => readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const posix = (file: string) => file.replace(/\\/g, "/");

function topLevelBlock(yaml: string, key: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  assert.ok(start >= 0, `workflow has a top-level ${key}`);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

test("the A2-B workflow is workflow_dispatch only, read-only, and scopes the token to the pilot step", () => {
  const yaml = read(join(".github", "workflows", A2B_WORKFLOW));
  const triggers = topLevelBlock(yaml, "on")
    .filter((line) => /^ {2}[A-Za-z_]+:/.test(line))
    .map((line) => line.trim().replace(/:.*$/, ""));
  assert.deepEqual(triggers, ["workflow_dispatch"]);
  assert.doesNotMatch(yaml, /^\s*(push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch|merge_group)\s*:/m);

  assert.deepEqual(topLevelBlock(yaml, "permissions").map((line) => line.trim()).filter(Boolean), ["contents: read"]);
  const code = yaml.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /:\s*write\b/);
  assert.doesNotMatch(code, /SUPABASE|service_role|DATABASE_URL/i);

  // Exactly one secret, used once, inside the pilot step's env.
  const secrets = [...yaml.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]);
  assert.deepEqual(secrets, ["SPORTMONKS_API_TOKEN"]);
  const secretLine = yaml.split("\n").findIndex((line) => line.includes("secrets.SPORTMONKS_API_TOKEN"));
  const stepStart = yaml.split("\n").slice(0, secretLine).map((line, index) => [line, index] as const).filter(([line]) => /^\s+- name:/.test(line)).pop();
  assert.ok(stepStart && /Run read-only Sportmonks A2-B pilot/.test(stepStart[0]), "the token belongs to the pilot step");
  assert.match(yaml.split("\n")[secretLine], /^ {10}SPORTMONKS_API_TOKEN: \$\{\{ secrets\.SPORTMONKS_API_TOKEN \}\}$/);
  assert.doesNotMatch(yaml, /echo[^\n]*SPORTMONKS_API_TOKEN/);

  // Dispatch inputs reach the shell only through env, never interpolated into run.
  for (const line of yaml.split("\n").filter((l) => l.includes("${{ inputs."))) {
    assert.match(line, /^\s+[A-Z_]+: \$\{\{ inputs\.[a-z_]+ \}\}$/, line);
  }
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /npm run pilot:sportmonks-a2b --/);
});

test("no other workflow runs the A2-B pilot, and no workflow gives it an automatic trigger", () => {
  for (const name of readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file))) {
    const yaml = read(join(".github", "workflows", name));
    if (name === A2B_WORKFLOW) continue;
    assert.doesNotMatch(yaml, /pilot:sportmonks|kapiloto-v4-sportmonks-pilot|sportmonks-pilot\.test/, name);
  }
});

test("the pilot runs from tools/, not from a production scripts/ path", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["pilot:sportmonks-a2b"], `tsx ${TOOL}`);
  const pilotScripts = Object.entries(pkg.scripts).filter(([, command]) => /sportmonks-pilot/.test(command));
  assert.deepEqual(pilotScripts.map(([name]) => name), ["pilot:sportmonks-a2b"]);
  // PR #30 placed the runner at scripts/; the M2B boundary forbids it there.
  assert.equal(existsSync(join(ROOT, "scripts", "kapiloto-v4-sportmonks-pilot.ts")), false);
  for (const name of readdirSync(join(ROOT, "scripts"))) {
    assert.doesNotMatch(readFileSync(join(ROOT, "scripts", name), "utf8"), /sportmonks-pilot/, name);
  }
});

test("only the operator tool and tests import the A2-B pilot modules", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", ".git", "artifacts"].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const file = posix(relative(ROOT, full));
        if (file === TOOL || PILOT_MODULES.includes(file)) continue;
        if (/sportmonks-pilot/.test(readFileSync(full, "utf8"))) offenders.push(file);
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(read("lib/kapiloto-v4/index.ts"), /sportmonks-pilot/);
});

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;

function importGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    const text = read(file);
    seen.set(file, text);
    for (const match of text.matchAll(IMPORT)) {
      const spec = match[1];
      if (spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("."), `${file} imports non-relative module ${spec}`);
      const base = resolve(ROOT, dirname(file), spec);
      const target = [`${base}.ts`, join(base, "index.ts")].find((candidate) => existsSync(candidate));
      assert.ok(target, `${file}: cannot resolve ${spec}`);
      visit(posix(relative(ROOT, target)));
    }
  };
  visit(entry);
  return seen;
}

test("the pilot's import graph has no Supabase client, no RPC and no network call except Sportmonks", () => {
  const graph = importGraph(TOOL);
  assert.deepEqual([...graph.keys()].sort(), [
    "lib/kapiloto-v4/canonical-json.ts",
    "lib/kapiloto-v4/match-ledger.ts",
    "lib/kapiloto-v4/provider-ingest.ts",
    "lib/kapiloto-v4/sportmonks-ledger.ts",
    "lib/kapiloto-v4/sportmonks-pilot-io.ts",
    "lib/kapiloto-v4/sportmonks-pilot-runner.ts",
    "lib/kapiloto-v4/sportmonks-pilot.ts",
    "lib/kapiloto-v4/versions.ts",
    TOOL,
  ]);
  // Drops comments; a "//" right after ":" is a URL scheme, not a comment.
  const stripped = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  for (const [file, text] of graph) {
    const code = stripped(text);
    assert.doesNotMatch(code, /@supabase|lib\/supabase|createClient|\.rpc\s*\(|\/rest\/v1|SUPABASE_|service_role|lib\/evaluation|child_process/, file);
    // Only the tool touches the global fetch, and only to hand it to the runner.
    assert.equal((code.match(/\bfetch\s*\(/g) ?? []).length, file === TOOL ? 1 : 0, `${file} fetch calls`);
    assert.equal((code.match(/https?:\/\//g) ?? []).length, file === RUNNER ? 1 : 0, `${file} URL literals`);
  }
  const tool = stripped(graph.get(TOOL)!);
  assert.match(tool, /fetch: \(url, init\) => fetch\(url, init\),/);

  // The runner's one transport call goes to a URL built from the Sportmonks base.
  const runner = stripped(graph.get(RUNNER)!);
  assert.match(runner, /export const SPORTMONKS_FOOTBALL_BASE = "https:\/\/api\.sportmonks\.com\/v3\/football";/);
  assert.equal((runner.match(/fetchImpl\(/g) ?? []).length, 1);
  assert.match(runner, /this\.fetchImpl\(url, \{/);
  // Review M-1: the query-string credential is never re-sent to a redirect target.
  assert.match(runner, /this\.fetchImpl\(url, \{[^}]*redirect: "error",/);
  assert.deepEqual([...runner.matchAll(/new URL\(([^)]*)\)/g)].map((match) => match[1]), ["`${SPORTMONKS_FOOTBALL_BASE}${endpoint}`"]);
  // Neither references ingest, run-header or attestation builders.
  for (const code of [tool, runner]) {
    assert.doesNotMatch(code, /PROVIDER_INGEST_FUNCTIONS|buildProviderIngestRunRow|buildProviderMatchObservationPayload|validateProviderMatchObservation|fixtureMintKickoffBefore/);
  }
});

test("the parser is only ever given the frozen no-mint policy", () => {
  const runner = read(RUNNER);
  const calls = [...runner.matchAll(/parseSportmonksLedgerCapture\(capture, \{\s*fixtureMint: ([A-Z0-9_]+),\s*runId: null,\s*\}\)/g)];
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "SPORTMONKS_A2B_PARSER_FIXTURE_MINT");
  assert.equal((runner.match(/parseSportmonksLedgerCapture\(/g) ?? []).length, 1);
  assert.doesNotMatch(read(TOOL), /parseSportmonksLedgerCapture|allowed:\s*true/);
  for (const file of PILOT_MODULES) assert.doesNotMatch(read(file), /allowed:\s*true/, file);
});

test("the report's approval and identity-readiness fields are constants", () => {
  const pilot = read("lib/kapiloto-v4/sportmonks-pilot.ts");
  assert.match(pilot, /backfillApproval: \{\n\s+approved: false as const,/);
  assert.match(pilot, /teamIdentityReadiness: \{\n\s+assessed: false as const,/);
  assert.doesNotMatch(pilot, /approved:\s*(true|input\.|[a-z]+\s*[?&|])/);
});
