import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export type FakeQueryLog = {
  table: string;
  operation: "select" | "insert" | "update" | "upsert" | "delete";
};

/**
 * Minimal read-only PostgREST query builder over in-memory tables. Any write
 * or RPC call is recorded and rejected so tests can prove read paths have no
 * side effects.
 */
export function createFakeSupabase(tables: Record<string, Row[]>) {
  const queries: FakeQueryLog[] = [];
  const forbiddenCalls: string[] = [];

  function builder(table: string) {
    const filters: Filter[] = [];
    let order: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;

    const run = () => {
      let rows = (tables[table] ?? []).filter((row) =>
        filters.every((filter) => filter(row)),
      );
      if (order) {
        const { column, ascending } = order;
        rows = [...rows].sort((a, b) => {
          const left = String(a[column]);
          const right = String(b[column]);
          return ascending ? left.localeCompare(right) : right.localeCompare(left);
        });
      }
      if (limit != null) rows = rows.slice(0, limit);
      return rows;
    };

    const rejectWrite = (operation: FakeQueryLog["operation"]) => () => {
      queries.push({ table, operation });
      forbiddenCalls.push(`${operation}:${table}`);
      throw new Error(`Write to ${table} is not allowed in read paths.`);
    };

    const query = {
      select() {
        queries.push({ table, operation: "select" });
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return query;
      },
      gte(column: string, value: number | string) {
        filters.push((row) => (row[column] as number | string) >= value);
        return query;
      },
      gt(column: string, value: number | string) {
        filters.push((row) => (row[column] as number | string) > value);
        return query;
      },
      order(column: string, options?: { ascending?: boolean }) {
        order = { column, ascending: options?.ascending ?? true };
        return query;
      },
      limit(value: number) {
        limit = value;
        return query;
      },
      async maybeSingle() {
        const rows = run();
        if (rows.length > 1) {
          return { data: null, error: { message: "multiple rows" } };
        }
        return { data: rows[0] ?? null, error: null };
      },
      then<T>(
        resolve: (value: { data: Row[]; error: null }) => T,
        reject?: (reason: unknown) => T,
      ) {
        try {
          return Promise.resolve(resolve({ data: run(), error: null }));
        } catch (error) {
          return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
        }
      },
      insert: rejectWrite("insert"),
      update: rejectWrite("update"),
      upsert: rejectWrite("upsert"),
      delete: rejectWrite("delete"),
    };

    return query;
  }

  const client = {
    from(table: string) {
      return builder(table);
    },
    rpc(name: string) {
      forbiddenCalls.push(`rpc:${name}`);
      throw new Error(`RPC ${name} is not allowed in read paths.`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    queries,
    forbiddenCalls,
  };
}
