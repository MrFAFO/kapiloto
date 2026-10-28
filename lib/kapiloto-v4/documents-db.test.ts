import assert from "node:assert/strict";
import test from "node:test";

import { buildDocumentVersionPayload, documentContentSha256, validateDocumentVersion } from "./documents";
import { createLedgerDatabase, setClock } from "./test-support/ledger-fixtures";
import { ARTICLE_TEXT, articleInput, recordDocument } from "./test-support/knowledge-fixtures";

const OCT_28 = "2026-10-28T08:00:30.000Z";
const OCT_29 = "2026-10-29T08:00:30.000Z";
const OCT_30 = "2026-10-30T08:00:30.000Z";

const versionAsOf = async (db: Awaited<ReturnType<typeof createLedgerDatabase>>, documentId: string, cutoff: string) =>
  (await db.query<{ id: string | null }>("select public.knowledge_document_version_as_of($1, $2) as id", [documentId, cutoff])).rows[0].id;

test("a document is versioned append-only: identical re-fetch is a no-op, an edit is a new version", async () => {
  const db = await createLedgerDatabase();
  const article = articleInput();
  const first = await recordDocument(db, article, OCT_28);
  assert.deepEqual([first.status, first.version_no], ["recorded", 1]);

  // Re-fetching identical content later (new retrieval time, new raw bytes,
  // new discovery data) does not create a content change.
  const refetch = await recordDocument(
    db,
    { ...article, retrievedAt: "2026-10-29T08:00:00.000Z", rawContentSha256: "a".repeat(64), discovery: { channel: "feed" } },
    OCT_29,
  );
  assert.deepEqual([refetch.status, refetch.document_version_id], ["unchanged", first.document_version_id]);

  // The page is edited: new immutable version, old version intact.
  const editedText = `${ARTICLE_TEXT} Update: the striker trained normally on Wednesday.`;
  const edited = await recordDocument(db, { ...article, extractedText: editedText, retrievedAt: "2026-10-30T08:00:00.000Z" }, OCT_30);
  assert.deepEqual([edited.status, edited.version_no, edited.document_id], ["recorded", 2, first.document_id]);
  // A changed headline alone is a change too.
  const retitled = await recordDocument(db, { ...article, extractedText: editedText, title: "Striker fit after all", retrievedAt: "2026-10-30T09:00:00.000Z" }, "2026-10-30T09:00:30.000Z");
  assert.equal(retitled.version_no, 3);

  const stored = await db.query<{ version_no: number; extracted_text: string; content_sha256: string }>(
    "select version_no, extracted_text, content_sha256 from public.knowledge_document_versions where document_id = $1 order by version_no",
    [first.document_id],
  );
  assert.equal(stored.rows[0].extracted_text, ARTICLE_TEXT);
  assert.equal(stored.rows[0].content_sha256, documentContentSha256(ARTICLE_TEXT));
  assert.equal(stored.rows[1].content_sha256, documentContentSha256(editedText));
  await assert.rejects(db.query("update public.knowledge_document_versions set title = 'x'"), /immutable/);
  await assert.rejects(db.query("delete from public.knowledge_document_versions"), /immutable/);
  await assert.rejects(db.query("update public.knowledge_documents set publisher = 'x'"), /immutable/);

  // A later version is invisible to an earlier cutoff.
  assert.equal(await versionAsOf(db, first.document_id, "2026-10-28T07:00:00.000Z"), null);
  assert.equal(await versionAsOf(db, first.document_id, "2026-10-29T23:59:00.000Z"), first.document_version_id);
  assert.equal(await versionAsOf(db, first.document_id, "2026-10-30T08:30:00.000Z"), edited.document_version_id);

  // Writers cannot choose information time, version numbers or bypass dedupe.
  await setClock(db, "2026-10-31T00:00:00.000Z");
  const direct = await db.query<{ version_no: number; first_seen_at: Date }>(
    `insert into public.knowledge_document_versions
       (contract_version, document_id, version_no, retrieved_at, first_seen_at, content_sha256,
        extraction_version, access_basis, ingest_version, version_fingerprint)
     values ('kapiloto-document-version-v1', $1, 99, '2026-10-30T23:59:00Z', '2000-01-01', $2,
        'x', 'public_web', 'x', $3)
     returning version_no, first_seen_at`,
    [first.document_id, documentContentSha256("different body"), "0".repeat(64)],
  );
  assert.equal(direct.rows[0].version_no, 4);
  assert.equal(direct.rows[0].first_seen_at.toISOString(), "2026-10-31T00:00:00.000Z");
  await db.close();
});

