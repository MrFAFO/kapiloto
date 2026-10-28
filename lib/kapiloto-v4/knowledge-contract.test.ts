import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaimPayload,
  buildClaimResolutionPayload,
  independentSourceCount,
  resolutionStatusAsOf,
  validateClaim,
  validateClaimResolution,
} from "./claims";
import { documentIdentityKey, validateDocumentVersion } from "./documents";
import { buildPredictionSnapshotPayload, toBasisPoints, validatePredictionSnapshot } from "./prediction-registry";
import { articleInput, basePrediction } from "./test-support/knowledge-fixtures";
import {
  CLAIM_CONTRACT_VERSION,
  CLAIM_RESOLUTION_CONTRACT_VERSION,
  PREDICTION_SNAPSHOT_CONTRACT_VERSION,
} from "./versions";

const FIXTURE = "f0000000-0000-4000-8000-000000000001";

test("basis points are deterministic and always sum to 10,000", () => {
  assert.deepEqual(toBasisPoints(1, 1, 1), { p1Bp: 3334, pXBp: 3333, p2Bp: 3333 });
  assert.deepEqual(toBasisPoints(0.4567, 0.2811, 0.2622), { p1Bp: 4567, pXBp: 2811, p2Bp: 2622 });
  for (const [p1, pX, p2] of [[0.1, 0.2, 0.7], [2, 1, 1], [0.333, 0.333, 0.334], [1, 0, 0]]) {
    const bp = toBasisPoints(p1, pX, p2);
    assert.equal(bp.p1Bp + bp.pXBp + bp.p2Bp, 10_000, `${p1}/${pX}/${p2}`);
    assert.deepEqual(toBasisPoints(p1, pX, p2), bp);
  }
  assert.throws(() => toBasisPoints(0, 0, 0));
  assert.throws(() => toBasisPoints(-1, 1, 1));
});

test("document identity prefers external ids and validation mirrors the rights checks", () => {
  assert.equal(documentIdentityKey({ canonicalUrl: "https://a.example/x" }), "url:https://a.example/x");
  assert.equal(documentIdentityKey({ canonicalUrl: "https://a.example/x", platform: "youtube", externalId: "v1" }), "ext:youtube:v1");
  assert.equal(documentIdentityKey({ externalId: "v1" }), null);
  const article = articleInput();
  assert.deepEqual(validateDocumentVersion(article), []);
  assert.ok(validateDocumentVersion({ ...article, rights: { ...article.rights, accessBasis: "unknown", mayExposeExcerpts: true } }).length > 0);
  assert.ok(validateDocumentVersion({ ...article, discovery: { channel: "feed", rank: 3 } }).length > 0);
});

test("claim and resolution contracts keep derived, degraded and fabricated semantics apart", () => {
  const claim = {
    claimKind: "reported_expectation" as const,
    claimType: "player_availability",
    predicate: "availability_status",
    fixtureId: FIXTURE.toUpperCase(),
    objectValue: { status: "doubtful" },
    temporalScope: "fixture" as const,
  };
  assert.deepEqual(validateClaim(claim), []);
  const payload = buildClaimPayload(claim);
  assert.equal(payload.contract_version, CLAIM_CONTRACT_VERSION);
  assert.equal(payload.fixture_id, FIXTURE);
  assert.ok(validateClaim({ ...claim, fixtureId: null }).some((issue) => issue.includes("subject")));
  assert.ok(validateClaim({ ...claim, claimKind: "derived_inference" }).some((issue) => issue.includes("premises")));
  assert.ok(validateClaim({ ...claim, premises: ["x"] }).some((issue) => issue.includes("only derived")));

  const resolution = { claimId: FIXTURE, resolverKind: "grounding" as const, resolverVersion: "g1" };
  assert.ok(validateClaimResolution({ ...resolution, status: "verified_degraded", reasonCode: "x", evidence: [{ evidenceRole: "supporting", documentVersionId: FIXTURE }] }).some((i) => i.includes("qualityFlags")));
  assert.ok(validateClaimResolution({ ...resolution, status: "fabricated", reasonCode: "missing_author", evidence: [{ evidenceRole: "absence", documentVersionId: FIXTURE }] }).some((i) => i.includes("never fabrication")));
  assert.ok(validateClaimResolution({ ...resolution, status: "contradicted", reasonCode: "x" }).some((i) => i.includes("must cite evidence")));
  assert.ok(validateClaimResolution({ ...resolution, status: "quarantined", reasonCode: "x", evidence: [{ evidenceRole: "context" }] }).some((i) => i.includes("exactly one row")));
  assert.deepEqual(validateClaimResolution({ ...resolution, status: "unresolved", reasonCode: "x" }), []);
  assert.equal(buildClaimResolutionPayload({ ...resolution, status: "unresolved", reasonCode: "x" }).contract_version, CLAIM_RESOLUTION_CONTRACT_VERSION);
});

test("in-memory as-of and independence mirrors match the database semantics", () => {
  const resolutions = [
    { resolutionVersion: 1, firstSeenAt: "2026-10-28T10:00:00Z", status: "unresolved" as const },
    { resolutionVersion: 2, firstSeenAt: "2026-10-29T10:00:00Z", status: "verified_degraded" as const },
    { resolutionVersion: 3, firstSeenAt: "2026-11-02T21:30:00Z", status: "contradicted" as const },
  ];
  assert.equal(resolutionStatusAsOf(resolutions, "2026-10-27T00:00:00Z"), "unresolved");
  assert.equal(resolutionStatusAsOf(resolutions, "2026-10-30T00:00:00Z"), "verified_degraded");
  assert.equal(resolutionStatusAsOf(resolutions, "2026-11-03T00:00:00Z"), "contradicted");
  assert.equal(
    independentSourceCount([
      { documentId: "wire", independenceKey: "wire:1" },
      { documentId: "reprint", independenceKey: "wire:1" },
      { documentId: "own", independenceKey: "sha256:abc" },
      { documentId: "own", independenceKey: "sha256:abc" },
    ]),
    2,
  );
});

test("prediction snapshot validation and payload are deterministic and contract-versioned", () => {
  const snapshot = basePrediction(FIXTURE, {
    inputs: { identities: [{ entityType: "player", entityId: FIXTURE.toUpperCase(), bindingRole: "starter" }] },
  });
  assert.deepEqual(validatePredictionSnapshot(snapshot), []);
  const payload = buildPredictionSnapshotPayload(snapshot);
  assert.equal(payload.contract_version, PREDICTION_SNAPSHOT_CONTRACT_VERSION);
  assert.deepEqual((payload.inputs as { identities: Array<{ entity_id: string }> }).identities[0].entity_id, FIXTURE);
  assert.ok(validatePredictionSnapshot({ ...snapshot, probabilities: { p1Bp: 5000, pXBp: 2500, p2Bp: 2499 } }).some((i) => i.includes("sum to 10000")));
  assert.ok(validatePredictionSnapshot({ ...snapshot, outcome: "abstained" }).some((i) => i.includes("no probabilities")));
  assert.ok(validatePredictionSnapshot({ ...snapshot, researchCutoffAt: "2026-11-03T00:00:00Z" }).some((i) => i.includes("after kickoff")));
  assert.ok(validatePredictionSnapshot({ ...snapshot, payload: { chain_of_thought: "..." } as never }).some((i) => i.includes("unknown payload section")));
  assert.ok(
    validatePredictionSnapshot({
      ...snapshot,
      inputs: { identities: [{ entityType: "team", entityId: FIXTURE, observedEntityId: FIXTURE, bindingRole: "home" }] },
    }).some((i) => i.includes("no observed id")),
  );
});
