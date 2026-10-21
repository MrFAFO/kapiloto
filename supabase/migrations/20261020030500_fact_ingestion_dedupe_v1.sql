-- Make raw fact source fingerprints usable as a PostgREST conflict target.
-- PostgreSQL unique constraints already permit multiple NULLs, so the partial
-- unique index is not required.

drop index if exists public.fixture_fact_snapshots_source_fingerprint_uq;

alter table public.fixture_fact_snapshots
  add constraint fixture_fact_snapshots_source_fingerprint_key
  unique (fixture_id, provenance_type, source_fingerprint);
