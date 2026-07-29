import { describe, expect, it } from "vitest";
import type { Logger } from "@mx2/observability";
import type { ReferralCodeRow, ReferralRedemptionRow, ReferralStore } from "@mx2/db";
import { buildReferralCsv, createDunePushLoop } from "./dune-push.js";

const EOA = "0xf5F5Ec6d6e64B1D231bA9950325ce8Dc3f7d0AbE".toLowerCase();

const silentLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Logger;

describe("buildReferralCsv", () => {
  it("emits one row per redemption with a derived proxy wallet", () => {
    const csv = buildReferralCsv([
      {
        code: "ANSEM",
        ownerWallet: `0x${"9".repeat(40)}`,
        refereeEoa: EOA,
        redeemedAt: new Date("2026-07-20T12:00:00Z"),
      },
    ]);
    const [header, row] = csv.split("\n");
    expect(header).toBe("code,owner_wallet,referee_eoa,referee_proxy_wallet,redeemed_at");
    const cols = row!.split(",");
    expect(cols[0]).toBe("ANSEM");
    expect(cols[2]).toBe(EOA);
    // Deterministic Gnosis Safe derivation — a real, distinct address.
    expect(cols[3]).toMatch(/^0x[0-9a-f]{40}$/);
    expect(cols[3]).not.toBe(EOA);
    expect(cols[4]).toBe("2026-07-20T12:00:00.000Z");
  });

  it("leaves owner blank for campaign codes", () => {
    const csv = buildReferralCsv([
      { code: "LAUNCH", ownerWallet: null, refereeEoa: EOA, redeemedAt: new Date(0) },
    ]);
    expect(csv.split("\n")[1]!.split(",")[1]).toBe("");
  });
});

describe("createDunePushLoop.runOnce", () => {
  const storeWith = (redemptions: ReferralRedemptionRow[]): ReferralStore =>
    ({
      list: async () =>
        [
          {
            id: "code-1",
            code: "ANSEM",
            ownerWallet: `0x${"9".repeat(40)}`,
            maxUses: 5,
            usedCount: 1,
            note: null,
            createdBy: "admin:owner",
            expiresAt: null,
            disabledAt: null,
            disabledBy: null,
            createdAt: new Date(),
          },
        ] as ReferralCodeRow[],
      listRedemptions: async () => redemptions,
    }) as unknown as ReferralStore;

  const redemption: ReferralRedemptionRow = {
    id: "r1",
    codeId: "code-1",
    walletAddress: EOA,
    referrerWallet: `0x${"9".repeat(40)}`,
    redeemedAt: new Date("2026-07-20T12:00:00Z"),
  };

  it("uploads a full-replace CSV with the API key header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const loop = createDunePushLoop({
      logger: silentLogger,
      referrals: storeWith([redemption]),
      apiKey: "dune-key",
      fetchImpl,
    });
    await loop.runOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.dune.com/api/v1/uploads/csv");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-dune-api-key"]).toBe("dune-key");
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      table_name: string;
      data: string;
      is_private: boolean;
    };
    expect(body.table_name).toBe("arima_referrals");
    expect(body.is_private).toBe(false);
    expect(body.data).toContain("ANSEM");
  });

  it("skips the upload when there are no redemptions", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const loop = createDunePushLoop({
      logger: silentLogger,
      referrals: storeWith([]),
      apiKey: "dune-key",
      fetchImpl,
    });
    await loop.runOnce();
    expect(called).toBe(0);
  });

  it("surfaces upload failures without leaking the key", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const loop = createDunePushLoop({
      logger: silentLogger,
      referrals: storeWith([redemption]),
      apiKey: "dune-key",
      fetchImpl,
    });
    await expect(loop.runOnce()).rejects.toThrow(/HTTP 401/);
  });
});
