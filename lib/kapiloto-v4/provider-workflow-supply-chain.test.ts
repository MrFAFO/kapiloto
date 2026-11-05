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

const ALLOWED_ACTION_USES = new Set([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
]);

type JobBlock = {
  name: string;
  start: number;
  end: number;
  lines: string[];
};

function normalizeYaml(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

function stripYamlComment(line: string): string {
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single && line[index - 1] !== "\\") double = !double;
    else if (char === "#" && !single && !double) return line.slice(0, index).trimEnd();
  }
  return line.trimEnd();
}

function cleanLines(source: string): string[] {
  return normalizeYaml(source).split("\n").map(stripYamlComment);
}

function indent(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function yamlKey(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function directChildKeys(lines: string[], parentIndex: number, childIndent: number): string[] {
  const keys: string[] = [];
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const level = indent(line);
    if (level < childIndent) break;
    if (level !== childIndent) continue;
    const match = line.trim().match(/^(.+?)\s*:\s*(?:.*)?$/);
    if (match) keys.push(yamlKey(match[1]));
  }
  return keys;
}

function workflowTriggers(source: string): string[] {
  const lines = cleanLines(source);
  const onIndex = lines.findIndex((line) => /^\s*(?:"on"|'on'|on)\s*:\s*$/.test(line));
  assert.notEqual(onIndex, -1, "workflow must use a block-form on: section");
  assert.equal(indent(lines[onIndex]), 0, "on: must be top-level");
  return directChildKeys(lines, onIndex, 2);
}

function jobBlocks(source: string): JobBlock[] {
  const lines = cleanLines(source);
  const jobsIndex = lines.findIndex((line) => /^jobs\s*:\s*$/.test(line));
  assert.notEqual(jobsIndex, -1, "workflow must contain top-level jobs:");
  assert.equal(indent(lines[jobsIndex]), 0, "jobs: must be top-level");

  const starts: Array<{ name: string; index: number }> = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const level = indent(line);
    if (level === 0) break;
    if (level !== 2) continue;
    const match = line.match(/^ {2}([A-Za-z0-9_-]+)\s*:\s*$/);
    if (match) starts.push({ name: match[1], index });
  }

  return starts.map((start, position) => ({
    name: start.name,
    start: start.index,
    end: position + 1 < starts.length ? starts[position + 1].index : lines.length,
    lines: lines.slice(start.index, position + 1 < starts.length ? starts[position + 1].index : lines.length),
  }));
}

