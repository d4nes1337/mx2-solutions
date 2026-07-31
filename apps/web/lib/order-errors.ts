import { ApiError } from "./api";

/**
 * One human sentence for a failed sign-and-submit, shared by the desktop
 * trigger modal and the mobile sign page. Callers render only this string —
 * a rejection must never surface twice (local catch + mutation.error).
 */
export function friendlySubmitError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) {
      return `${e.message} Your signature was not submitted — you can sign again.`;
    }
    // A session that died mid-flow is the one failure the generic message
    // actively misleads on: the signature was fine, the cookie was not.
    if (e.status === 401) {
      return "Your session expired before the order was submitted — sign in again and re-open this from the bell. Nothing was submitted.";
    }
    if (e.status === 503) {
      return "Trading is disabled (live-trading flag off or paused) — order not submitted.";
    }
    if (e.code === "CLOB_CREDENTIALS_NOT_SET" || e.message.includes("CLOB_CREDENTIALS_NOT_SET")) {
      return "No trading credentials yet — set them up in Profile first.";
    }
    if (e.code === "GEO_BLOCKED" || e.code === "GEO_CLOSE_ONLY") {
      return e.message;
    }
    return e.message || "Order submission failed.";
  }
  const message = e instanceof Error ? e.message : "";
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 4001 || /reject|denied|declined|user cancell?ed/i.test(message)) {
    return "Signature request was declined — nothing was submitted.";
  }
  // Wallet not on Polygon and unwilling to switch: the EIP-712 domain is
  // pinned to 137, so the signature would be rejected downstream anyway.
  if (code === 4902 || /unrecognized chain|chain.*not (been )?added/i.test(message)) {
    return "Your wallet could not switch to Polygon. Add the Polygon network in your wallet, then sign again.";
  }
  return message || "Signing failed — nothing was submitted. Please try again.";
}
