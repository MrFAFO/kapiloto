# Winner official results source — integration note

Discovered public Winner endpoints:

- `https://www.winner.co.il/api/v2/publicapi/GetResults`
- `https://api.winner.co.il/v2/publicapi/GetCMobileLine`
- `https://api.winner.co.il/v2/publicapi/GetCMobileHashes`

Public code using Winner's result endpoint shows a JSON POST body with
`startDate`, `endDate`, `sports` and `leagues`, and result events with
`sportid`, `date`, `time`, `league`, `teamA`, `teamB`, `scoreA`
and `scoreB`.

## Trust boundary

`GetResults` is treated as an **official Winner field-result source**, not yet
as the authoritative Winner16/Toto pool-settlement source. A field score is not
sufficient to infer every exceptional Toto decision (void, cancellation,
technical ruling, etc.).

The module is therefore initially isolated behind a secret-authenticated
preflight endpoint. It does not write to Supabase and does not change settlement.

Promotion criteria before settlement integration:

1. production preflight returns HTTP 200 and validates the expected response;
2. multiple completed football fixtures match known Winner results;
3. matching is deterministic against canonical fixture identity;
4. exceptional/no-score rows remain fail-closed / under review;
5. Telesport and Winner disagreement never auto-settles.


## Server-to-server validation status — 2026-10-20

Two isolated GitHub Actions preflights returned HTTP 403 from
`www.winner.co.il/api/v2/publicapi/GetResults`.

The second attempt matched the public desktop request contract more closely:
`X-Requested-With`, `UserAgentData`, `appVersion`, browser User-Agent,
request/device IDs, and the correct Asia/Jerusalem UTC offset. It still
returned 403.

Conclusion: treat this endpoint as **blocked for generic server-to-server use**
unless a production Vercel preflight proves otherwise. Do not circumvent the
site protection and do not promote it into automatic Toto settlement while it
is blocked. Telesport remains the operational field source; disagreements or
exceptional cases remain fail-closed / under review.
