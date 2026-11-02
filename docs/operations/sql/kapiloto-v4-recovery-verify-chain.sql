-- Kapiloto V4 recovery verification for one Sportmonks fixture id
-- (read-only; runbook §J). Not a migration; never place it under
-- supabase/migrations.
--
-- Parameters, set in the SAME execution immediately before this block:
--   select set_config('kapiloto_recovery.provider_fixture_id', '<sportmonks fixture id>', true),
--          set_config('kapiloto_recovery.fixture_id', '<reviewed corrected canonical fixture uuid>', true);
--
-- Raises an exception listing every violation, else reports PASS:
--   1. the provider fixture mapping points to the reviewed fixture;
--   2. exactly one canonical fixture has a live chain (latest version an
--      observation) for this provider fixture id, and it is that fixture;
--   3. that observation is trusted now (sealed to the current attestation
--      generations; manual_override mappings agree);
--   4. the V2 as-of read returns it;
--   5. every other fixture that ever carried this provider fixture id ends in
--      a withdrawal and is invisible to the V2 as-of read;
--   6. no current-version provider-ref conflict remains for it.

do $recovery_verify$
declare
  v_pfid text := nullif(btrim(current_setting('kapiloto_recovery.provider_fixture_id', true)), '');
  v_fixture uuid := nullif(btrim(current_setting('kapiloto_recovery.fixture_id', true)), '')::uuid;
  v_now timestamptz := private.kapiloto_information_clock();
  v_problems text[] := array[]::text[];
  v_mapped uuid;
  v_live uuid[];
  v_latest public.match_ledger_observations%rowtype;
  v_issue text;
  v_visible uuid;
  v_n integer;
  r record;
begin
  if v_pfid is null or v_fixture is null then
    raise exception 'set kapiloto_recovery.provider_fixture_id and fixture_id';
  end if;

  select m.fixture_id into v_mapped
  from public.provider_fixture_mappings m
  where m.provider = 'sportmonks' and m.provider_fixture_id = v_pfid;
  if v_mapped is distinct from v_fixture then
    v_problems := v_problems || format('mapping points to %s, not %s', coalesce(v_mapped::text, 'nothing'), v_fixture);
  end if;

  select coalesce(array_agg(l.fixture_id order by l.fixture_id), array[]::uuid[]) into v_live
  from (
    select distinct on (o.fixture_id) o.fixture_id, o.observation_kind, o.provider_fixture_id
    from public.match_ledger_observations o
    where o.provider = 'sportmonks'
      and o.fixture_id in (select o2.fixture_id from public.match_ledger_observations o2
                           where o2.provider = 'sportmonks' and o2.provider_fixture_id = v_pfid)
    order by o.fixture_id, o.observation_version desc
  ) l
  where l.observation_kind = 'observation' and l.provider_fixture_id = v_pfid;
  if v_live is distinct from array[v_fixture] then
    v_problems := v_problems || format('live chains for this provider fixture id: %s (expected exactly %s)', v_live, v_fixture);
  end if;

  select o.* into v_latest
  from public.match_ledger_observations o
  where o.fixture_id = v_fixture and o.provider = 'sportmonks'
  order by o.observation_version desc
  limit 1;
  if not found or v_latest.observation_kind <> 'observation' then
    v_problems := v_problems || format('fixture %s has no live sportmonks observation', v_fixture);
  else
    v_issue := private.match_ledger_observation_attestation_issue(v_latest.id);
    if v_issue is not null then
      v_problems := v_problems || format('observation %s is not trusted: %s', v_latest.id, v_issue);
    end if;
    v_visible := public.match_ledger_observation_as_of_v2(v_fixture, 'sportmonks', v_now);
    if v_visible is distinct from v_latest.id then
      v_problems := v_problems || format('V2 as-of read of %s returns %s, not %s', v_fixture, coalesce(v_visible::text, 'nothing'), v_latest.id);
    end if;
  end if;

  for r in
    select distinct on (o.fixture_id) o.fixture_id, o.observation_kind, o.observation_version
    from public.match_ledger_observations o
    where o.provider = 'sportmonks' and o.fixture_id <> v_fixture
      and o.fixture_id in (select o2.fixture_id from public.match_ledger_observations o2
                           where o2.provider = 'sportmonks' and o2.provider_fixture_id = v_pfid)
    order by o.fixture_id, o.observation_version desc
  loop
    if r.observation_kind <> 'withdrawal' then
      v_problems := v_problems || format('old fixture %s still ends in an observation (version %s)', r.fixture_id, r.observation_version);
    end if;
    if public.match_ledger_observation_as_of_v2(r.fixture_id, 'sportmonks', v_now) is not null then
      v_problems := v_problems || format('old fixture %s is still visible to the V2 as-of read', r.fixture_id);
    end if;
  end loop;

  select count(*)::int into v_n
  from public.match_ledger_provider_ref_conflicts_v2('sportmonks') c
  where c.provider_fixture_id = v_pfid and c.is_current_version;
  if v_n > 0 then
    v_problems := v_problems || format('%s current-version provider-ref conflict(s)', v_n);
  end if;

  if cardinality(v_problems) > 0 then
    raise exception 'recovery verification FAILED for sportmonks fixture %: %', v_pfid, array_to_string(v_problems, '; ');
  end if;
  raise notice 'recovery verification PASSED for sportmonks fixture %: one trusted live chain on %', v_pfid, v_fixture;
end;
$recovery_verify$;
