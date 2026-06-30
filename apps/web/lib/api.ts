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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "include",
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
  } catch (e) {
    throw new ApiError(0, "NETWORK_ERROR", (e as Error).message, null);
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
    const body = (json ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      res.status,
      body.error ?? `HTTP_${res.status}`,
      body.message ?? res.statusText,
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
  del: <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" }),
};
