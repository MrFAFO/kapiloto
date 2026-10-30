-- Kapiloto V4 Stage 0 containment: V3 identity mapping write guard and
-- historical ingest pause (D-057).
--
-- On 2026-10-30 the five verified Sportmonks competition mappings were
-- promoted to manual_override at about 20:34:57 UTC; by 20:45:05 UTC V3's
-- structured sync (daily cron and the 15-minute precompute job) had upserted
-- three of them back to confirmed. The same upsert re-points identities and
-- raises a name-matched mapping to confidence 1 once V3 sees its own fixture
-- mapping again, so mapping_status and mapping_confidence cannot carry
-- historical-ingest trust while automated writers may update them.
--
-- Additive. The applied migrations, including 1E-A2-A, are not modified.
--
-- 1. Existing rows are frozen against automated UPDATE in the three V3
--    identity mapping tables: every Sportmonks row, and every manual_override
--    row of any provider. The UPDATE is skipped (the trigger returns NULL),
--    so a V3 upsert still succeeds and V3 keeps running; only the mutation of
--    identity, status, confidence and metadata is suppressed. INSERT of a
--    missing mapping and DELETE (including foreign-key cascades) are
--    unchanged. An operator opts in per transaction:
--      begin; set local kapiloto.identity_operator = 'on'; update ...; commit;
--    PostgREST callers cannot set that parameter.
-- 2. public.match_ledger_ingest_provider_fixture is not executable by
--    service_role until historical-ingest trust no longer depends on columns
--    automated writers controlled (Stage 1 attestations).

create or replace function private.guard_v3_identity_mapping_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('kapiloto.identity_operator', true) = 'on' then
    return new;
  end if;
  -- Skip the row: no error, nothing changes.
  return null;
end;
$$;

comment on function private.guard_v3_identity_mapping_update() is
  'BEFORE UPDATE guard on V3 identity mapping tables (D-057): skips automated updates of Sportmonks and manual_override rows unless the transaction set kapiloto.identity_operator = on.';

create trigger provider_team_mappings_identity_guard
before update on public.provider_team_mappings
for each row
when (old.provider = 'sportmonks' or old.mapping_status = 'manual_override')
execute function private.guard_v3_identity_mapping_update();

create trigger provider_competition_mappings_identity_guard
before update on public.provider_competition_mappings
for each row
when (old.provider = 'sportmonks' or old.mapping_status = 'manual_override')
execute function private.guard_v3_identity_mapping_update();

create trigger provider_fixture_mappings_identity_guard
before update on public.provider_fixture_mappings
for each row
when (old.provider = 'sportmonks' or old.mapping_status = 'manual_override')
execute function private.guard_v3_identity_mapping_update();

-- Trigger functions need no EXECUTE grant to fire for the writing role.
revoke all on function private.guard_v3_identity_mapping_update() from public, anon, authenticated;

-- Historical ingest pause (re-granted by Stage 1).
revoke execute on function public.match_ledger_ingest_provider_fixture(jsonb) from service_role;