test("document identity prefers stable external ids, and syndicated copies stay distinct documents", async () => {
  const db = await createLedgerDatabase();
  // A provider object keeps its identity when its URL changes.
  const provider = articleInput({ sourceKind: "provider_response", provider: "sportmonks", externalId: "fixtures/19112233", domain: null, publisher: null });
  const v1 = await recordDocument(db, provider, OCT_28);
  const moved = await recordDocument(db, { ...provider, canonicalUrl: "https://api.example.com/v3/fixtures/19112233", extractedText: `${ARTICLE_TEXT} (refreshed)` }, OCT_29);
  assert.equal(moved.document_id, v1.document_id);
  assert.equal(moved.version_no, 2);
  // The same identity cannot change its source kind.
  await assert.rejects(recordDocument(db, { ...provider, sourceKind: "news_article" }, OCT_30), /already exists with a different identity/);

  // A wire story republished on two sites: two documents, one cluster.
  const wire = await recordDocument(db, articleInput({ syndicationCluster: "wire:ifa-2026-10-28-01" }), OCT_28);
  const copy = await recordDocument(db, articleInput({ canonicalUrl: "https://www.one.co.il/article/77", domain: "one.co.il", publisher: "ONE" }), OCT_29);
  assert.notEqual(copy.document_id, wire.document_id);
  const clusters = await db.query<{ syndication_cluster: string }>(
    "select syndication_cluster from public.knowledge_document_versions where id = any($1) order by first_seen_at",
    [[wire.document_version_id, copy.document_version_id]],
  );
  // The unlabeled exact copy inherits the wire cluster.
  assert.deepEqual(clusters.rows.map((row) => row.syndication_cluster), ["wire:ifa-2026-10-28-01", "wire:ifa-2026-10-28-01"]);
  await db.close();
});

test("rights provenance is enforced: no text, raw pointer or excerpt exposure beyond what rights allow", async () => {
  const db = await createLedgerDatabase();
  // Derived facts only: the text is hashed but not retained.
  const restricted = articleInput({ rights: { accessBasis: "restricted", mayRetainRaw: false, mayRetainText: false, mayExposeExcerpts: false } });
  const payload = buildDocumentVersionPayload(restricted);
  assert.equal(payload.extracted_text, null);
  assert.equal(payload.content_sha256, documentContentSha256(ARTICLE_TEXT));
  const recorded = await recordDocument(db, restricted, OCT_28);
  const row = await db.query("select extracted_text, raw_content_uri from public.knowledge_document_versions where id = $1", [recorded.document_version_id]);
  assert.deepEqual(row.rows, [{ extracted_text: null, raw_content_uri: null }]);

  // Direct payloads that exceed the rights are refused by the database.
  const raw = buildDocumentVersionPayload(articleInput());
  await assert.rejects(recordDocument(db, { ...raw, may_retain_text: false }, OCT_28), /check constraint/);
  await assert.rejects(recordDocument(db, { ...raw, raw_content_uri: "s3://kapiloto-raw/a.html" }, OCT_28), /check constraint/);
  await assert.rejects(recordDocument(db, { ...raw, access_basis: "unknown", may_expose_excerpts: true }, OCT_28), /check constraint/);
  // A retained text must match its hash.
  await assert.rejects(recordDocument(db, { ...raw, content_sha256: "b".repeat(64) }, OCT_28), /does not match the retained extracted text/);
  // Oversized inline text is refused (long material goes to object storage).
  await assert.rejects(
    recordDocument(db, { ...raw, extracted_text: "x".repeat(200_001), content_sha256: documentContentSha256("x".repeat(200_001)) }, OCT_28),
    /check constraint/,
  );
  // Licensed raw media: pointer and hash only, never bytes in Postgres.
  const video = articleInput({
    sourceKind: "video_transcript",
    platform: "youtube",
    externalId: "abc123",
    rawContentUri: "s3://kapiloto-raw/youtube/abc123.mp4",
    rawContentSha256: "c".repeat(64),
    rights: { accessBasis: "transcript_authorized", mayRetainRaw: true, mayRetainText: true, mayExposeExcerpts: false },
  });
  assert.deepEqual(validateDocumentVersion(video), []);
  assert.equal((await recordDocument(db, video, OCT_28)).status, "recorded");
  assert.ok(validateDocumentVersion({ ...video, rights: { ...video.rights, mayRetainRaw: false } }).length > 0);
  await db.close();
});
