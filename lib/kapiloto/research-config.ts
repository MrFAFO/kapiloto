import { createHash } from "node:crypto";

import { KAPILOTO_SOL_SYSTEM_PROMPT } from "./research-prompt";
import type { KapilotoRunConfig } from "./research-request-service";
import type { KapilotoSolReasoningEffort } from "./openai-research";

export const KAPILOTO_RESEARCH_PROTOCOL_VERSION = "kapiloto-research-v1";
export const KAPILOTO_DERIVATION_VERSION = "kapiloto-derivation-v1";
export const KAPILOTO_SOURCE_POLICY_VERSION = "kapiloto-source-v1";
export const KAPILOTO_RECENCY_POLICY_VERSION = "kapiloto-recency-v1";
export const KAPILOTO_RELIABILITY_FORMULA_VERSION =
  "kapiloto-reliability-shadow-v1";
export const KAPILOTO_BLEND_POLICY_VERSION = "kapiloto-blend-shadow-v1";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const KAPILOTO_PROMPT_TEMPLATE_SHA256 = sha256Text(
  KAPILOTO_SOL_SYSTEM_PROMPT,
);

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
  field: string,
): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

export function getKapilotoOpenAIModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const model = env.KAPILOTO_OPENAI_MODEL?.trim();
  if (!model) {
    throw new Error(
      "KAPILOTO_OPENAI_MODEL is required; the exact Sol model id is server configuration.",
    );
  }
  return model;
}

export function getKapilotoReasoningEffort(
  env: NodeJS.ProcessEnv = process.env,
): KapilotoSolReasoningEffort {
  const effort = (env.KAPILOTO_OPENAI_REASONING_EFFORT ?? "high").trim();
  if (effort !== "low" && effort !== "medium" && effort !== "high") {
    throw new Error(
      "KAPILOTO_OPENAI_REASONING_EFFORT must be low, medium, or high.",
    );
  }
  return effort;
}

export function getApiFootballMinRequestIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.API_FOOTBALL_MIN_REQUEST_INTERVAL_MS;
  if (raw == null || raw.trim() === "") return 6_500;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "API_FOOTBALL_MIN_REQUEST_INTERVAL_MS must be a non-negative number.",
    );
  }
  return value;
}

export function getKapilotoRunConfig(
  env: NodeJS.ProcessEnv = process.env,
): KapilotoRunConfig {
  return {
    modelKey: getKapilotoOpenAIModel(env),
    researchProtocolVersion: KAPILOTO_RESEARCH_PROTOCOL_VERSION,
    derivationVersion: KAPILOTO_DERIVATION_VERSION,
    sourcePolicyVersion: KAPILOTO_SOURCE_POLICY_VERSION,
    recencyPolicyVersion: KAPILOTO_RECENCY_POLICY_VERSION,
    reliabilityFormulaVersion: KAPILOTO_RELIABILITY_FORMULA_VERSION,
    blendPolicyVersion: KAPILOTO_BLEND_POLICY_VERSION,
    calibrationVersion: null,
    promptTemplateSha256: KAPILOTO_PROMPT_TEMPLATE_SHA256,
    executionTopology: "fixture_fanout",
    maxAttemptsPerTask: parsePositiveInteger(
      env.KAPILOTO_MAX_ATTEMPTS_PER_TASK,
      3,
      "KAPILOTO_MAX_ATTEMPTS_PER_TASK",
    ),
  };
}
