import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
}

describe("api wrapper", () => {
  it("returns parsed json on success", async () => {
    mockFetch(200, { ok: true, address: "0xabc" });
    await expect(api.get("/api/auth/me")).resolves.toEqual({ ok: true, address: "0xabc" });
  });

  it("throws ApiError carrying status and backend error code", async () => {
    mockFetch(403, { error: "NOT_ALLOWLISTED", message: "not on the beta allowlist" });
    await expect(api.post("/api/auth/verify", {})).rejects.toMatchObject({
      status: 403,
      code: "NOT_ALLOWLISTED",
      message: "not on the beta allowlist",
    });
  });

  it("maps network failures to a NETWORK_ERROR ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("connection refused"))),
    );
    const err = await api.get("/api/events").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("NETWORK_ERROR");
  });
});
