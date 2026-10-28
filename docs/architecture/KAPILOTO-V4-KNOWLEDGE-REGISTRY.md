# Kapiloto V4 Foundation 1B: knowledge registry and prediction registry

Status: implemented (storage, contracts and audit only). Decision D-051.
Migration: `supabase/migrations/20261028132857_kapiloto_v4_knowledge_prediction_registry.sql`.
Contracts: `lib/kapiloto-v4/documents.ts`, `claims.ts`, `prediction-registry.ts`.

Foundation 1A answers "what happened in football matches, and when did
Kapiloto know it?". Foundation 1B answers three more questions:

1. What source material did Kapiloto actually observe?
2. What claims did Kapiloto extract, believe, reject, contradict or later
   verify?
3. What exact information and identity state did a prediction use at the
   moment it was made?

Nothing in V1/V2/V3 reads these tables. No existing table is altered.

## Layers

| Layer | Table | What it is |
| --- | --- | --- |
| Document | `knowledge_documents` | Stable identity of material Kapiloto observed (article URL, provider object, social post). Immutable. |
| Document version | `knowledge_document_versions` | One immutable observation of that material: content hash, bounded text, rights, information time. |
| Claim | `knowledge_claims` | A structured proposition, deduplicated by fingerprint. Prose is a label, never identity. |
| Claim observation | `knowledge_claim_observations` | What one document version appears to say about a claim (supports / contradicts / mentions). |
| Claim relation | `knowledge_claim_relations` | Typed claim-to-claim provenance (derived_from, supports, contradicts, supersedes, refines). |
| Claim resolution | `knowledge_claim_resolutions` + `knowledge_resolution_evidence` | Kapiloto's versioned adjudication of a claim and the exact rows it cited. |
| Prediction snapshot | `prediction_snapshots` + six link tables | The immutable scientific record of one prediction, its exact inputs and its identities. |

The RPCs (service_role only) are `knowledge_record_document_version`,
`knowledge_record_claim`, `knowledge_record_claim_resolution` and
`prediction_record_snapshot`. The as-of reads are
`knowledge_document_version_as_of`, `knowledge_claim_resolutions_as_of` and
`knowledge_claim_support_as_of`. Claim observations and claim relations are
single-row writes; their triggers enforce the rules below.

## Document archive

**Identity vs version.** `identity_key` is derived from the identity fields:
a stable external id (`ext:<provider|platform>:<external_id>`) wins over a
URL (`url:<canonical_url>`), because URLs change. Each version records the
URL as observed by that fetch. A different source kind or attribution for an
existing identity is refused, never silently updated.

**Versioning and dedupe.** Versions are append-only (`version_no` by trigger
under a per-document lock). A fetch is "unchanged" when its fingerprint
equals the latest version's. The fingerprint covers the content hash,
canonical URL, title, author, language, published time and the rights
fields. It excludes retrieval time, raw bytes, discovery data and metadata,
so a refetch of the same page is not a new version, while an edited body,
headline, byline or rights change is. A reverted page is a new version too:
only the latest version is compared.

**Content and size.** `content_sha256` is the SHA-256 of the UTF-8 extracted
text, whether or not the text is kept; when it is kept the database verifies
it. Inline text is limited to 200,000 characters. Raw bytes (HTML, audio,
video) are never stored in Postgres; `raw_content_uri` and
`raw_content_sha256` point at external object storage. Metadata is limited to
8 KB.

**Rights provenance.** Each version records `access_basis` (`public_web`,
`licensed`, `provider_contract`, `user_supplied`, `internal_only`,
`transcript_authorized`, `unknown`, `restricted`) and three permissions:

| Permission | Enforced |
| --- | --- |
| `may_retain_raw` | No `raw_content_uri` without it |
| `may_retain_text` | No `extracted_text` and no verbatim claim-observation `quote` without it |
| `may_expose_excerpts` | Never true when the basis is `unknown` or `restricted` |

