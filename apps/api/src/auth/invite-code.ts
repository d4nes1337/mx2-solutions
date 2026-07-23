import { createHash, randomBytes } from "node:crypto";

/**
 * One-time private-beta invitation codes. The raw code exists only in the
 * mint response (shown once to the owner) and the invitee's message; the DB
 * stores SHA256(code) — same posture as sign-link tokens. 128 bits of
 * randomness makes online guessing infeasible even before rate limits, and the
 * "arima-" prefix makes codes recognizable in support conversations without
 * revealing anything.
 */
export const generateInviteCode = (): string => `arima-${randomBytes(16).toString("hex")}`;

export const hashInviteCode = (code: string): string =>
  createHash("sha256").update(code, "utf8").digest("hex");
