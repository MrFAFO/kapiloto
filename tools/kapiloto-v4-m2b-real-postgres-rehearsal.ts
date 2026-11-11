/**
 * Operator-run REAL-PostgreSQL M2B/M2C two-session rehearsal
 * (npm run rehearsal:v4-m2b-real-postgres). DISPOSABLE databases only.
 *
 * Opens one pg client connection per rehearsal session (direct connection or
 * Supabase session pooler, never the transaction pooler), so every session
 * is its own PostgreSQL backend. The guards, experiments (A2, A4, B1-B3),
 * cleanup and evidence live in
 * lib/kapiloto-v4/test-support/real-postgres-rehearsal.ts; this file only
 * turns the validated target into connections.
 *
 * Never run against production: resolveRehearsalTarget and the read-only
 * database guards refuse it before any write. No CI workflow runs this file;
 * the M2B boundary test pins that.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import pg from "pg";

import {
  runRealPostgresRehearsalCli,
  type Connector,
  type RawConnection,
  type RehearsalTarget,
} from "../lib/kapiloto-v4/test-support/real-postgres-rehearsal";

function connectorFor(target: RehearsalTarget): Connector {
  const ssl =
    target.tls.mode === "verify-full"
      ? { ca: readFileSync(target.tls.caFile, "utf8"), rejectUnauthorized: true }
      : target.tls.mode === "no-verify"
        ? { rejectUnauthorized: false }
        : false;
  return async (applicationName: string): Promise<RawConnection> => {
    const notices: string[] = [];
    // Explicit fields only (no connection string): PG* environment defaults
    // cannot fill a gap, and the guard already refused them.
    const client = new pg.Client({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: target.database,
      ssl,
      application_name: applicationName,
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
      keepAlive: true,
    });
    client.on("notice", (notice) => notices.push(notice.message ?? ""));
    // A rehearsal backend terminated by cleanup: its pending query rejects.
    client.on("error", () => undefined);
    await client.connect();
    return {
      async query(sql: string, params: unknown[] = []) {
        const result = (await (params.length > 0 ? client.query({ text: sql, values: params }) : client.query(sql))) as unknown as
          | pg.QueryResult
          | pg.QueryResult[];
        const last = Array.isArray(result) ? result[result.length - 1] : result;
        return (last?.rows ?? []) as Array<Record<string, unknown>>;
      },
      takeNotices: () => notices.splice(0),
      close: () => client.end().catch(() => undefined),
    };
  };
}

runRealPostgresRehearsalCli(process.argv.slice(2), process.env, {
  connectorFor,
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  writeFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  },
}).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  () => {
    // Never print an unexpected rejection: it might carry connection details.
    process.stderr.write("M2B real-PostgreSQL rehearsal aborted unexpectedly; run the M2C body and verification manually on the disposable project.\n");
    process.exitCode = 1;
  },
);
