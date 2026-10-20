import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import type { Pick } from "@/lib/toto";

export type TicketDraftPick = {
  roundGameId: string;
  pick: Pick;
};

export type TicketDraftSnapshot = {
  ticketId: string | null;
  state: "draft" | "submitted" | "locked" | null;
  revision: number;
  submittedAt: string | null;
  maxDoubles: number;
  picks: TicketDraftPick[];
};

export type TicketMutationResult = {
  ticketId: string;
  state: "draft" | "submitted" | "locked";
  revision: number;
  pickCount: number;
  doublesUsed: number;
  maxDoubles: number;
  submittedAt: string | null;
  versionId?: string;
  versionNo?: number;
};

function isPick(value: unknown): value is Pick {
  return ["1", "X", "2", "1X", "X2", "12"].includes(String(value));
}

function parseMutation(value: Json): TicketMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ticket RPC returned an invalid payload.");
  }

  const row = value as Record<string, Json | undefined>;
  const state = row.state;
  if (
    typeof row.ticket_id !== "string" ||
    (state !== "draft" && state !== "submitted" && state !== "locked") ||
    typeof row.revision !== "number" ||
    typeof row.pick_count !== "number" ||
    typeof row.doubles_used !== "number" ||
    typeof row.max_doubles !== "number"
  ) {
    throw new Error("Ticket RPC response is incomplete.");
  }

  return {
    ticketId: row.ticket_id,
    state,
    revision: row.revision,
    pickCount: row.pick_count,
    doublesUsed: row.doubles_used,
    maxDoubles: row.max_doubles,
    submittedAt:
      typeof row.submitted_at === "string" ? row.submitted_at : null,
    versionId:
      typeof row.version_id === "string" ? row.version_id : undefined,
    versionNo:
      typeof row.version_no === "number" ? row.version_no : undefined,
  };
}

export class TotoTicketService {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async load(
    groupId: string,
    roundId: string,
    userId: string,
  ): Promise<TicketDraftSnapshot> {
    const [
      { data: settings, error: settingsError },
      { data: ticket, error: ticketError },
    ] = await Promise.all([
      this.client
        .from("group_round_settings")
        .select("max_doubles")
        .eq("group_id", groupId)
        .eq("round_id", roundId)
        .maybeSingle(),
      this.client
        .from("user_tickets")
        .select("id,state,revision,submitted_at")
        .eq("group_id", groupId)
        .eq("round_id", roundId)
        .eq("user_id", userId)
        .maybeSingle(),
    ]);

    if (settingsError) {
      throw new Error(
        `Failed to load group round settings: ${settingsError.message}`,
      );
    }
    if (!settings) {
      throw new Error("ticket_group_round_settings_missing");
    }
    if (ticketError) {
      throw new Error(`Failed to load user ticket: ${ticketError.message}`);
    }

    if (!ticket) {
      return {
        ticketId: null,
        state: null,
        revision: 0,
        submittedAt: null,
        maxDoubles: settings.max_doubles,
        picks: [],
      };
    }

    const { data: pickRows, error: picksError } = await this.client
      .from("user_ticket_picks")
      .select("round_game_id,pick")
      .eq("user_ticket_id", ticket.id);

    if (picksError) {
      throw new Error(`Failed to load user ticket picks: ${picksError.message}`);
    }

    const picks: TicketDraftPick[] = (pickRows ?? []).map((row) => {
      if (!isPick(row.pick)) {
        throw new Error("Stored ticket contains an invalid pick.");
      }

      return {
        roundGameId: row.round_game_id,
        pick: row.pick,
      };
    });

    return {
      ticketId: ticket.id,
      state: ticket.state,
      revision: Number(ticket.revision),
      submittedAt: ticket.submitted_at,
      maxDoubles: settings.max_doubles,
      picks,
    };
  }

  async saveDraft(input: {
    groupId: string;
    roundId: string;
    userId: string;
    expectedRevision: number | null;
    picks: TicketDraftPick[];
  }): Promise<TicketMutationResult> {
    const { data, error } = await this.client.rpc("toto_save_ticket_draft", {
      p_group_id: input.groupId,
      p_round_id: input.roundId,
      p_user_id: input.userId,
      p_expected_revision: input.expectedRevision,
      p_picks: input.picks.map((item) => ({
        round_game_id: item.roundGameId,
        pick: item.pick,
      })) as Json,
    });

    if (error) {
      throw new Error(error.message);
    }

    return parseMutation(data);
  }

  async submit(input: {
    groupId: string;
    roundId: string;
    userId: string;
    expectedRevision: number | null;
  }): Promise<TicketMutationResult> {
    const { data, error } = await this.client.rpc("toto_submit_ticket", {
      p_group_id: input.groupId,
      p_round_id: input.roundId,
      p_user_id: input.userId,
      p_expected_revision: input.expectedRevision,
    });

    if (error) {
      throw new Error(error.message);
    }

    return parseMutation(data);
  }
}
