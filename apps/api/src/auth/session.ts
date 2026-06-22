import { randomBytes, createHash } from "node:crypto";

export const SESSION_COOKIE_NAME = "mx2_session";

export const generateSessionToken = (): string => randomBytes(32).toString("hex");

export const hashSessionToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");
