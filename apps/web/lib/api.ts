// Typed fetch wrapper. All calls are relative ("/api/...") and rely on the
// Next.js rewrite proxy (see next.config.ts) so they are same-origin and the
// session cookie is sent automatically. `credentials: "include"` is kept
// explicit for clarity and so the wrapper also works without the proxy.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Last-resort copy for a failure whose response carried no usable text.
 *
 * This exists because `Response.statusText` is ALWAYS "" over HTTP/2 — the
 * protocol dropped the reason phrase — and production serves h2. Using it as
 * the fallback meant any error body without a `message` reached the user as a
 * completely blank error banner. Never return an empty string from here.
 */
function defaultMessageForStatus(status: number): string {
  if (status === 401) return "Your session has expired — sign in with your wallet again.";
  if (status === 403) return "You don't have access to this action.";
  if (status === 404) return "Not found.";
  if (status === 429) return "Too many requests — please wait a moment and try again.";
  if (status >= 500) return `The server could not handle the request (HTTP ${status}).`;
  return `Request failed (HTTP ${status}).`;
}

const firstNonEmpty = (...candidates: (string | undefined | null)[]): string | null => {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c;
  }
  return null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "include",
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
  } catch (e) {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      firstNonEmpty(e instanceof Error ? e.message : null) ??
        "Could not reach the server — check your connection and try again.",
      null,
    );
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    const body = (json ?? {}) as { error?: string; message?: string; raw?: string };
    throw new ApiError(
      res.status,
      firstNonEmpty(body.error) ?? `HTTP_${res.status}`,
      // Ordered by usefulness, and guaranteed non-empty. `raw` catches
      // non-JSON error bodies (a proxy's HTML 502, say) that would otherwise
      // fall through to the empty h2 statusText.
      firstNonEmpty(body.message, res.statusText, body.raw?.slice(0, 200)) ??
        defaultMessageForStatus(res.status),
      json,
    );
  }

  return json as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, {
      method: "POST",
      // Only advertise a JSON body when we actually send one — Fastify rejects an
      // empty body when Content-Type is application/json ("Body cannot be empty…").
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }),
  put: <T>(path: string, body: unknown): Promise<T> =>
    request<T>(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  patch: <T>(path: string, body: unknown): Promise<T> =>
    request<T>(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  del: <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" }),
};
