-- Winner 16 round 264301: guarded correction of the swapped field scores (D-062).
--
-- CONTINGENCY ONLY, NOT APPLIED. The normal repair is the fixed live sync:
-- deploy, then run /api/internal/cron/round-sync while Telesport's current
-- Winner 16 page still shows round 264301. Use this block only when that is no
-- longer possible (Telesport has moved to the next round, or a newer round is
-- open in Kapiloto so live sync no longer selects 264301), and only after a
-- separate review and an explicit operator decision. See
-- docs/operations/2026-11-03-winner16-264301-settlement-orientation.md.
--
-- Evidence, one row per game, reviewed on 2026-11-03:
-- - home/away team: the Telesport names, which are the canonical team names
--   the round import created;
-- - stored score: what the pre-fix sync wrote (the away-first Telesport text
--   read home first), as reported from production for games 1, 7, 10, 12, 15
--   and reproduced for all 16 by the old parser on the same page;
-- - score and marker: Telesport's structured score_1/score_2 (home/away) and
--   its 1/X/2 result;
-- - 365Scores: the exact event and its regular-time score.
--
-- The block applies the normal settlement rule to that evidence: Telesport's
-- home/away score must equal 365Scores' score and the marker must equal the
-- outcome of that score; otherwise it stops. Per game, compare-and-set:
-- - already exactly correct and settled: skipped (so the block is idempotent);
-- - finished, under review, no pool outcome, and holding either the stored
--   swapped score or the corrected score: settled through
--   public.toto_apply_game_state_v1, which also rewrites the canonical
--   fixture, ticket and consensus results and the round status;
-- - anything else, or a team identity that differs: the whole block aborts
--   with no effect.
-- It finally requires the round itself to be settled.
--
-- Run it alone, in one execution. It contains no DDL and changes no privilege.

do $correction$
declare
  v_round_id uuid;
  v_evidence record;
  v_game record;
  v_applied integer := 0;
  v_skipped integer := 0;
  v_round_status text;
begin
  select r.id
    into v_round_id
  from public.rounds r
  where r.source = 'telesport-winner16'
    and r.external_round_number = '264301'
  for update;

  if v_round_id is null then
    raise exception 'w16_264301_round_not_found';
  end if;

  for v_evidence in
    select *
    from (
      values
        (1, 'הפועל תל אביב', 'מכבי חיפה', 1, 2, 2, 1, '1', '4739299', 2, 1),
        (2, 'מכבי נתניה', 'הפועל ירושלים', 1, 1, 1, 1, 'X', '4739301', 1, 1),
        (3, 'בני סכנין', 'עירוני טבריה', 1, 1, 1, 1, 'X', '4739298', 1, 1),
        (4, 'הפועל חיפה', 'הפועל פתח תקווה', 1, 2, 2, 1, '1', '4739296', 2, 1),
        (5, 'מ.ס אשדוד', 'בני יהודה', 1, 3, 3, 1, '1', '4739086', 3, 1),
        (6, 'מכבי יפו', 'הפועל כפר סבא', 3, 0, 0, 3, '2', '4739083', 0, 3),
        (7, 'ליברפול', 'ארסנל', 1, 0, 0, 1, '2', '4742014', 0, 1),
        (8, 'קובנטרי', 'סנדרלנד', 1, 3, 3, 1, '1', '4742016', 3, 1),
        (9, 'האל', 'איפסוויץ''', 2, 2, 2, 2, 'X', '4742015', 2, 2),
        (10, 'בורנמות''', 'לידס', 0, 2, 2, 0, '1', '4742020', 2, 0),
        (11, 'ראיו ואייקאנו', 'סלטה ויגו', 0, 3, 3, 0, '1', '4750803', 3, 0),
        (12, 'חטאפה', 'סביליה', 1, 3, 3, 1, '1', '4750806', 3, 1),
        (13, 'אלצ''ה', 'ולנסיה', 1, 0, 0, 1, '2', '4750808', 0, 1),
        (14, 'אתלטיק בילבאו', 'ריאל סוסיאדד', 1, 2, 2, 1, '1', '4750811', 2, 1),
        (15, 'מילאן', 'אינטר', 1, 3, 3, 1, '1', '4732643', 3, 1),
        (16, 'יובנטוס', 'נאפולי', 0, 2, 2, 0, '1', '4732646', 2, 0)
    ) as e(
      game_number, home_name, away_name, stored_home, stored_away,
      home_score, away_score, marker, event_id, scores365_home, scores365_away
    )
    order by game_number
  loop
    if v_evidence.home_score <> v_evidence.scores365_home
       or v_evidence.away_score <> v_evidence.scores365_away
       or v_evidence.marker <> (case
         when v_evidence.home_score > v_evidence.away_score then '1'
         when v_evidence.home_score < v_evidence.away_score then '2'
         else 'X'
       end) then
      raise exception 'w16_264301_evidence_not_corroborated: game %', v_evidence.game_number;
    end if;

    select g.id, g.status, g.field_home_score, g.field_away_score,
           g.settlement_status, g.pool_settlement_outcome,
           h.canonical_name as home_name, a.canonical_name as away_name
      into v_game
    from public.round_games g
    join public.teams h on h.id = g.home_team_id
    join public.teams a on a.id = g.away_team_id
    where g.round_id = v_round_id
      and g.game_number = v_evidence.game_number
    for update of g;

    if not found
       or v_game.home_name <> v_evidence.home_name
       or v_game.away_name <> v_evidence.away_name then
      raise exception 'w16_264301_identity_mismatch: game %', v_evidence.game_number;
    end if;

    if v_game.status = 'finished'
       and v_game.settlement_status = 'settled'
       and v_game.pool_settlement_outcome = v_evidence.marker
       and v_game.field_home_score = v_evidence.home_score
       and v_game.field_away_score = v_evidence.away_score then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_game.status <> 'finished'
       or v_game.settlement_status <> 'under_review'
       or v_game.pool_settlement_outcome is not null
       or not (
         (v_game.field_home_score = v_evidence.stored_home
          and v_game.field_away_score = v_evidence.stored_away)
         or (v_game.field_home_score = v_evidence.home_score
          and v_game.field_away_score = v_evidence.away_score)
       ) then
      raise exception 'w16_264301_unexpected_state: game %', v_evidence.game_number;
    end if;

    perform public.toto_apply_game_state_v1(jsonb_build_object(
      'round_game_id', v_game.id,
      'status', 'finished',
      'home_score', v_evidence.home_score,
      'away_score', v_evidence.away_score,
      'observed_at', now(),
      'pool_settlement_status', 'settled',
      'pool_outcome', v_evidence.marker,
      'settlement_source',
        'kapiloto-operator:d062-264301-orientation;telesport-winner16:score_1-score_2;365scores:event='
        || v_evidence.event_id
    ));
    v_applied := v_applied + 1;
  end loop;

  select r.status
    into v_round_status
  from public.rounds r
  where r.id = v_round_id;

  if v_round_status <> 'settled' then
    raise exception 'w16_264301_round_not_settled: %', v_round_status;
  end if;

  raise notice 'w16_264301_orientation_correction applied=% skipped=%', v_applied, v_skipped;
end;
$correction$;
