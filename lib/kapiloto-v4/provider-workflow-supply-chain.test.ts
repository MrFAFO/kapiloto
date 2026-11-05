import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const WORKFLOW_DIR = path.join(process.cwd(), ".github", "workflows");
const PROVIDER_SECRET_WORKFLOWS = new Set([
  "kapiloto-v4-sportmonks-a2b-readiness.yml",
  "kapiloto-v4-sportmonks-season-roster.yml",
  "provider-spike.yml",
  "sportmonks-analytics-spike.yml",
]);

function actionUseLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("uses: "));
}

test("provider-secret workflow allowlist is complete and hardened", async () => {
  const files = (await readdir(WORKFLOW_DIR)).filter((name) => /\.ya?ml$/.test(name));
  const observedSecretWorkflows = new Set<string>();

  for (const name of files) {
    const source = await readFile(path.join(WORKFLOW_DIR, name), "utf8");
    const holdsProviderSecret =
      source.includes("secrets.SPORTMONKS_API_TOKEN") ||
      source.includes("secrets.API_FOOTBALL_API_KEY");

    if (!holdsProviderSecret) continue;
    observedSecretWorkflows.add(name);

    assert.ok(
      PROVIDER_SECRET_WORKFLOWS.has(name),
      `${name} uses a provider secret but is not in the reviewed M-5 workflow allowlist`,
    );
    assert.match(source, /^on:\n\s{2}workflow_dispatch:/m, `${name} must be operator-dispatched only`);
    assert.doesNotMatch(source, /^\s{2}(push|pull_request|schedule):/m, `${name} must not have an automatic trigger`);
    assert.match(
      source,
      /if:\s*github\.ref == 'refs\/heads\/main'/,
      `${name} must refuse provider-secret jobs outside main`,
    );
    assert.match(
      source,
      /persist-credentials:\s*false/,
      `${name} must not persist checkout credentials`,
    );
    assert.doesNotMatch(source, /\bnpm install\b/, `${name} must not use npm install`);

    for (const line of actionUseLines(source)) {
      assert.match(
        line,
        /^uses:\s+[^@\s]+@[0-9a-f]{40}(?:\s+#.*)?$/,
        `${name} action must be pinned to a full commit SHA: ${line}`,
      );
    }
  }

  assert.deepEqual(
    [...observedSecretWorkflows].sort(),
    [...PROVIDER_SECRET_WORKFLOWS].sort(),
    "provider-secret workflow allowlist drifted",
  );
});

test("npm lockfile matches direct dependencies and registry entries are integrity-pinned", async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageLock = JSON.parse(await readFile(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
    lockfileVersion?: number;
    packages?: Record<string, {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      resolved?: string;
      integrity?: string;
    }>;
  };

  assert.equal(packageLock.lockfileVersion, 3);
  const root = packageLock.packages?.[""];
  assert.ok(root, "package-lock root entry is required");
  assert.deepEqual(root.dependencies ?? {}, packageJson.dependencies ?? {});
  assert.deepEqual(root.devDependencies ?? {}, packageJson.devDependencies ?? {});

  for (const [name, entry] of Object.entries(packageLock.packages ?? {})) {
    if (!name || !entry.resolved?.startsWith("https://registry.npmjs.org/")) continue;
    assert.ok(entry.integrity, `${name} is registry-resolved but has no integrity hash`);
  }
});
