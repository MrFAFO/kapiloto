import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTESTATION_BASES,
  attestationEvidenceIssue,
  blockingAttestationConflicts,
  buildCompetitionRevocationPayload,
  buildTeamAttestationPayload,
  type AttestationConflict,
} from "./identity-attestations";
import { PROVIDER_IDENTITY_ATTESTATION_EVIDENCE_VERSION } from "./versions";

const evidence = (overrides: Record<string, unknown> = {}) => ({
  contract_version: PROVIDER_IDENTITY_ATTESTATION_EVIDENCE_VERSION,
  sources: ["synthetic"],
  reviewed_by: "synthetic reviewer",
  duplicate_audit_sha256: "b".repeat(64),
  ...overrides,
});
const TEAM = "00000081-0000-4000-8000-000000000001";

test("the evidence mirror enforces the database contract (shape, required keys, hash, 64 KiB)", () => {
  assert.equal(attestationEvidenceIssue(evidence()), null);
  assert.equal(attestationEvidenceIssue(evidence({ crosscheck: { provider: "x" } })), null);
  assert.match(attestationEvidenceIssue([]) ?? "", /JSON object/);
  assert.match(attestationEvidenceIssue(evidence({ contract_version: "x" })) ?? "", /contract_version/);
  assert.match(attestationEvidenceIssue(evidence({ sources: [] })) ?? "", /non-empty array/);
  assert.match(attestationEvidenceIssue(evidence({ sources: [""] })) ?? "", /non-empty strings or objects/);
  assert.match(attestationEvidenceIssue(evidence({ reviewed_by: " " })) ?? "", /reviewed_by/);
  assert.match(attestationEvidenceIssue(evidence({ duplicate_audit_sha256: "z" })) ?? "", /duplicate_audit_sha256/);
  assert.match(attestationEvidenceIssue(evidence({ note: "x".repeat(70_000) })) ?? "", /64 KiB/);
});

test("payload builders accept Sportmonks only, exact refs, a closed basis, and require a reason to revoke", () => {
  const ok = buildTeamAttestationPayload({ provider: "sportmonks", providerTeamId: "52", teamId: TEAM.toUpperCase(), basis: "operator_manual", evidence: evidence() as never, attestedBy: "op" });
  assert.deepEqual([ok.provider_team_id, ok.team_id], ["52", TEAM]);
  assert.throws(() => buildTeamAttestationPayload({ provider: "api_football" as never, providerTeamId: "52", teamId: TEAM, basis: "operator_manual", evidence: evidence() as never, attestedBy: "op" }), /sportmonks only/);
  assert.throws(() => buildTeamAttestationPayload({ provider: "sportmonks", providerTeamId: " 52", teamId: TEAM, basis: "operator_manual", evidence: evidence() as never, attestedBy: "op" }), /exact/);
  assert.throws(() => buildTeamAttestationPayload({ provider: "sportmonks", providerTeamId: "52", teamId: TEAM, basis: "name_match" as never, evidence: evidence() as never, attestedBy: "op" }), /basis/);
  assert.throws(() => buildCompetitionRevocationPayload({ provider: "sportmonks", providerCompetitionId: "8", expectedCompetitionId: TEAM, reason: "", revokedBy: "op" }), /reason/);
  assert.equal(ATTESTATION_BASES.length, 5);
});

test("the readiness filter keeps only blocking issues on the pilot's own refs", () => {
  const row = (issue_code: AttestationConflict["issue_code"], severity: AttestationConflict["severity"], entity_kind: AttestationConflict["entity_kind"], provider_ref: string) =>
    ({ issue_code, severity, entity_kind, provider_ref, attested_canonical_id: null, attestation_generation_id: null, mapping_canonical_id: null, mapping_status: null, related_provider_ref: null }) as AttestationConflict;
  const conflicts = [
    row("attested_mapping_disagrees", "blocking", "team", "52"),
    row("attested_mapping_missing", "blocking", "team", "99"),
    row("shadow_mapping_for_attested_canonical", "warning", "team", "52"),
    row("attested_mapping_not_manual_override", "blocking", "competition", "8"),
    row("mapping_unattested", "info", "competition", "8"),
  ];
  assert.deepEqual(
    blockingAttestationConflicts(conflicts, { teams: ["52"], competitions: ["8"] }).map((c) => c.issue_code),
    ["attested_mapping_disagrees", "attested_mapping_not_manual_override"],
  );
});
