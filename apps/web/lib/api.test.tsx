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
    mockFetch(403, { error: "ACCESS_REVOKED", message: "access for this wallet was revoked" });
    await expect(api.post("/api/auth/verify", {})).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_REVOKED",
      message: "access for this wallet was revoked",
    });
  });

  // The root cause of the reported blank error: `Response.statusText` is always
  // "" over HTTP/2 (no reason phrase), which is what production serves. Every
  // one of these bodies used to yield ApiError.message === "".
  describe("never produces an empty message", () => {
    it("for an error body with no message field", async () => {
      mockFetch(401, { error: "Unauthorized" });
      const err = (await api.get("/api/trade/status").catch((e: unknown) => e)) as ApiError;
      expect(err.message.trim()).not.toBe("");
      expect(err.message).toMatch(/session/i);
    });

    it("for a completely empty body", async () => {
      mockFetch(502, "");
      const err = (await api.get("/api/trade/status").catch((e: unknown) => e)) as ApiError;
      expect(err.message.trim()).not.toBe("");
      expect(err.code).toBe("HTTP_502");
    });

    it("for a non-JSON body (a proxy's HTML error page)", async () => {
      mockFetch(504, "<html><body>Gateway Timeout</body></html>");
      const err = (await api.get("/api/trade/status").catch((e: unknown) => e)) as ApiError;
      expect(err.message.trim()).not.toBe("");
    });

    it("for a network failure whose Error has no message", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new Error(""))),
      );
      const err = (await api.get("/api/events").catch((e: unknown) => e)) as ApiError;
      expect(err.code).toBe("NETWORK_ERROR");
      expect(err.message.trim()).not.toBe("");
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
