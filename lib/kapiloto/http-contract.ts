export type KapilotoConsultIntent = "consult" | "recheck";

export type KapilotoConsultRequestBody = {
  groupId: string | null;
  roundGameId: string;
  intent: KapilotoConsultIntent;
  basedOnRunId: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`${field} must be a UUID.`);
  }
  return value;
}

export function requireIdempotencyKey(value: string | null): string {
  const key = value?.trim();
  if (!key || key.length < 8 || key.length > 200) {
    throw new Error(
      "Idempotency-Key header must contain between 8 and 200 characters.",
    );
  }
  return key;
}

export function parseKapilotoConsultBody(
  value: unknown,
): KapilotoConsultRequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }

  const body = value as Record<string, unknown>;
  const intent = body.intent;

  if (intent !== "consult" && intent !== "recheck") {
    throw new Error("intent must be consult or recheck.");
  }

  const basedOnRunId =
    body.basedOnRunId == null
      ? null
      : requireUuid(body.basedOnRunId, "basedOnRunId");

  return {
    groupId:
      body.groupId == null ? null : requireUuid(body.groupId, "groupId"),
    roundGameId: requireUuid(body.roundGameId, "roundGameId"),
    intent,
    basedOnRunId,
  };
}
