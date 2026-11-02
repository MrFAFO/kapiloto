-- Kapiloto V4 recovery template: remove the provider fixture mapping of a
-- withdrawn chain that must move to a DIFFERENT canonical fixture
-- (runbook §E2/§E3). Not a migration; never place it under supabase/migrations.
--
-- Parameters, set in the SAME execution immediately before this block:
--   select set_config('kapiloto_recovery.provider_fixture_id', '<sportmonks fixture id>', true),
--          set_config('kapiloto_recovery.fixture_id', '<canonical fixture uuid it is wrongly mapped to>', true);
--
-- Use it only when the chain must leave its fixture: it attached to the
-- canonical fixture of a different real match (§E2), or it minted a fixture
-- while another canonical fixture already represents the real match (§E3,
-- team incidents only). A minted fixture that can be corrected in place keeps
-- its mapping (§E1).
--
-- Takes the V2 ingest lock order (provider-fixture advisory lock, team-pair
-- advisory lock, then the mapping row) and deletes exactly the one mapping row
-- that names both the provider fixture id and the reviewed canonical fixture
-- (compare-and-set), only after that chain ends in a withdrawal. The mint row
-- and every ledger row stay untouched. Idempotent: an absent mapping is
-- reported and left unchanged.

do $recovery_unmap$
declare
  v_pfid text := nullif(btrim(current_setting('kapiloto_recovery.provider_fixture_id', true)), '');
  v_fixture uuid := nullif(btrim(current_setting('kapiloto_recovery.fixture_id', true)), '')::uuid;
  v_row public.fixtures%rowtype;
  v_mapped uuid;
  v_latest public.match_ledger_observations%rowtype;
  v_n integer;
begin
  if v_pfid is null or v_fixture is null then
    raise exception 'set kapiloto_recovery.provider_fixture_id and fixture_id';
  end if;
  perform private.kapiloto_require_read_committed('recovery fixture unmap');

  perform pg_advisory_xact_lock(hashtextextended('kapiloto_match_ledger_provider_fixture:sportmonks:' || v_pfid, 0));
  select f.* into v_row from public.fixtures f where f.id = v_fixture;
  if found then
    perform pg_advisory_xact_lock(hashtextextended(
      'kapiloto_canonical_fixture_pair:' || least(v_row.home_team_id, v_row.away_team_id)::text || ':' || greatest(v_row.home_team_id, v_row.away_team_id)::text, 0));
  end if;

  select m.fixture_id into v_mapped
  from public.provider_fixture_mappings m
  where m.provider = 'sportmonks' and m.provider_fixture_id = v_pfid
  for update;
  if v_mapped is null then
    raise notice 'sportmonks fixture % has no fixture mapping; nothing changed', v_pfid;
    return;
  end if;
  if v_mapped <> v_fixture then
    raise exception 'sportmonks fixture % is mapped to fixture %, not the reviewed %', v_pfid, v_mapped, v_fixture;
  end if;

  select o.* into v_latest
  from public.match_ledger_observations o
  where o.fixture_id = v_fixture and o.provider = 'sportmonks'
  order by o.observation_version desc
  limit 1;
  if not found or v_latest.observation_kind <> 'withdrawal' or v_latest.provider_fixture_id <> v_pfid then
    raise exception 'the sportmonks chain of fixture % for % is not withdrawn; withdraw it first (runbook §D)', v_fixture, v_pfid;
  end if;

  delete from public.provider_fixture_mappings
  where provider = 'sportmonks' and provider_fixture_id = v_pfid and fixture_id = v_fixture;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'expected to remove exactly one fixture mapping row, removed %', v_n;
  end if;
  raise notice 'removed the mapping of sportmonks fixture % to withdrawn fixture %', v_pfid, v_fixture;
end;
$recovery_unmap$;