"Derived facts only" is both retention flags false: the text is hashed and
claims can be observed (with Kapiloto's own paraphrase), but nothing
verbatim is kept. This is provenance, not a legal-policy engine.

**Discovery hook.** Optional `discovery_channel`, `discovery_query_sha256`,
`discovery_rank` and `discovered_at` keep how a version was found, for a
future research planner. No planner exists.

## Claims

**Epistemic kinds.** `observed_fact` and `reported_expectation` come from
sources. `derived_inference`, `matchup_hypothesis`, `scenario` and
`probability_adjustment` are Kapiloto's own conclusions. The layers cannot
blur:

- a derived claim must cite at least one `derived_from` premise by the end of
  its writing transaction;
- only derived claims can have `derived_from` premises;
- documents can be observed reporting only source claims. A journalist's
  hypothesis is recorded as a `reported_expectation`, not as a Kapiloto
  hypothesis.

**Structure and identity.** A claim has a `claim_type` and `predicate`
(open, versioned vocabularies; `CLAIM_TYPE_REGISTRY` documents the known
ones), any combination of fixture/team/player/coach subjects (at least one),
a structured `object_value`, a `polarity` and a temporal scope.
`claim_fingerprint` is the SHA-256 of every structured dimension. Two claims
are the same claim only when all of them match:

- "Big doubt over the No. 9" and "Striker doubtful for Monday" with the same
  structure are one claim (`existing`);
- doubtful vs out, affirmed vs negated, a different player, or an observed
  fact vs an expectation are different claims.

Claims name surviving canonical players/coaches (D-050).

**Observations.** An observation links one document version to one claim.
The verbatim `quote` is rights-gated, and `quote_found` records whether the
quote occurs in the retained text: a signal for fabrication review, not a
gate. `observed_wording` is Kapiloto's paraphrase. Extractor kind, version,
model and prompt hash are kept. The same extractor cannot record the same
observation twice. An observation is never first seen before its document
version or claim (this guards a backwards clock step), so no as-of read can
count it early.

**Independence.** Syndicated copies are distinct documents but never
independent confirmation. `knowledge_claim_support_as_of` counts each
document once, at its latest visible version, and counts as one source all
documents that share a syndication cluster or identical content, whichever
was labeled first. An unlabeled exact copy also inherits an existing cluster
when it is recorded.

**Relations.** `derived_from`, `supersedes` and `refines` are acyclic:
inserts are serialized per relation type and checked by reachability, so
neither one insert nor two concurrent ones can close a cycle.
`supports`/`contradicts` may be mutual. Relations carry `first_seen_at`, so
a graph read can be cut at a cutoff.

## Resolution lattice

| Status | Meaning | Rule |
| --- | --- | --- |
| `unresolved` | No sufficient adjudication yet | — |
| `verified` | Strongly grounded and accepted | Must cite evidence |
| `verified_degraded` | Likely true; some metadata/provenance incomplete | Must cite evidence and name the gaps in `quality_flags` |
| `quarantined` | Possibly useful, not safe to drive conclusions | — |
| `contradicted` | Later evidence says it is false | Must cite evidence |
| `fabricated` | The source, quote, fact or identity itself was invented | Must cite evidence and use a fabrication reason code |

Missing metadata is never fabrication: `fabricated` accepts only
`source_not_found`, `document_not_found`, `quote_not_in_source`,
`fact_invented` or `identity_invented`. `verified_degraded` exists so true
football information is not dropped because a page lacks a byline or a
published time, which is V3's binary accepted/rejected failure mode.

**Versioning.** Resolutions are append-only per claim (`resolution_version`
by trigger under a per-claim lock) and are never first seen before their
claim. Any transition is allowed; the history is the record. An
`idempotency_key` replay returns `unchanged` only when every adjudication
field and the exact evidence set match; anything else is refused. Example: Monday a report says the striker is doubtful
(`unresolved`); Tuesday a training photo makes it `verified_degraded`;
Wednesday the official squad makes it `verified`.

**Evidence.** `knowledge_resolution_evidence` cites exactly one row per entry
through a real foreign key: a claim observation, a document version, or a
Match Ledger observation, player row or event. There are no generic
polymorphic ids and no opaque evidence arrays. Evidence is sealed to the
writing statement, and a resolution cannot cite a row first seen after the
resolution itself.

## As-of truth

Every as-of read applies `first_seen_at <= cutoff` first, then takes the
latest version:

- `knowledge_document_version_as_of(document, cutoff)`;
- `knowledge_claim_resolutions_as_of(claims, cutoff)`: claims not yet known
  are omitted, and a known claim with no visible resolution is `unresolved`;
- `knowledge_claim_support_as_of(claim, cutoff)`.

Example: on Oct 28 a journalist says the striker will start. The Nov 2 match
is recorded in the ledger at 21:00, and a `post_match` resolution marks the
claim `contradicted` at 21:30, citing the player's bench row. A
reconstruction at Oct 30 still returns `unresolved`; one at Nov 3 returns
`contradicted`.

## Prediction Registry

A prediction snapshot is the experimental/scientific record. It does not
duplicate `kapiloto_analyses` (V3 production output) or
`kapiloto_eval_predictions` (the frozen Research v2 shadow arms). One
fixture can have many snapshots: research rounds, lineup updates,
challengers, shadow runs, backtests and production.

**What is frozen.**

| Group | Fields |
| --- | --- |
| Scientific identity | `idempotency_key`, fixture, optional round game, `purpose` (production, shadow, benchmark, backtest, challenger) |
| Reproducibility | `prediction_protocol_version`, `pipeline_version`, `code_revision`, `model_identifiers`, `prompt_hashes`, `feature_versions`, `derivation_version`, `calibration_version`, `payload_schema_version`, `contract_version`, `input_bundle_sha256`, `output_bundle_sha256` |
| Time | `research_cutoff_at` (information cutoff), `kickoff_at_snapshot`, `generated_at` (pipeline), `first_seen_at` (database clock) |
| Outputs | `outcome` (predicted / abstained), 1/X/2 basis points summing to 10,000, `reliability`, `uncertainty` (`kapiloto-uncertainty-v1`), and a bounded `payload` with formation estimate, lineup estimate, scenarios, tactical state, matchup hypotheses, recommendation and rationale |
| Exact inputs | `prediction_ledger_inputs`, `prediction_document_inputs`, `prediction_claim_inputs` (claim plus the exact resolution version and its status), `prediction_claim_observation_inputs`, `prediction_reference_inputs` (market quotes, market snapshots, structured snapshots, fact snapshots, legacy V3 ids) |
| Identity | `prediction_identity_bindings` |

The payload stores auditable rationale artifacts only, never hidden reasoning
traces. Unknown payload sections are refused.

**Immutability.** Snapshots, links and bindings are never updated or
deleted. Later truth, merges, source downgrades, model changes and market
moves go into separate append-only structures (claim resolutions now;
evaluation tables later).

**Idempotency.** `idempotency_key` identifies one intended write. Replaying
it with identical content returns `unchanged`; reusing it for anything else
is refused. Snapshots are never deduplicated by content: two different
models (or two runs) with identical probabilities are two snapshots.

**Bundle integrity.** The RPC hashes a canonical input bundle (typed,
defaulted, sorted). A commit-time check recomputes it from the link rows, so
a stored hash always describes exactly the linked inputs. Links are sealed to
the statement that wrote the snapshot. For fixture-scoped references,
`referenced_row_sha256` fingerprints the referenced row as it was when
linked, so a later edit to a mutable source table (such as V1
`fixture_market_snapshots`) is detectable.

## Anti-leakage guarantees

`prediction_record_snapshot` (and any direct insert) refuses a link whose
information time is after the prediction cutoff. Two strengths of guarantee
apply.

**Strong: V4 information time (`first_seen_at`).** These inputs carry a
`first_seen_at` stamped by `private.kapiloto_information_clock()`
(`clock_timestamp()` when the row is written). A writer cannot supply or
backdate it, and long transactions cannot create early knowledge.

| Input | Refused when |
| --- | --- |
| Match Ledger observation | `first_seen_at > cutoff` |
| Document version | `first_seen_at > cutoff` |
| Claim | claim `first_seen_at > cutoff` |
| Claim resolution | resolution `first_seen_at > cutoff`, or it belongs to another claim |
| Claim observation | `first_seen_at > cutoff` |

**Weaker: legacy snapshot timing guard.** Pre-V4 tables have no
`first_seen_at`. They are checked against every timestamp they have, as a
fail-closed bound, and must belong to the predicted fixture.

| Input | Refused when | Timestamp semantics |
| --- | --- | --- |
| Market quote (shadow) | `captured_at > cutoff`, or another fixture | Trigger-forced to `now()`: cannot be supplied, immutable, but it is transaction-start time |
| Market snapshot (V1) | `captured_at > cutoff` or `created_at > cutoff`, or another fixture | `captured_at` is writer supplied (often a provider time). `created_at` is `DEFAULT now()`: transaction-start time, writer-suppliable, not trigger-stamped. The table is mutable; later edits are detectable through `referenced_row_sha256` |
| Structured snapshot | `research_cutoff_at`, `computed_at` or `created_at > cutoff`, or another fixture | `computed_at`/`created_at` are `DEFAULT now()`: transaction-start time, writer-suppliable. The table is immutable after insert |
| Fact snapshot | `captured_at` or `source_observed_at > cutoff`, or another fixture | `captured_at` is `DEFAULT now()` (writer-suppliable); `source_observed_at` is writer supplied |

Residual limitation of the legacy guard:

- A writer that explicitly supplies backdated timestamps is not caught.
- A transaction that began before the cutoff and inserted a snapshot after it
  carries the earlier transaction-start time.

Removing these would mean changing V1/V3 runtime tables (stamping triggers),
which 1B deliberately does not do. Every V4-native input uses true
`first_seen_at` semantics, and future V4 inputs must too.

The snapshot itself also requires:

- cutoff ≤ kickoff, checked against the canonical fixture kickoff (actual
  when known), not only the writer-supplied `kickoff_at_snapshot`, so a
  prediction can never link its own match's result;
- cutoff ≤ recording time;
- `generated_at` ≥ cutoff;
- the round game, if given, belongs to the predicted fixture.

A writer cannot widen what a prediction may see:

- `research_cutoff_at` is bounded by the database recording time and the
  canonical fixture kickoff;
- `kickoff_at_snapshot` can only tighten the bound;
- every reference is matched to its fixture through the referenced row
  itself.

Choosing an earlier cutoff only excludes inputs. The canonical kickoff is as
current as the fixture sync; a match brought forward but not yet synced is
the remaining edge.

A backtest recorded weeks later is checked against its own cutoff, not its
recording time. The checks run in the database; the TypeScript validator only
reports issues earlier.

Legacy V3 references (`v3_research_run`, `v3_analysis`, `v3_evidence`) are
soft provenance ids. They are not validated and are never evidence that an
input was known. Anything a prediction used must also be linked through V4
rows.

## Identity snapshot semantics

1A makes merges retroactive in model-facing reads (D-050), which is right for
training but means a later backtest could know a merge the live model did
not. 1B freezes identity per prediction:

- a binding records the entity type, the canonical id the prediction used,
  the raw observed id when it differed, a role, context team and provider id;
- the bound id must be an active canonical entity when the prediction is
  recorded (under the shared identity lock), so the binding proves which ids
  the model treated as separate people;
- bindings are immutable.

Example: on Oct 30 the live model binds A (doubtful starter) and B (rotation
option) as two players. On Nov 6 A is merged into B. The registry still shows
A and B separately, and the frozen ledger inputs are unchanged. Today's
`match_ledger_provider_player_matches_as_of(B)` returns both matches under
B. A new prediction must bind B; it may record A as the observed id. A
backtest's bindings therefore record the identity the backtest used, which
keeps live and backtest identity distinguishable.

## Source reliability groundwork (not implemented)

Every claim observation keeps the document (domain, publisher, source
account), the version (author/byline, published time), the claim type and
fixture, and its information time. Claim resolution history provides the
eventual truth. A later reliability model can compute accuracy by
publisher/journalist/account, claim type and time before kickoff. No scores
are stored now.

## Post-match truth flow

1. A Match Ledger observation of the finished match is recorded (1A).
2. A `ledger_truth` / `post_match` resolver appends a resolution to each
   relevant claim (for example, verified when the player started,
   contradicted when he did not), citing ledger player or event rows.
3. As-of reads before that resolution's `first_seen_at` are unaffected.
4. Predictions keep the resolution version they used; scoring against truth
   is a later evaluation layer.

## Relationship to V3 evidence

V3 `kapiloto_evidence` is publication-era evidence tied to one V3 analysis
(binary accepted/rejected). The V4 archive is cross-run research memory and
truth history. Nothing in V3 is repurposed, migrated or backfilled:

- V3 ids appear only as soft provenance (`knowledge_claim_observations.v3_evidence_id`,
  V3 reference kinds in `prediction_reference_inputs`).
- There are deliberately no foreign keys into V3 research tables. Such keys
  would restrict V3's row lifecycle, V3 timestamps are writer-supplied and
  could not back a fail-closed check, and V3 persistence must stay untouched
  (guarded by `lib/kapiloto/research-v3-persistence.test.ts`).
- Foreign keys do point at shared fixture-level tables (`fixtures`,
  `round_games`, `fixture_market_snapshots`, `fixture_structured_snapshots`,
  `fixture_fact_snapshots`). No V3 runtime path deletes those rows.
- Market quotes live in the Research v2 shadow-evaluation tables, which stay
  out of the shared generated types (guarded by
  `lib/evaluation/shadow-isolation.test.ts`). `market_quote_id` therefore has
  no foreign key; the trigger refuses an unknown quote id. Quotes are
  immutable, so a linked quote cannot disappear.

## Concurrency

All locks are transaction-scoped advisory locks under READ COMMITTED:

- per document (versions), per claim (resolutions), per relation type
  (acyclic graph), and per prediction idempotency key;
- canonical-identity locks are shared for claim and binding writes, so they
  serialize against merges and mapping writes (1A);
- claim creation relies on the unique fingerprint.

## Not in Foundation 1B

Source reliability scoring, journalist models, availability HMM, expected
lineups, formation probabilities, tactical state or embeddings, matchup
engine, VOI planner, contextual bandit, research query planner, Sol prompt
changes, model calls, video processing, provider ingestion, Match Ledger
backfill, post-match calibration, champion/challenger promotion, Toto ticket
optimization, UI, and production activation.
