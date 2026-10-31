import { PGlite } from "@electric-sql/pglite";
import { auto_explain } from "@electric-sql/pglite/contrib/auto_explain";
import { pageinspect } from "@electric-sql/pglite/contrib/pageinspect";

import { createLedgerDatabase } from "./ledger-fixtures";

/**
 * Lock observation for PGlite tests.
 *
 * A migrated ledger database is dumped and reloaded with pageinspect (to read
 * the row-lock bits in heap tuple headers) and auto_explain (to log the plan
 * of every statement nested inside an RPC, in execution order).
 *
 * Limitation: PGlite runs a single-user backend. It shows which row locks a
 * transaction HOLDS and in which order statements take them, but it does not
 * enforce row-lock conflicts between transactions: even a prepared
 * transaction's FOR SHARE lock does not refuse FOR UPDATE NOWAIT. Conflicts
 * therefore rest on PostgreSQL's documented row-lock conflict table and are
 * not "tested" here.
 */
export async function createInspectableLedgerDatabase(): Promise<PGlite> {
  const base = await createLedgerDatabase();
  const dump = await base.dumpDataDir("none");
  await base.close();
  const db = new PGlite({ loadDataDir: dump, extensions: { pageinspect, auto_explain } });
  await db.exec("create extension if not exists pageinspect");
  return db;
}

export type HeldRowLock = "none" | "for key share" | "for share" | "for no key update" | "for update" | "multixact" | "updated";

// Heap tuple header bits (src/include/access/htup_details.h).
const XMAX_KEYSHR_LOCK = 0x0010;
const XMAX_EXCL_LOCK = 0x0040;
const XMAX_LOCK_ONLY = 0x0080;
const XMAX_IS_MULTI = 0x1000;
const KEYS_UPDATED = 0x2000;

/** The row lock the CURRENT transaction holds on each matching row, in ctid order (table defaults to schema public). */
export async function heldRowLocks(db: PGlite, table: string, where: string, params: unknown[] = []): Promise<HeldRowLock[]> {
  const relation = table.includes(".") ? table : `public.${table}`;
  const rows = await db.query<{ ctid: string }>(`select ctid::text as ctid from ${relation} where ${where} order by ctid`, params);
  const out: HeldRowLock[] = [];
  for (const { ctid } of rows.rows) {
    const [block, lp] = ctid.replace(/[()]/g, "").split(",").map(Number);
    const tuple = (
      await db.query<{ infomask: number; infomask2: number; mine: boolean }>(
        `select t_infomask as infomask, t_infomask2 as infomask2, coalesce(t_xmax = xid(pg_current_xact_id()), false) as mine
         from heap_page_items(get_raw_page($1, $2)) where lp = $3`,
        [relation, block, lp],
      )
    ).rows[0];
    if (tuple.infomask & XMAX_IS_MULTI) out.push("multixact");
    else if (!tuple.mine) out.push("none");
    else if (!(tuple.infomask & XMAX_LOCK_ONLY)) out.push("updated");
    else if ((tuple.infomask & (XMAX_EXCL_LOCK | XMAX_KEYSHR_LOCK)) === (XMAX_EXCL_LOCK | XMAX_KEYSHR_LOCK)) out.push("for share");
    else if (tuple.infomask & XMAX_KEYSHR_LOCK) out.push("for key share");
    else out.push(tuple.infomask2 & KEYS_UPDATED ? "for update" : "for no key update");
  }
  return out;
}

export type NestedPlan = { queryText: string; parameters: string; plan: string };

/** Runs one statement with auto_explain logging every nested statement; plans in execution order. */
export async function withNestedPlans<T>(db: PGlite, sql: string, params: unknown[]): Promise<{ rows: T[]; plans: NestedPlan[] }> {
  await db.exec("load 'auto_explain'");
  await db.exec("set auto_explain.log_min_duration = 0; set auto_explain.log_nested_statements = on; set auto_explain.log_level = notice");
  const plans: NestedPlan[] = [];
  try {
    const result = await db.query<T>(sql, params, {
      onNotice: (notice) => {
        const message = notice.message ?? "";
        const match = /Query Text: ([\s\S]*?)\n((?:LockRows|Sort|Result|Index|Seq|Nested|Hash|Merge|Aggregate|Limit|Unique|Subquery|Function|Bitmap|Append|Gather|Materialize|WindowAgg|CTE|ProjectSet|Values|Group)[\s\S]*)$/.exec(message);
        if (match) {
          const [queryText, parameters = ""] = match[1].split("\nQuery Parameters: ");
          plans.push({ queryText: queryText.trim(), parameters: parameters.trim(), plan: match[2].replace(/\s+\(cost=[^)]*\)/g, "").trim() });
        }
      },
    });
    return { rows: result.rows, plans };
  } finally {
    await db.exec("set auto_explain.log_min_duration = -1");
  }
}

export async function advisoryLockModes(db: PGlite, key: string): Promise<string[]> {
  const result = await db.query<{ mode: string }>(
    `select mode from pg_locks
     where locktype = 'advisory' and objsubid = 1
       and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return result.rows.map((row) => row.mode).sort();
}
