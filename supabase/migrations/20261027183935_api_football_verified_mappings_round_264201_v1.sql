-- API-Football mappings verified by the 2026-10-24 read-only probe of Winner 16
-- round 264201: each pair matched kickoff, league, both team names and a
-- complete 1X2 market on the same provider fixture. Data only, no schema change.
--
-- Additive and idempotent: an existing mapping is never overwritten, a team that
-- already has a trusted API-Football mapping gets no second one, and rows whose
-- Kapiloto team or competition is missing are skipped instead of failing.
-- Hebrew canonical team names are untouched.

insert into public.provider_competition_mappings (
  provider, provider_competition_id, competition_id, provider_name,
  mapping_status, last_verified_at
)
select 'api-football', v.provider_competition_id, v.competition_id, v.provider_name,
  'confirmed', '2026-10-24T11:20:00Z'::timestamptz
from (
  values
    ('383', '06b70ffa-847c-44d2-a346-3683ac9115c3'::uuid, 'Ligat Ha''al'),
    ('39', 'ccdbb89d-e575-4e15-820d-f5d1ecdc3a85'::uuid, 'Premier League'),
    ('140', '2116127b-f4f6-40d5-bdbc-bc60cb70dc0d'::uuid, 'La Liga'),
    ('135', 'a2b7daf8-1d1d-4b79-8801-b47ad6cde38c'::uuid, 'Serie A'),
    ('78', '11ef12f9-86cf-4634-9ed7-cf9f7113e214'::uuid, 'Bundesliga')
) as v(provider_competition_id, competition_id, provider_name)
join public.competitions c on c.id = v.competition_id
where not exists (
  select 1
  from public.provider_competition_mappings m
  where m.provider = 'api-football'
    and m.competition_id = v.competition_id
)
on conflict (provider, provider_competition_id) do nothing;

insert into public.provider_team_mappings (
  provider, provider_team_id, team_id, provider_name,
  mapping_status, mapping_confidence, last_verified_at
)
select 'api-football', v.provider_team_id, v.team_id, v.provider_name,
  'confirmed', 0.95, '2026-10-24T11:20:00Z'::timestamptz
from (
  values
    ('4486', '449dd8ed-10e5-4e55-a095-bb2202c6c9ce'::uuid, 'Hapoel Katamon'),
    ('4501', '6fc76117-e2fa-483b-9fb0-bc52ed86c430'::uuid, 'Hapoel Tel Aviv'),
    ('4510', '3d7484fa-4442-4cde-9576-6c7981b6dfeb'::uuid, 'Ironi Kiryat Shmona'),
    ('4481', '8be54030-7c8e-4da6-9c2e-38cf75a56c34'::uuid, 'Bnei Sakhnin'),
    ('4489', '09eddd2a-ee47-4d3b-b34d-5d8b2268c50e'::uuid, 'Hapoel Ramat Gan'),
    ('4495', '21c0daeb-9fdb-4152-9592-1ded8d71f2cb'::uuid, 'Maccabi Petah Tikva'),
    ('6181', '8d466213-7a7c-48bc-b5c5-4a18b47c2f72'::uuid, 'Ironi Tiberias'),
    ('4505', '51b59030-1607-4150-81c4-17553e2fbbb9'::uuid, 'Maccabi Netanya'),
    ('1346', '8d6e84ab-c024-4c1c-ba51-3d7f2ec22644'::uuid, 'Coventry'),
    ('36', '2fd9c93c-2739-4c14-bfee-9381fb72f8ed'::uuid, 'Fulham'),
    ('64', 'b08fed73-5dec-48d4-a78d-492941015068'::uuid, 'Hull City'),
    ('55', 'eb5c6625-7b8e-4027-a688-36568f372b3d'::uuid, 'Brentford'),
    ('52', '240f0dd8-0199-4975-aa8d-95233d305a4c'::uuid, 'Crystal Palace'),
    ('34', '873939e0-cf0b-4151-9526-d754629fc7f5'::uuid, 'Newcastle'),
    ('746', '60b20670-8dcd-4091-85b2-1053446cab54'::uuid, 'Sunderland'),
    ('63', '72bfd482-213d-4b7f-8939-544eb4329682'::uuid, 'Leeds'),
    ('4665', 'b008ba96-b096-45ca-a930-deec7689f426'::uuid, 'Racing Santander'),
    ('540', '5b8439d3-fb01-41ba-9327-630c41e1f9a1'::uuid, 'Espanyol'),
    ('532', 'ff45ce48-2995-4a37-9ba1-af4ec246de9c'::uuid, 'Valencia'),
    ('533', 'd90b8f8e-cfa8-4705-90eb-532e3a7b468e'::uuid, 'Villarreal'),
    ('538', '4b5cdb73-d019-46dc-9c1f-4bbe1ac23146'::uuid, 'Celta Vigo'),
    ('543', '1a9506b5-7100-4d4c-85cc-91e4a8ee1bcd'::uuid, 'Real Betis'),
    ('490', 'e19b9268-6dc7-426b-adb8-d7aae9e4b8d8'::uuid, 'Cagliari'),
    ('500', '73fa1424-c69d-4f08-85f2-f0e2f59315f1'::uuid, 'Bologna'),
    ('492', '05061cae-b526-499c-88a5-1c4a9f2ce86b'::uuid, 'Napoli'),
    ('497', '968f1153-ffb4-4d64-838a-d1ce6b397aee'::uuid, 'AS Roma'),
    ('192', 'f68ab2f0-cd3d-4c80-84bd-8c9079bcfb8b'::uuid, '1. FC Köln'),
    ('174', '8ab93093-dafb-419a-9cd3-d9c91485f3d6'::uuid, 'FC Schalke 04'),
    ('185', '927dc08d-87f1-4638-8b68-fe941ac88c1f'::uuid, 'SC Paderborn 07'),
    ('175', '36cf42d3-a61e-45ad-9243-6343ad189c47'::uuid, 'Hamburger SV')
) as v(provider_team_id, team_id, provider_name)
join public.teams t on t.id = v.team_id
where not exists (
  select 1
  from public.provider_team_mappings m
  where m.provider = 'api-football'
    and m.team_id = v.team_id
    and m.mapping_status in ('confirmed', 'manual_override')
)
on conflict (provider, provider_team_id) do nothing;

-- Provider-specific alias: `source` names the provider whose naming it reflects
-- (as with the existing '365scores' aliases). It lets name bootstrap find
-- Hapoel Jerusalem even before an id mapping exists.
insert into public.team_aliases (team_id, alias, source, language_code, is_preferred)
select v.team_id, v.alias, 'api-football', 'en', false
from (
  values ('449dd8ed-10e5-4e55-a095-bb2202c6c9ce'::uuid, 'Hapoel Katamon')
) as v(team_id, alias)
join public.teams t on t.id = v.team_id
on conflict (team_id, normalized_alias) do nothing;
