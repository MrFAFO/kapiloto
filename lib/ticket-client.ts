import type { Pick } from "@/lib/toto";

export type TicketClientSnapshot = {
  ticketId: string | null;
  state: "draft" | "submitted" | "locked" | null;
  revision: number;
  submittedAt: string | null;
  maxDoubles: number;
  picks: Array<{ roundGameId: string; pick: Pick }>;
};

export type TicketClientMutation = {
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

type FetchLike = typeof fetch;

type TicketClientOptions = {
  fetch?: FetchLike;
};

function endpoint(roundId: string, groupId?: string): string {
  const base = `/api/v1/rounds/${encodeURIComponent(roundId)}/ticket`;
  return groupId
    ? `${base}?groupId=${encodeURIComponent(groupId)}`
    : base;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | T
    | { error?: { code?: string; message?: string } }
    | null;

  if (!response.ok) {
    const error =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object"
        ? body.error
        : null;

    const message =
      error && typeof error.message === "string"
        ? error.message
        : `Ticket request failed with HTTP ${response.status}.`;

    const wrapped = new Error(message) as Error & {
      status?: number;
      code?: string;
    };
    wrapped.status = response.status;
    if (error && typeof error.code === "string") wrapped.code = error.code;
    throw wrapped;
  }

  if (body == null) {
    throw new Error("Ticket API returned an empty response.");
  }

  return body as T;
}

export function createTicketClient(options: TicketClientOptions = {}) {
  const request = options.fetch ?? fetch;

  return {
    async load(roundId: string, groupId: string): Promise<TicketClientSnapshot> {
      const response = await request(endpoint(roundId, groupId), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      return parseResponse<TicketClientSnapshot>(response);
    },

    async saveDraft(input: {
      roundId: string;
      groupId: string;
      expectedRevision: number;
      picks: Array<{ roundGameId: string; pick: Pick }>;
    }): Promise<TicketClientMutation> {
      const response = await request(endpoint(input.roundId), {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          groupId: input.groupId,
          expectedRevision: input.expectedRevision,
          picks: input.picks,
        }),
      });
      return parseResponse<TicketClientMutation>(response);
    },

    async submit(input: {
      roundId: string;
      groupId: string;
      expectedRevision: number;
    }): Promise<TicketClientMutation> {
      const response = await request(endpoint(input.roundId), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          groupId: input.groupId,
          expectedRevision: input.expectedRevision,
        }),
      });
      return parseResponse<TicketClientMutation>(response);
    },
  };
}

export type TicketClient = ReturnType<typeof createTicketClient>;
