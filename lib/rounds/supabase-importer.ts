import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import {
  parseTotoRoundImportResult,
  serializeTotoRoundSnapshot,
  type TotoRoundImportResult,
  type TotoRoundSnapshotInput,
} from "./toto-round";

export class SupabaseTotoRoundImporter {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async import(snapshot: TotoRoundSnapshotInput): Promise<TotoRoundImportResult> {
    const { data, error } = await this.client.rpc("toto_import_round_snapshot", {
      p_snapshot: serializeTotoRoundSnapshot(snapshot),
    });

    if (error) {
      throw new Error(`Failed to import Winner 16 round: ${error.message}`);
    }

    const parsed = parseTotoRoundImportResult(data);

    if (parsed.gamesImported !== 16) {
      throw new Error(
        `Winner 16 import must persist exactly 16 games; got ${parsed.gamesImported}.`,
      );
    }

    return parsed;
  }
}
