-- Kapiloto V4 recovery template: correct one Sportmonks team or competition
-- mapping after its attestation was revoked (runbook §F). Not a migration;
-- never place it under supabase/migrations.
--
-- Parameters, set in the SAME execution immediately before this block:
--   select set_config('kapiloto_recovery.entity_kind', 'team', true),   -- or 'competition'
--          set_config('kapiloto_recovery.provider_ref', '<sportmonks team or league id>', true),
--          set_config('kapiloto_recovery.expected_canonical_id', '<currently mapped canonical uuid>', true),
--          set_config('kapiloto_recovery.canonical_id', '<reviewed canonical uuid>', true);
--
-- Its own execution: the attest RPC must be the first write of a later,
-- separate transaction (provider_identity_begin_change). Takes the provider
-- identity lock exclusive first, as attest/revoke do (V2 ingest takes it
-- shared), then the mapping row. Refuses while the ref is still actively
-- attested (revoke first, runbook §C) and unless the mapping still names the
-- reviewed old canonical id (compare-and-set). Sets the reviewed canonical id
-- and manual_override through the D-057 operator opt-in. Confidence is left as
-- it is: it is never trust. Idempotent: a mapping that already names the
-- reviewed canonical id as manual_override is reported and left unchanged.

do $recovery_mapping$
declare
  v_kind text := nullif(btrim(current_setting('kapiloto_recovery.entity_kind', true)), '');
  v_ref text := nullif(btrim(current_setting('kapiloto_recovery.provider_ref', true)), '');
  v_expected uuid := nullif(btrim(current_setting('kapiloto_recovery.expected_canonical_id', true)), '')::uuid;
  v_canonical uuid := nullif(btrim(current_setting('kapiloto_recovery.canonical_id', true)), '')::uuid;
  v_current uuid;
  v_status text;
  v_attested boolean;
  v_n integer;
begin
  if v_kind is null or v_kind not in ('team', 'competition') or v_ref is null or v_expected is null or v_canonical is null then
    raise exception 'set kapiloto_recovery.entity_kind (team or competition), provider_ref, expected_canonical_id and canonical_id';
  end if;

  perform private.lock_provider_identity('sportmonks', true);

  if v_kind = 'team' then
    select m.team_id, m.mapping_status into v_current, v_status
    from public.provider_team_mappings m
    where m.provider = 'sportmonks' and m.provider_team_id = v_ref
    for update;
    v_attested := exists (
      select 1 from private.provider_team_identity_attestations a
      where a.provider = 'sportmonks' and a.provider_team_id = v_ref);
  else
    select m.competition_id, m.mapping_status into v_current, v_status
    from public.provider_competition_mappings m
    where m.provider = 'sportmonks' and m.provider_competition_id = v_ref
    for update;
    v_attested := exists (
      select 1 from private.provider_competition_identity_attestations a
      where a.provider = 'sportmonks' and a.provider_competition_id = v_ref);
  end if;

  if v_current is null then
    raise exception 'no sportmonks % mapping exists for %', v_kind, v_ref;
  end if;
  if v_current = v_canonical and v_status = 'manual_override' then
    raise notice 'sportmonks % % is already mapped to % as manual_override; nothing changed', v_kind, v_ref, v_canonical;
    return;
  end if;
  if v_attested then
    raise exception 'sportmonks % % is still actively attested; revoke it first (runbook §C)', v_kind, v_ref;
  end if;
  if v_current <> v_expected then
    raise exception 'sportmonks % % changed since review: mapped to %, expected %', v_kind, v_ref, v_current, v_expected;
  end if;

  perform set_config('kapiloto.identity_operator', 'on', true);
  if v_kind = 'team' then
    update public.provider_team_mappings
    set team_id = v_canonical, mapping_status = 'manual_override'
    where provider = 'sportmonks' and provider_team_id = v_ref and team_id = v_expected;
  else
    update public.provider_competition_mappings
    set competition_id = v_canonical, mapping_status = 'manual_override'
    where provider = 'sportmonks' and provider_competition_id = v_ref and competition_id = v_expected;
  end if;
  get diagnostics v_n = row_count;
  perform set_config('kapiloto.identity_operator', 'off', true);
  if v_n <> 1 then
    raise exception 'expected to correct exactly one % mapping row, corrected %', v_kind, v_n;
  end if;
  raise notice 'sportmonks % % mapping corrected: % -> % (manual_override)', v_kind, v_ref, v_expected, v_canonical;
end;
$recovery_mapping$;
