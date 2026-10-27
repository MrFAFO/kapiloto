export type RecoveryIdentifier =
  | { type: "email"; value: string }
  | { type: "phone"; value: string };

const USERNAME_RE = /^[\p{L}\p{N}._-]+$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function usernameValidationError(raw: string): string | null {
  const value = raw.trim();
  if (value.length < 3 || value.length > 40) {
    return "username_length";
  }
  if (!USERNAME_RE.test(value)) {
    return "username_characters";
  }
  return null;
}

export function passwordValidationError(raw: string): string | null {
  return raw.length >= 8 ? null : "password_length";
}

export function parseRecoveryIdentifier(
  raw: string,
): RecoveryIdentifier | null {
  const value = raw.trim();

  if (EMAIL_RE.test(value)) {
    return { type: "email", value: value.toLowerCase() };
  }

  const compact = value.replace(/[\s().-]/g, "");
  if (/^05\d{8}$/.test(compact)) {
    return { type: "phone", value: `+972${compact.slice(1)}` };
  }
  if (/^9725\d{8}$/.test(compact)) {
    return { type: "phone", value: `+${compact}` };
  }
  if (/^\+[1-9]\d{7,14}$/.test(compact)) {
    return { type: "phone", value: compact };
  }

  return null;
}

export function safeNextPath(raw: string | null, fallback = "/"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}
