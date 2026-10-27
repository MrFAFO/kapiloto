import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

import { SHADOW_EVALUATION_WRITE_TABLES } from "./supabase-store";

const ROOT = process.cwd();
const EVALUATION_DIR = join(ROOT, "lib", "evaluation");
const SHADOW_CLI = join(ROOT, "scripts", "evaluation-shadow.ts");
const SHADOW_ROUTE = join(ROOT, "app", "api", "internal", "cron", "shadow-evaluation", "route.ts");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === "node_modules" || entry.startsWith(".") ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

// Research v2 foundations are shadow-side until explicitly approved.
const RESEARCH_V2_DIR = join(ROOT, "lib", "research-v2");
const RESEARCH_V2_LIVE_DEV_CLI = join(ROOT, "scripts", "research-v2-live-dev.ts");
const RESEARCH_V2_DISCOVERY_CLI = join(ROOT, "scripts", "research-v2-discovery.ts");

const productionFiles = ["app", "components", "lib", "scripts"]
  .flatMap((directory) => sourceFiles(join(ROOT, directory)))
  .filter(
    (path) =>
      !path.startsWith(EVALUATION_DIR + sep) &&
      !path.startsWith(RESEARCH_V2_DIR + sep) &&
      path !== RESEARCH_V2_LIVE_DEV_CLI &&
      path !== RESEARCH_V2_DISCOVERY_CLI &&
      path !== SHADOW_CLI &&
      path !== SHADOW_ROUTE,
  );

const evaluationFiles = sourceFiles(EVALUATION_DIR).filter(
  (path) => !path.endsWith(".test.ts"),
);

test("no production module imports the shadow evaluation code", () => {
  const offenders = productionFiles.filter((path) =>
    /from\s+["'](?:@\/lib\/evaluation|(?:\.\.?\/)+(?:lib\/)?evaluation)(?:\/|["'])/.test(
      readFileSync(path, "utf8"),
    ),
  );
  assert.deepEqual(offenders.map((path) => relative(ROOT, path)), []);
});

test("no production module reads or writes the shadow tables", () => {
  const offenders = productionFiles.filter((path) => {
    const source = readFileSync(path, "utf8");
    return SHADOW_EVALUATION_WRITE_TABLES.some((table) => source.includes(`"${table}"`));
  });
  assert.deepEqual(offenders.map((path) => relative(ROOT, path)), []);
});

test("shadow evaluation code writes only to shadow tables and calls no RPCs", () => {
  const writes: string[] = [];
  for (const path of evaluationFiles) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\.rpc\(/, relative(ROOT, path));
    for (const match of source.matchAll(
      /\.from\("([a-z_]+)"\)\s*\.(insert|upsert|update|delete)\(/g,
    )) {
      writes.push(`${match[1]}.${match[2]}`);
    }
    assert.doesNotMatch(
      source,
      /\.from\([^)]*\)\s*\.select\([^)]*\)\s*\.(insert|upsert|update|delete)\(/,
    );
  }
  assert.ok(writes.length > 0);
  for (const write of writes) {
    const table = write.split(".")[0];
    assert.ok(
      (SHADOW_EVALUATION_WRITE_TABLES as readonly string[]).includes(table),
      `unexpected write ${write}`,
    );
    assert.ok(!write.endsWith(".update") && !write.endsWith(".delete"), write);
  }
});

