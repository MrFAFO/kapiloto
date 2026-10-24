import { createHash } from "node:crypto";

/** Engine (code) version of the Research v2 deterministic forecast. */
export const RESEARCH_V2_ENGINE_VERSION = "kapiloto-research-v2-engine-v1" as const;

/**
 * Lifecycle of a configuration value. Nothing in Research v2 foundations is
 * `approved`: every weight, threshold and effect size is a `candidate` until
 * forward evaluation (never the current round's outcomes) supports it.
 */
export type ConfigStatus = "candidate" | "approved";

/** Every config object carries its own identity and lifecycle. */
export type VersionedConfig = {
  id: string;
  version: string;
  status: ConfigStatus;
};

/** JSON with object keys sorted recursively; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** What a stored output must carry to be reproduced and audited later. */
export type ConfigProvenance = {
  id: string;
  version: string;
  status: ConfigStatus;
  sha256: string;
};

export function configProvenance(config: VersionedConfig): ConfigProvenance {
  return {
    id: config.id,
    version: config.version,
    status: config.status,
    sha256: sha256Canonical(config),
  };
}
