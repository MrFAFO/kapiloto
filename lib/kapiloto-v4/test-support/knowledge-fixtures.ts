import type { PGlite } from "@electric-sql/pglite";

import {
  buildClaimPayload,
  buildClaimResolutionPayload,
  type ClaimInput,
  type ClaimResolutionInput,
  type ObservationRelationship,
  type RecordClaimResolutionResult,
  type RecordClaimResult,
} from "../claims";
import {
  buildDocumentVersionPayload,
  type DocumentVersionInput,
  type RecordDocumentVersionResult,
} from "../documents";
import {
  buildPredictionSnapshotPayload,
  type PredictionSnapshotInput,
  type RecordPredictionSnapshotResult,
} from "../prediction-registry";
import { CLAIM_OBSERVATION_CONTRACT_VERSION } from "../versions";
import { setClock } from "./ledger-fixtures";

export const ARTICLE_TEXT =
  "Coach confirms the striker is doubtful for Monday after limping out of training. " +
  "The midfielder is expected to start in a 5-3-2.";

let documentCounter = 0;

/** A public-web news article fetched at retrievedAt (text retained). */
export function articleInput(overrides: Partial<DocumentVersionInput> = {}): DocumentVersionInput {
  documentCounter += 1;
  return {
    sourceKind: "news_article",
    canonicalUrl: `https://www.sport5.co.il/articles/${documentCounter}`,
    domain: "sport5.co.il",
    publisher: "Sport5",
    title: "Striker doubtful for Monday",
    author: "Reporter A",
    languageCode: "he",
    publishedAt: "2026-10-28T07:00:00.000Z",
    retrievedAt: "2026-10-28T08:00:00.000Z",
    extractedText: ARTICLE_TEXT,
    extractionVersion: "extract-test-v1",
    rights: { accessBasis: "public_web", mayRetainRaw: false, mayRetainText: true, mayExposeExcerpts: false },
    ingestVersion: "knowledge-test-v1",
    ...overrides,
  };
}

export async function recordDocument(
  db: PGlite,
  input: DocumentVersionInput | Record<string, unknown>,
  clock: string,
): Promise<RecordDocumentVersionResult> {
  await setClock(db, clock);
  const payload = "contract_version" in input ? input : buildDocumentVersionPayload(input as DocumentVersionInput);
  const result = await db.query<{ result: RecordDocumentVersionResult }>(
    "select public.knowledge_record_document_version($1::jsonb) as result",
    [JSON.stringify(payload)],
  );
  return result.rows[0].result;
}

export async function recordClaim(db: PGlite, input: ClaimInput, clock: string): Promise<RecordClaimResult> {
  await setClock(db, clock);
  const result = await db.query<{ result: RecordClaimResult }>(
    "select public.knowledge_record_claim($1::jsonb) as result",
    [JSON.stringify(buildClaimPayload(input))],
  );
  return result.rows[0].result;
}

/** Claim observations are single-row writes; triggers enforce the rules. */
export async function addObservation(
  db: PGlite,
  input: {
    claimId: string;
    documentVersionId: string;
    relationship: ObservationRelationship;
    quote?: string | null;
    extractorVersion?: string;
    v3EvidenceId?: string | null;
  },
  clock: string,
): Promise<{ id: string; independence_key: string; quote_found: boolean | null; first_seen_at: Date }> {
  await setClock(db, clock);
  const result = await db.query<{ id: string; independence_key: string; quote_found: boolean | null; first_seen_at: Date }>(
    `insert into public.knowledge_claim_observations
       (contract_version, claim_id, document_version_id, document_id, relationship, quote,
        extracted_at, extractor_kind, extractor_version, independence_key, v3_evidence_id)
     values ($1, $2, $3, null, $4, $5, $6, 'model', $7, null, $8)
     returning id, independence_key, quote_found, first_seen_at`,
    [
      CLAIM_OBSERVATION_CONTRACT_VERSION,
      input.claimId,
      input.documentVersionId,
      input.relationship,
      input.quote ?? null,
      clock,
      input.extractorVersion ?? "extractor-test-v1",
      input.v3EvidenceId ?? null,
    ],
  );
  return result.rows[0];
}

export async function recordResolution(
  db: PGlite,
  input: ClaimResolutionInput | Record<string, unknown>,
  clock: string,
): Promise<RecordClaimResolutionResult> {
  await setClock(db, clock);
  const payload = "contract_version" in input ? input : buildClaimResolutionPayload(input as ClaimResolutionInput);
  const result = await db.query<{ result: RecordClaimResolutionResult }>(
    "select public.knowledge_record_claim_resolution($1::jsonb) as result",
    [JSON.stringify(payload)],
  );
  return result.rows[0].result;
}

export async function recordPrediction(
  db: PGlite,
  input: PredictionSnapshotInput | Record<string, unknown>,
  clock: string,
): Promise<RecordPredictionSnapshotResult> {
  await setClock(db, clock);
  const payload = "contract_version" in input ? input : buildPredictionSnapshotPayload(input as PredictionSnapshotInput);
  const result = await db.query<{ result: RecordPredictionSnapshotResult }>(
    "select public.prediction_record_snapshot($1::jsonb) as result",
    [JSON.stringify(payload)],
  );
  return result.rows[0].result;
}

let predictionCounter = 0;

export function basePrediction(
  fixtureId: string,
  overrides: Partial<PredictionSnapshotInput> = {},
): PredictionSnapshotInput {
  predictionCounter += 1;
  return {
    idempotencyKey: `prediction-test-${predictionCounter}`,
    fixtureId,
    purpose: "shadow",
    predictionProtocolVersion: "kapiloto-v4-test-protocol",
    pipelineVersion: "pipeline-test-v1",
    codeRevision: "0123456789abcdef0123456789abcdef01234567",
    modelIdentifiers: { probability: "model-test-v1" },
    promptHashes: {},
    featureVersions: { form: "form-v1" },
    researchCutoffAt: "2026-10-30T12:00:00.000Z",
    kickoffAtSnapshot: "2026-11-02T18:00:00.000Z",
    generatedAt: "2026-10-30T12:05:00.000Z",
    outcome: "predicted",
    probabilities: { p1Bp: 4600, pXBp: 2800, p2Bp: 2600 },
    reliability: 0.62,
    uncertainty: { contract_version: "kapiloto-uncertainty-v1", total: 0.4, lineup: 0.15 },
    payloadSchemaVersion: "prediction-payload-test-v1",
    payload: { lineup_estimate: { home: [] }, rationale: { summary: "test" } },
    inputs: {},
    ...overrides,
  };
}
