import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { SupabaseTotoRoundImporter } from "../lib/rounds/supabase-importer";
import type { TotoRoundSnapshotInput } from "../lib/rounds/toto-round";
import type { Database } from "../lib/supabase/database.types";

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error(
      "Usage: npm run round:import -- <snapshot.json>",
    );
  }

  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!supabaseUrl || !secretKey) {
    throw new Error(
      "SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY are required.",
    );
  }

  const raw = await readFile(resolve(inputPath), "utf8");
  const snapshot = JSON.parse(raw) as TotoRoundSnapshotInput;

  const client = createClient<Database>(supabaseUrl, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const result = await new SupabaseTotoRoundImporter(client).import(snapshot);

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        ...result,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
