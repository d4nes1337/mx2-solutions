import { ApiError } from "./api";

/**
 * One human sentence for a failed sign-and-submit, shared by the desktop
 * trigger modal and the mobile sign page. Callers render only this string —
 * a rejection must never surface twice (local catch + mutation.error).
 */
export function friendlySubmitError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 503) {
      return "Trading is disabled (live-trading flag off or paused) — order not submitted.";
    }
    if (e.code === "CLOB_CREDENTIALS_NOT_SET" || e.message.includes("CLOB_CREDENTIALS_NOT_SET")) {
      return "No trading credentials yet — set them up in Profile first.";
    }
    return e.message || "Order submission failed.";
  }
  const message = e instanceof Error ? e.message : "";
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 4001 || /reject|denied|declined/i.test(message)) {
    return "Signature request was declined — nothing was submitted.";
  }
  return message || "Signing failed.";
}
