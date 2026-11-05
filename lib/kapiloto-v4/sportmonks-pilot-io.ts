import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SPORTMONKS_A2B_RAW_INDEX_VERSION,
  type SportmonksA2BCredentialGuard,
  type SportmonksA2BRawIndexEntry,
} from "./sportmonks-pilot";

/**
 * File-system side of the read-only A2-B pilot: the output directory, the
 * exact raw-response archive and the final credential scrub. Used only by
 * tools/kapiloto-v4-sportmonks-pilot.ts and tests; not exported from the V4
 * index and never imported by app, script or production library code.
 */

/**
 * Evidence from two runs must never mix: the output directory must be absent
 * or empty. A path that exists as a file fails too.
 */
export async function ensureEmptySportmonksA2BOutputDirectory(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root);
  if (entries.length > 0) {
    throw new Error(
      `A2-B output directory must be empty before a run: ${root} contains ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    );
  }
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class SportmonksA2BCredentialEchoError extends Error {
  constructor(endpoint: string) {
    super(`Sportmonks response for ${endpoint} contains the API credential; refusing to archive it and aborting the run.`);
    this.name = "SportmonksA2BCredentialEchoError";
  }
}

/**
 * Content-addressed archive of exact HTTP response bodies, written BEFORE any
 * JSON parsing at raw/<sha256>.bin, with raw-index.json recording the
 * sanitized endpoint, status, content type and size. A body that contains the
 * credential is never written: its bytes cannot be redacted without breaking
 * the hash, so the run aborts instead.
 */
export class SportmonksA2BRawArchive {
  private readonly entries: SportmonksA2BRawIndexEntry[] = [];

  constructor(
    private readonly root: string,
    private readonly guard: SportmonksA2BCredentialGuard,
  ) {}

  async init(): Promise<void> {
    await mkdir(path.join(this.root, "raw"), { recursive: true });
    await this.flush();
  }

  async record(input: {
    bytes: Uint8Array;
    endpoint: string;
    status: number;
    contentType: string | null;
  }): Promise<string> {
    if (this.guard.contains(input.endpoint)) {
      throw new Error("Sanitized endpoint still contains the API credential; refusing to archive.");
    }
    if (this.guard.contains(input.bytes)) throw new SportmonksA2BCredentialEchoError(input.endpoint);
    const hash = sha256Bytes(input.bytes);
    try {
      await writeFile(path.join(this.root, "raw", `${hash}.bin`), input.bytes, { flag: "wx" });
    } catch (error) {
      // Content-addressed: an existing file under the same hash holds the same bytes.
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
    }
    this.entries.push({
      sha256: hash,
      endpoint: input.endpoint,
      status: input.status,
      contentType: input.contentType,
      bytes: input.bytes.byteLength,
    });
    await this.flush();
    return hash;
  }

  snapshot(): SportmonksA2BRawIndexEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  private async flush(): Promise<void> {
    await writeFile(
      path.join(this.root, "raw-index.json"),
      JSON.stringify({ contract_version: SPORTMONKS_A2B_RAW_INDEX_VERSION, responses: this.entries }, null, 2) + "\n",
      "utf8",
    );
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

/**
 * Last line of defense before the workflow uploads the directory: if any
 * output file contains the credential, every entry of the output directory is
 * removed and the offending relative paths (never their contents) are
 * returned. An empty list means the directory is clean.
 */
export async function scrubSportmonksA2BOutputIfCredentialPresent(
  root: string,
  guard: SportmonksA2BCredentialGuard,
): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await listFiles(root)) {
    if (guard.contains(new Uint8Array(await readFile(file)))) offenders.push(path.relative(root, file).replace(/\\/g, "/"));
  }
  if (offenders.length > 0) {
    for (const entry of await readdir(root)) await rm(path.join(root, entry), { recursive: true, force: true });
  }
  return offenders.sort();
}
