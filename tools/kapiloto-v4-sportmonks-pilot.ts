/**
 * Operator-run, read-only Sportmonks A2-B pilot (npm run pilot:sportmonks-a2b).
 *
 * Runs only from the workflow_dispatch workflow
 * .github/workflows/kapiloto-v4-sportmonks-a2b-readiness.yml or by hand.
 * It reads the Sportmonks API and writes files under --out only: no Supabase
 * client, no ingest / attestation RPC, no provider_ingest_run, no fixture
 * mint, no Match Ledger observation, no identity change, and a report that
 * always says backfillApproval.approved = false. The orchestration lives in
 * lib/kapiloto-v4/sportmonks-pilot-runner.ts.
 *
 * Kept in tools/ (not scripts/): the M2B boundary test forbids production
 * script paths from importing the V4 foundation.
 */
import { runSportmonksA2BPilotCli } from "../lib/kapiloto-v4/sportmonks-pilot-runner";

runSportmonksA2BPilotCli(process.argv.slice(2), process.env, {
  fetch: (url, init) => fetch(url, init),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  () => {
    // runSportmonksA2BPilotCli reports its own (redacted) errors; never print
    // an unexpected rejection that might carry request details.
    process.stderr.write("A2-B pilot aborted unexpectedly.\n");
    process.exitCode = 1;
  },
);
