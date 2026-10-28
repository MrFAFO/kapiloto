import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEntityAlias } from "./aliases";
import { resolveAliasCandidates, survivingEntityId, tenureCoversDate } from "./entities";

test("alias normalization unifies Hebrew points, geresh, maqaf, quotes and spacing", () => {
  assert.equal(normalizeEntityAlias("  שְׁטֵייפְמַן  "), "שטייפמן");
  assert.equal(normalizeEntityAlias("ג׳ורג׳"), "ג'ורג'");
  assert.equal(normalizeEntityAlias("בן־חיים"), "בן-חיים");
  assert.equal(normalizeEntityAlias("O’Brien  Jr."), "o'brien jr.");
  assert.equal(normalizeEntityAlias("Mac\tAllister"), "mac allister");
  // Transliteration variants stay distinct on purpose.
  assert.notEqual(normalizeEntityAlias("Sztejfman"), normalizeEntityAlias("Shteifman"));
});

test("alias candidates never resolve to one of several different entities", () => {
  assert.deepEqual(resolveAliasCandidates([]), { status: "unresolved" });
  assert.deepEqual(resolveAliasCandidates(["b", "b"]), { status: "unique", entityId: "b" });
  assert.deepEqual(resolveAliasCandidates(["b", "a", "b"]), {
    status: "ambiguous",
    candidateIds: ["a", "b"],
  });
});

test("merged identities redirect one hop to the surviving id", () => {
  assert.equal(survivingEntityId({ id: "dup", identityStatus: "merged", mergedIntoId: "keep" }), "keep");
  assert.equal(survivingEntityId({ id: "keep", identityStatus: "active", mergedIntoId: null }), "keep");
});

test("tenure coverage honors uncertain start and end dates", () => {
  const tenure = {
    startsOn: { earliest: "2026-06-01", latest: "2026-06-30" },
    endsOn: { earliest: "2026-10-30", latest: "2026-10-30" },
    assertionStatus: "asserted" as const,
  };
  assert.equal(tenureCoversDate(tenure, "2026-05-31"), "no");
  assert.equal(tenureCoversDate(tenure, "2026-06-15"), "possible");
  assert.equal(tenureCoversDate(tenure, "2026-08-01"), "certain");
  assert.equal(tenureCoversDate(tenure, "2026-10-30"), "certain");
  assert.equal(tenureCoversDate(tenure, "2026-10-31"), "no");
  assert.equal(tenureCoversDate({ ...tenure, endsOn: null }, "2027-01-01"), "certain");
  assert.equal(tenureCoversDate({ ...tenure, assertionStatus: "retracted" }, "2026-08-01"), "no");
});
