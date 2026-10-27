import { createHash, timingSafeEqual } from "node:crypto";

export function verifyKapilotoWorkerAuthorization(
  authorization: string | null,
  expectedSha256: string | undefined,
): boolean {
  const expected = expectedSha256?.trim().toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false;
  if (!authorization?.startsWith("Bearer ")) return false;

  const secret = authorization.slice("Bearer ".length);
  if (!secret) return false;

  const actual = createHash("sha256").update(secret, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");

  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}
