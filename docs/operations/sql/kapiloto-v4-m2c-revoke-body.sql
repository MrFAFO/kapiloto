-- Kapiloto V4 M2C pre-reviewed emergency pause body.
--
-- IMPORTANT:
-- - This file is NOT a Supabase migration and must stay outside supabase/migrations.
-- - Do not apply it during normal deployment.
-- - Execute it ALONE, in its own transaction: never batch it with the
--   verification (kapiloto-v4-m2c-verify.sql) or any other statement, because
--   an error later in the same implicit transaction would roll the revoke back.
-- - Then record it in migration history with a fresh timestamp (runbook §K).
-- - Revoke-only. M2C changes no identity, mapping, fixture or Match Ledger data.
--
-- Scope: both provider ingest RPCs, from every non-owner role that could hold
-- EXECUTE. In the expected state only service_role holds it on V2 (M2B) and
-- every other revoke is a no-op; they close an accidental grant (PUBLIC,
-- anon, authenticated, or the frozen V1 RPC) in the same statement. The
-- function owner keeps EXECUTE by definition; production ingest never runs as
-- the owner (runbook §A).

revoke execute on function public.match_ledger_ingest_provider_fixture_v2(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.match_ledger_ingest_provider_fixture(jsonb)
  from public, anon, authenticated, service_role;