function containsSecretContext(source: string): boolean {
  const clean = cleanLines(source).join("\n");
  return (
    /\bsecrets\s*(?:\.|\[)/i.test(clean) ||
    /\btoJSON\s*\(\s*secrets\s*\)/i.test(clean) ||
    /^\s*secrets\s*:\s*inherit\s*$/im.test(clean)
  );
}

function directJobLine(job: JobBlock, key: string): string | undefined {
  const expression = new RegExp(`^ {4}${key}\\s*:\\s*(.+?)\\s*$`);
  return job.lines.find((line) => expression.test(line));
}

function stepBlocks(job: JobBlock): string[][] {
  const starts: number[] = [];
  for (let index = 0; index < job.lines.length; index += 1) {
    if (/^ {6}-\s+(?:name|uses)\s*:/.test(job.lines[index])) starts.push(index);
  }
  return starts.map((start, position) =>
    job.lines.slice(start, position + 1 < starts.length ? starts[position + 1] : job.lines.length),
  );
}

function actionUse(step: string[]): string | undefined {
  for (const line of step) {
    const match = line.match(/^\s*(?:-\s*)?uses\s*:\s*([^\s]+)\s*$/);
    if (match) return match[1];
  }
  return undefined;
}

function assertReadOnlyPermissions(source: string, name: string): void {
  const clean = cleanLines(source).join("\n");
  assert.match(
    clean,
    /^permissions\s*:\s*\n {2}contents\s*:\s*read\s*$/m,
    `${name} must set top-level contents: read permissions`,
  );
  assert.doesNotMatch(clean, /permissions\s*:\s*write-all/i, `${name} must not use write-all permissions`);
  assert.doesNotMatch(clean, /^\s+[A-Za-z0-9_-]+\s*:\s*write\s*$/im, `${name} must not grant write permission`);
}

function assertLockedInstallCommands(source: string, name: string): void {
  const clean = cleanLines(source).join("\n");
  assert.doesNotMatch(clean, /\bnpm\s+(?:install|i)\b/i, `${name} must not use npm install/npm i`);
  const ciCommands = [...clean.matchAll(/\bnpm\s+ci\b[^\n]*/gi)].map((match) => match[0]);
  for (const command of ciCommands) {
    assert.match(command, /(?:^|\s)--ignore-scripts(?:\s|$)/, `${name} npm ci must include --ignore-scripts`);
  }
}

function assertProviderWorkflowPolicy(name: string, source: string): void {
  const normalized = normalizeYaml(source);
  const triggers = workflowTriggers(normalized);
  assert.deepEqual(triggers, ["workflow_dispatch"], `${name} must be workflow_dispatch-only`);
  assertReadOnlyPermissions(normalized, name);
  assertLockedInstallCommands(normalized, name);

  const jobs = jobBlocks(normalized);
  const secretJobs = jobs.filter((job) => containsSecretContext(job.lines.join("\n")));
  assert.ok(secretJobs.length > 0, `${name} must contain at least one provider-secret job`);

  for (const job of secretJobs) {
    assert.equal(
      directJobLine(job, "if")?.trim(),
      "if: github.ref == 'refs/heads/main'",
      `${name}/${job.name} must use the exact main-only guard`,
    );
    assert.equal(
      directJobLine(job, "environment")?.trim(),
      "environment: provider-readonly",
      `${name}/${job.name} must use exactly environment: provider-readonly`,
    );

    const steps = stepBlocks(job);
    for (const step of steps) {
      const use = actionUse(step);
      if (!use) continue;
      assert.ok(ALLOWED_ACTION_USES.has(use), `${name}/${job.name} uses unreviewed or mutable action ${use}`);
      if (use.startsWith("actions/checkout@")) {
        assert.match(
          step.join("\n"),
          /^\s*persist-credentials\s*:\s*false\s*$/m,
          `${name}/${job.name} checkout must set persist-credentials: false in the same step`,
        );
      }
    }
  }
}

function assertLockfilePolicy(packageJsonSource: string, packageLockSource: string): void {
  const packageJson = JSON.parse(packageJsonSource) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageLock = JSON.parse(packageLockSource) as {
    lockfileVersion?: number;
    packages?: Record<
      string,
      {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        resolved?: string;
        integrity?: string;
        inBundle?: boolean;
      }
    >;
  };

  assert.equal(packageLock.lockfileVersion, 3);
  const root = packageLock.packages?.[""];
  assert.ok(root, "package-lock root entry is required");
  assert.deepEqual(root.dependencies ?? {}, packageJson.dependencies ?? {});
  assert.deepEqual(root.devDependencies ?? {}, packageJson.devDependencies ?? {});

  for (const [name, entry] of Object.entries(packageLock.packages ?? {})) {
    if (!name || entry.inBundle) continue;
    if (!entry.resolved) continue;
    assert.match(
      entry.resolved,
      /^https:\/\/registry\.npmjs\.org\//,
      `${name} resolves outside the public npm registry: ${entry.resolved}`,
    );
    assert.match(entry.integrity ?? "", /^sha512-/, `${name} must use sha512 integrity`);
  }
}

test("provider-secret workflow allowlist is complete and hardened", async () => {
  const files = (await readdir(WORKFLOW_DIR)).filter((name) => /\.ya?ml$/.test(name));
  const observedSecretWorkflows = new Set<string>();

  for (const name of files) {
    const source = await readFile(path.join(WORKFLOW_DIR, name), "utf8");
    if (!containsSecretContext(source)) continue;
    observedSecretWorkflows.add(name);
    assert.ok(
      PROVIDER_SECRET_WORKFLOWS.has(name),
      `${name} uses secrets but is not in the reviewed M-5 workflow allowlist`,
    );
    assertProviderWorkflowPolicy(name, source);
  }

  assert.deepEqual(
    [...observedSecretWorkflows].sort(),
    [...PROVIDER_SECRET_WORKFLOWS].sort(),
    "provider-secret workflow allowlist drifted",
  );
});

test("npm lockfile matches direct dependencies and registry entries are sha512 integrity-pinned", async () => {
  assertLockfilePolicy(
    await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    await readFile(path.join(process.cwd(), "package-lock.json"), "utf8"),
  );
});

test("M-5 guard rejects reviewed bypass variants and accepts CRLF", async () => {
  const providerSpike = await readFile(path.join(WORKFLOW_DIR, "provider-spike.yml"), "utf8");
  assert.doesNotThrow(() => assertProviderWorkflowPolicy("provider-spike.yml", providerSpike.replace(/\n/g, "\r\n")));

  const mustFail: Array<[string, string]> = [
    ["commented guard", providerSpike.replace("    if: github.ref == 'refs/heads/main'", "    # if: github.ref == 'refs/heads/main'")],
    ["guard OR true", providerSpike.replace("    if: github.ref == 'refs/heads/main'", "    if: github.ref == 'refs/heads/main' || true")],
    ["environment prefix", providerSpike.replace("environment: provider-readonly", "environment: provider-readonly-open")],
    ["npm ci without ignore scripts", providerSpike.replace("npm ci --ignore-scripts", "npm ci")],
    ["npm i", providerSpike.replace("npm ci --ignore-scripts", "npm i")],
    ["mutable checkout tag", providerSpike.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v4")],
    ["unreviewed action owner", providerSpike.replace(/actions\/checkout@[0-9a-f]{40}/, "evil/checkout@1111111111111111111111111111111111111111")],
    ["pull_request_target", providerSpike.replace("  workflow_dispatch:", "  pull_request_target:\n  workflow_dispatch:")],
    ["quoted push", providerSpike.replace("  workflow_dispatch:", '  "push":\n  workflow_dispatch:')],
    ["schedule spacing", providerSpike.replace("  workflow_dispatch:", "  schedule :\n  workflow_dispatch:")],
    ["write-all", providerSpike.replace("permissions:\n  contents: read", "permissions: write-all")],
    [
      "second checkout without credential hardening",
      providerSpike.replace(
        "      - name: Setup Node",
        "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n      - name: Setup Node",
      ),
    ],
  ];

  for (const [label, mutated] of mustFail) {
    assert.throws(() => assertProviderWorkflowPolicy("provider-spike.yml", mutated), label);
  }

  assert.equal(containsSecretContext("env:\n  X: ${{ secrets['SPORTMONKS_API_TOKEN'] }}\n"), true);
  assert.equal(containsSecretContext("env:\n  X: ${{ toJSON(secrets) }}\n"), true);
  assert.equal(containsSecretContext("    secrets: inherit\n"), true);
});

test("lockfile guard rejects non-registry resolutions and weak integrity", async () => {
  const packageJson = await readFile(path.join(process.cwd(), "package.json"), "utf8");
  const packageLock = await readFile(path.join(process.cwd(), "package-lock.json"), "utf8");
  const parsed = JSON.parse(packageLock) as { packages: Record<string, { resolved?: string; integrity?: string }> };
  const target = Object.keys(parsed.packages).find((name) => parsed.packages[name]?.resolved);
  assert.ok(target, "expected at least one resolved package");

  const external = structuredClone(parsed);
  external.packages[target].resolved = "https://example.com/package.tgz";
  assert.throws(() => assertLockfilePolicy(packageJson, JSON.stringify(external)));

  const weak = structuredClone(parsed);
  weak.packages[target].integrity = "sha1-deadbeef";
  assert.throws(() => assertLockfilePolicy(packageJson, JSON.stringify(weak)));
});