test("shadow evaluation code never calls OpenAI or web research", () => {
  for (const path of [...evaluationFiles, SHADOW_CLI, SHADOW_ROUTE]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /openai|web_search|OPENAI_API_KEY/i, relative(ROOT, path));
    // Only the route may use the shared worker-secret check (pure auth, no research).
    const allowed = path === SHADOW_ROUTE
      ? ["snapshot", "research-config", "worker-auth"]
      : ["snapshot", "research-config"];
    for (const match of source.matchAll(/from\s+["'](?:@\/|(?:\.\.\/)+)lib\/kapiloto\/([a-z-]+)["']/g)) {
      assert.ok(
        allowed.includes(match[1]),
        `${relative(ROOT, path)} imports lib/kapiloto/${match[1]}`,
      );
    }
  }
});

test("the shadow cron route is worker-secret protected, POST-only, deferred and not scheduled", () => {
  const source = readFileSync(SHADOW_ROUTE, "utf8");
  assert.match(source, /verifyKapilotoWorkerAuthorization\(\s*request\.headers\.get\("authorization"\),\s*process\.env\.KAPILOTO_WORKER_SECRET_SHA256,?\s*\)/);
  assert.match(source, /handleShadowEvaluationRequest\(/);
  assert.match(source, /defer: after/);
  assert.match(source, /export async function POST\(/);
  assert.doesNotMatch(source, /export async function (GET|PUT|PATCH|DELETE)\(/);
  assert.doesNotMatch(source, /CRON_SECRET/);
  assert.doesNotMatch(source, /round_sync_control|\.from\(/);
  const vercel = readFileSync(join(ROOT, "vercel.json"), "utf8");
  assert.doesNotMatch(vercel, /shadow-evaluation/);
});

test("no production module imports Research v2, and Research v2 calls no model or research code", () => {
  const offenders = productionFiles.filter((path) =>
    /from\s+["'](?:@\/lib\/research-v2|(?:\.\.?\/)+(?:lib\/)?research-v2)(?:\/|["'])/.test(readFileSync(path, "utf8")),
  );
  assert.deepEqual(offenders.map((path) => relative(ROOT, path)), []);
  // Tests may name the forbidden strings to assert they are blocked. Only the
  // Research v2 model-client files may reach OpenAI (D-047, step 5).
  const MODEL_CLIENT_FILES = new Set(["model-call.ts", "discovery-client.ts", "entailment-client.ts"]);
  for (const path of sourceFiles(RESEARCH_V2_DIR).filter((file) => !file.endsWith(".test.ts"))) {
    const source = readFileSync(path, "utf8");
    const name = relative(RESEARCH_V2_DIR, path).replace(/\\/g, "/");
    if (!MODEL_CLIENT_FILES.has(name)) {
      // Code-level use is forbidden; naming the vendor in a pricing provenance note is not.
      assert.doesNotMatch(source, /from\s+["']openai["']|require\(\s*["']openai["']\s*\)|import\(\s*["']openai["']\s*\)|web_search|OPENAI_API_KEY|responses\.create/, relative(ROOT, path));
    } else {
      assert.doesNotMatch(source, /OPENAI_API_KEY|process\.env/, `${name} takes its key as a parameter, never from the environment`);
    }
    assert.doesNotMatch(source, /from\s+["'](?:@\/|(?:\.\.\/)+)lib\/kapiloto\//, relative(ROOT, path));
  }
});

test("the Research v2 discovery CLI is read-only, network-guarded for research and network-free for replay", () => {
  const source = readFileSync(RESEARCH_V2_DISCOVERY_CLI, "utf8");
  assert.match(source, /readOnlySupabaseClient\(/);
  assert.match(source, /installResearchFetchGuard\(supabaseUrl\)/);
  assert.match(source, /import \{ blockAllNetwork \} from "\.\.\/lib\/research-v2\/network-block";/);
  assert.match(source, /blockAllNetwork\(\);\r?\n  const result = replayDiscoveryArtifact/);
  assert.doesNotMatch(source, /from\s+["']openai["']|lib\/kapiloto\//);
  assert.doesNotMatch(source, /\.rpc\(|\.insert\(|\.upsert\(|\.update\(|\.delete\(|\.storage\.|\.functions\./);
});

test("the Research v2 live-dev CLI is read-only, network-guarded and model-free", () => {
  const source = readFileSync(RESEARCH_V2_LIVE_DEV_CLI, "utf8");
  assert.match(source, /installLiveDevFetchGuard\(supabaseUrl\)/);
  assert.match(source, /createLiveDevProviders\(/);
  assert.match(source, /installNoNetworkGuard\(\)/);
  assert.doesNotMatch(source, /openai|web_search|lib\/kapiloto\//i);
  assert.doesNotMatch(source, /\.from\(\s*["'`]|\.rpc\(|\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
});
