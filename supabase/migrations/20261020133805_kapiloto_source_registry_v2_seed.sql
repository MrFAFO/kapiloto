-- Seed the reviewed Kapiloto source registry for source-policy v2.
-- Unknown domains remain Tier 4 by runtime policy. Reviewed sources are
-- elevated only for the claim types where they are authoritative/reliable.

with seed(domain,publisher,tier_by_claim_type,languages,coverage_metadata,denied,metadata) as (
  values
(
  'bbc.com',
  'BBC',
  '{"form":2,"default":3,"tactical":2,"home_away":2,"conditions":2,"availability":2,"head_to_head":3,"club_coach_news":2,"draw_propensity":3,"schedule_fatigue":2,"independent_model":3,"competition_context":2}'::jsonb,
  array['en']::text[],
  '{"kind":"independent_media"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'bolognafc.it',
  'Bologna FC',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['it']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'brentfordfc.com',
  'Brentford FC',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'bundesliga.com',
  'Bundesliga',
  '{"form":1,"default":3,"tactical":3,"home_away":1,"conditions":3,"availability":2,"head_to_head":2,"club_coach_news":3,"draw_propensity":2,"schedule_fatigue":1,"independent_model":4,"competition_context":1}'::jsonb,
  array['de','en']::text[],
  '{"kind":"official_competition","country":"DE"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'dfb.de',
  'DFB',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":2,"head_to_head":2,"club_coach_news":3,"draw_propensity":3,"schedule_fatigue":1,"independent_model":4,"competition_context":1}'::jsonb,
  array['de','en']::text[],
  '{"kind":"official_association","country":"DE"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'espn.com',
  'ESPN',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":2,"head_to_head":3,"club_coach_news":2,"draw_propensity":3,"schedule_fatigue":2,"independent_model":3,"competition_context":2}'::jsonb,
  array['en']::text[],
  '{"kind":"independent_media"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'fc.de',
  '1. FC Köln',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['de']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'football.org.il',
  'Israel Football Association',
  '{"form":1,"default":3,"tactical":3,"home_away":1,"conditions":3,"availability":2,"head_to_head":2,"club_coach_news":3,"draw_propensity":2,"schedule_fatigue":1,"independent_model":4,"competition_context":1}'::jsonb,
  array['he','en']::text[],
  '{"kind":"official_competition","country":"IL"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'fulhamfc.com',
  'Fulham FC',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'laliga.com',
  'LALIGA',
  '{"form":1,"default":3,"tactical":3,"home_away":1,"conditions":3,"availability":2,"head_to_head":2,"club_coach_news":3,"draw_propensity":2,"schedule_fatigue":1,"independent_model":4,"competition_context":1}'::jsonb,
  array['es','en']::text[],
  '{"kind":"official_competition","country":"ES"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'leedsunited.com',
  'Leeds United',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'legaseriea.it',
  'Lega Serie A',
  '{"form":1,"default":3,"tactical":3,"home_away":1,"conditions":3,"availability":2,"head_to_head":2,"club_coach_news":3,"draw_propensity":2,"schedule_fatigue":1,"independent_model":4,"competition_context":1}'::jsonb,
  array['it','en']::text[],
  '{"kind":"official_competition","country":"IT"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'mhaifafc.com',
  'Maccabi Haifa FC',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['he','en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'newcastleunited.com',
  'Newcastle United',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'one.co.il',
  'ONE',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":3,"head_to_head":3,"club_coach_news":3,"draw_propensity":3,"schedule_fatigue":3,"independent_model":4,"competition_context":2}'::jsonb,
  array['he']::text[],
  '{"kind":"independent_media","country":"IL"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'premierleague.com',
  'Premier League',
  '{"form":1,"default":3,"tactical":3,"home_away":1,"conditions":3,"availability":2,"head_to_head":2,"club_coach_news":3,"draw_propensity":2,"schedule_fatigue":1,"independent_model":4,"competition_context":1}'::jsonb,
  array['en']::text[],
  '{"kind":"official_competition","country":"GB"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'rcdespanyol.com',
  'RCD Espanyol',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['es','en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'realbetisbalompie.es',
  'Real Betis Balompié',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['es']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'realracingclub.es',
  'Real Racing Club',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['es']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'reuters.com',
  'Reuters',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":2,"availability":2,"head_to_head":3,"club_coach_news":2,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['en']::text[],
  '{"kind":"independent_media"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2","syndication_cluster_id":"wire:reuters"}'::jsonb
),
(
  'rfef.es',
  'RFEF',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":2,"head_to_head":2,"club_coach_news":3,"draw_propensity":3,"schedule_fatigue":1,"independent_model":4,"competition_context":1}'::jsonb,
  array['es']::text[],
  '{"kind":"official_association","country":"ES"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'safc.com',
  'Sunderland AFC',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'schalke04.de',
  'FC Schalke 04',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['de','en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'skysports.com',
  'Sky Sports',
  '{"form":2,"default":3,"tactical":2,"home_away":2,"conditions":2,"availability":2,"head_to_head":3,"club_coach_news":2,"draw_propensity":3,"schedule_fatigue":2,"independent_model":3,"competition_context":2}'::jsonb,
  array['en']::text[],
  '{"kind":"independent_media"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'sport5.co.il',
  'Sport5',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":3,"head_to_head":3,"club_coach_news":3,"draw_propensity":3,"schedule_fatigue":3,"independent_model":4,"competition_context":2}'::jsonb,
  array['he']::text[],
  '{"kind":"independent_media","country":"IL"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'valenciacf.com',
  'Valencia CF',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['es','en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
),
(
  'villarrealcf.es',
  'Villarreal CF',
  '{"form":2,"default":3,"tactical":3,"home_away":2,"conditions":3,"availability":1,"head_to_head":3,"club_coach_news":1,"draw_propensity":3,"schedule_fatigue":2,"independent_model":4,"competition_context":2}'::jsonb,
  array['es','en']::text[],
  '{"kind":"official_club"}'::jsonb,
  false,
  '{"policy":"kapiloto-source-v2"}'::jsonb
)
)
insert into public.kapiloto_source_registry (
  domain,publisher,tier_by_claim_type,languages,coverage_metadata,denied,reviewed_at,metadata
)
select
  domain,publisher,tier_by_claim_type,languages,coverage_metadata,denied,now(),metadata
from seed
on conflict (domain) do update
set publisher = excluded.publisher,
    tier_by_claim_type = excluded.tier_by_claim_type,
    languages = excluded.languages,
    coverage_metadata = excluded.coverage_metadata,
    denied = excluded.denied,
    reviewed_at = excluded.reviewed_at,
    metadata = excluded.metadata;
