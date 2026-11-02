# Claude Code — Independent Review of PR #43 / M2B Consumer-Read Boundary

You are an independent senior database/security architect reviewing Kapiloto PR #43.

Repository:
- MrFAFO/kapiloto
- base: main
- branch: feat/v4-attestation-aware-consumer-reads
- PR: #43
- title: feat: make V4 consumer reads attestation-aware

Read first:
- AGENTS.md
- docs/architecture/KAPILOTO-V4-MASTER-ROADMAP.md
- docs/architecture/KAPILOTO-V4-IDENTITY-ATTESTATIONS-RFC.md
- docs/architecture/KAPILOTO-V4-PROVIDER-INGEST.md
- docs/architecture/KAPILOTO-V4-SQUAD-STATE.md
- docs/prompts/CLAUDE-CODE-ARCHITECT-REVIEW.md

Then review the complete diff of PR #43 against main.

## Context

M2A is already applied in production. Provider ingest is deliberately disabled.
The current blocker before M2B/tiny real ingest is that several older Match
Ledger reads are not identity-attestation-aware.

PR #43 adds additive V2 successors for:
- public.match_ledger_observation_as_of_v2
- public.match_ledger_provider_team_matches_as_of_v2
- public.match_ledger_provider_player_matches_as_of_v2
- public.squad_state_inputs_as_of_v2

It also routes new lineup forecast loading through squad_state_inputs_as_of_v2.

Frozen V1 read contracts must remain unchanged.
V1 and V2 ingest must remain disabled by this PR.
No production data write is intended.

## Required review

Red-team the PR. Do not merely validate the intended design.

Focus especially on:

1. Trust ordering
   - Is the latest visible provider version selected BEFORE trust filtering?
   - Can an older trusted observation be resurrected when the latest version is
     withdrawn, unattested, revoked, stale or otherwise invalid?
   - Are correction/withdrawal semantics preserved?

2. Trust-at-read-time vs trust-at-ingest-time
   - Is using private.match_ledger_observation_attestation_issue() at read time
     correct for prediction, historical reconstruction and frozen replay?
   - Could a later revoke/re-attest unexpectedly rewrite the effective past?
   - Does the frozen prediction artifact remain the authoritative replay record?

3. Attestation completeness
   - Does the helper prove league + home + away identity correctly?
   - Does it fail closed for plain 1A rows, V1 ingest rows and providers without
     Stage 1 attestations?
   - Does it correctly handle mapping deletion, demotion, re-pointing,
     generation revocation and stale generations?

4. Squad State semantics
   - Does squad_state_inputs_as_of_v2 preserve the V1 leakage/cutoff semantics?
   - Does the history fixture limit still apply at the right stage?
   - Does provider fusion remain correct?
   - Is dropping unattested providers from the provider-priority pool safe and
     explicit?
   - Could trusted observations be omitted or untrusted ones leak through
     players/substitutions/team_records joins?

5. Player/team read semantics
   - Check candidate construction and version ranking.
   - Verify no duplicate rows or match_rank distortion is introduced.
   - Verify player merges and team identity behavior remain correct.

6. Permissions and database boundary
   - New V2 reads should be executable only by service_role.
   - No anon/authenticated/public access.
   - Neither V1 nor V2 provider ingest may become executable.
   - Check PostgreSQL default function EXECUTE behavior and whether the REVOKE /
     GRANT sequence is sufficient.
   - Check SECURITY INVOKER implications and private helper EXECUTE grants.

7. Migration safety
   - Must be additive.
   - Must not mutate V3 tables or production rows.
   - Must not redefine frozen V1 functions.
   - Must be safe to apply before M2B.
   - Check function dependency/order assumptions against already-applied M2A.

8. Tests
   - Identify missing negative controls or false-positive tests.
   - In particular check:
     * plain 1A observation
     * V1 provider ingest observation
     * revoke
     * re-attest same identity
     * mapping demotion/deletion/re-point
     * competition revoke/re-attest
     * withdrawal/correction latest-version behavior
     * multi-provider Squad State behavior
     * empty history behavior
     * permissions
     * exact preservation of V1 semantics where intended

9. Architecture scope
   - Determine whether all four V2 successors are actually needed now.
   - Look for a smaller, safer design.
   - Check whether model-facing code can accidentally call the V1 loader after
     this PR.

## Output format

Return findings ordered:
- Critical
- High
- Medium
- Low

For every finding include:
- exact file/function
- why it matters
- concrete reproduction or reasoning
- concrete fix
- whether it blocks merge

Then include:
1. "Merge verdict": APPROVE / APPROVE WITH CHANGES / BLOCK
2. "Required tests before merge"
3. "M2B implications"
4. A short statement confirming whether this PR itself enables any production
   ingest or production writes.

Do not modify code. Review only.
