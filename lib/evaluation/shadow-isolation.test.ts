import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

import { SHADOW_EVALUATION_WRITE_TABLES } from "./supabase-store";

const ROOT = process.cwd();
const EVALUATION_DIR = join(ROOT, "lib", "evaluation");
const SHADOW_CLI = join(ROOT, "scripts", "evaluation-shadow.ts");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === "node_modules" || entry.startsWith(".") ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const productionFiles = ["app", "components", "lib", "scripts"]
  .flatMap((directory) => sourceFiles(join(ROOT, directory)))
  .filter((path) => !path.startsWith(EVALUATION_DIR + sep) && path !== SHADOW_CLI);

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
  for (const path of [...evaluationFiles, SHADOW_CLI]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /openai|web_search|OPENAI_API_KEY/i, relative(ROOT, path));
    assert.doesNotMatch(source, /@\/lib\/kapiloto\/(?!snapshot)/, relative(ROOT, path));
  }
});
