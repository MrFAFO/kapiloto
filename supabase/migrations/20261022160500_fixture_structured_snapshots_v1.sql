-- Frozen structured football features used by Kapiloto before Sol research.
-- Each row is immutable and contains both the compact derived features and
-- the normalized provider inputs needed to replay the calculation.

create table public.fixture_structured_snapshots (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null
    references public.fixtures(id) on delete cascade,
  feature_version text not null
    check (char_length(trim(feature_version)) between 1 and 80),
  research_cutoff_at timestamptz not null,
  computed_at timestamptz not null default now(),
  features jsonb not null,
  input_payload jsonb not null,
  sha256 text not null
    check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check (jsonb_typeof(features) = 'object'),
  check (jsonb_typeof(input_payload) = 'object'),
  unique (fixture_id, feature_version, research_cutoff_at)
);

create index fixture_structured_snapshots_fixture_cutoff_idx
  on public.fixture_structured_snapshots (
    fixture_id,
    research_cutoff_at desc
  );

create index fixture_structured_snapshots_version_cutoff_idx
  on public.fixture_structured_snapshots (
    feature_version,
    research_cutoff_at desc
  );

create trigger fixture_structured_snapshots_immutable
before update or delete on public.fixture_structured_snapshots
for each row execute function private.reject_fixture_fact_change();

-- Server-side research infrastructure only. No end-user Data API policy is
-- created; service_role continues to bypass RLS for ingestion/research.
alter table public.fixture_structured_snapshots enable row level security;
revoke all on table public.fixture_structured_snapshots
from public, anon, authenticated;

comment on table public.fixture_structured_snapshots is
  'Immutable cutoff-frozen provider inputs plus deterministic football features used to build Kapiloto Fixture Card v3.';

comment on column public.fixture_structured_snapshots.input_payload is
  'Normalized provider facts used by the deterministic feature calculation; retained for replay/audit.';

comment on column public.fixture_structured_snapshots.sha256 is
  'Canonical SHA-256 over fixture identity, cutoff, feature version, features and normalized input payload.';
