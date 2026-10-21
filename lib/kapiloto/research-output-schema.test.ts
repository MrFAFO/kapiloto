import assert from "node:assert/strict";
import test from "node:test";

import researchOutputSchema from "@/docs/ai/kapiloto-research-output.schema.json";

import {
  KAPILOTO_TEXT_LIMITS,
  kapilotoTextLimitPattern,
  type KapilotoTextLimitField,
} from "./research-output";

type SchemaNode = Record<string, unknown>;

// Keywords OpenAI strict Structured Outputs rejects (the request fails with an
// error before generation). Adding one would fail every research attempt.
const STRICT_MODE_UNSUPPORTED = new Set([
  "maxLength",
  "minLength",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
]);

function collectPatterns(
  node: unknown,
  path: string,
  found: Map<string, string>,
  unsupported: string[],
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as SchemaNode;

  for (const key of Object.keys(schema)) {
    if (STRICT_MODE_UNSUPPORTED.has(key)) unsupported.push(`${path}:${key}`);
  }

  if (typeof schema.pattern === "string") found.set(path, schema.pattern);

  const properties = schema.properties as Record<string, unknown> | undefined;
  for (const [name, child] of Object.entries(properties ?? {})) {
    collectPatterns(child, path ? `${path}.${name}` : name, found, unsupported);
  }
  if (schema.items) collectPatterns(schema.items, path, found, unsupported);
}

function schemaPatterns() {
  const found = new Map<string, string>();
  const unsupported: string[] = [];
  collectPatterns(researchOutputSchema, "", found, unsupported);
  return { found, unsupported };
}

test("strict schema bounds every limited text field exactly like the validator", () => {
  const { found } = schemaPatterns();

  for (const field of Object.keys(KAPILOTO_TEXT_LIMITS) as KapilotoTextLimitField[]) {
    assert.equal(
      found.get(field),
      kapilotoTextLimitPattern(field),
      `schema pattern for ${field} must match the validator limit`,
    );
  }

  assert.deepEqual(
    [...found.keys()].sort(),
    Object.keys(KAPILOTO_TEXT_LIMITS).sort(),
    "every schema pattern must correspond to a validator limit",
  );
});

test("strict schema uses no keyword that OpenAI strict mode rejects", () => {
  assert.deepEqual(schemaPatterns().unsupported, []);
});

test("length patterns accept the limit and reject one character more", () => {
  for (const field of Object.keys(KAPILOTO_TEXT_LIMITS) as KapilotoTextLimitField[]) {
    const limit = KAPILOTO_TEXT_LIMITS[field];
    const pattern = new RegExp(kapilotoTextLimitPattern(field));
    assert.equal(pattern.test("a".repeat(limit)), true, field);
    assert.equal(pattern.test("a".repeat(limit + 1)), false, field);
    // Hebrew characters count as single characters, like String#length.
    assert.equal(pattern.test("ש".repeat(limit)), true, field);
  }
});

test("key_assumptions limit matches the failure seen in production", () => {
  const pattern = new RegExp(kapilotoTextLimitPattern("key_assumptions"));
  assert.equal(KAPILOTO_TEXT_LIMITS.key_assumptions, 150);
  assert.equal(pattern.test("x".repeat(151)), false);
});
