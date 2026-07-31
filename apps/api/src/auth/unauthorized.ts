/**
 * The single 401 body shape for the whole API.
 *
 * `message` is not optional decoration — it is load-bearing. The web client
 * (apps/web/lib/api.ts) builds `ApiError.message` from the body and falls back
 * to `Response.statusText`, and HTTP/2 has no reason phrase, so `statusText` is
 * ALWAYS "" in production (Caddy serves h2 on the beta domain). A 401 sent
 * without a `message` therefore reached the user as a *blank* error — the
 * silent failure reported when signing a triggered strategy.
 *
 * Any new 401 must use this constant rather than an inline object.
 */
export const UNAUTHORIZED_BODY = {
  error: "Unauthorized",
  message: "Your session has expired or is no longer valid — sign in with your wallet again.",
} as const;
