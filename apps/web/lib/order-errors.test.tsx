import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { friendlySubmitError } from "./order-errors";

describe("friendlySubmitError", () => {
  it("maps 503 to the trading-disabled sentence", () => {
    expect(
      friendlySubmitError(
        new ApiError(503, "TRADING_DISABLED", "Live trading is currently disabled.", null),
      ),
    ).toMatch(/Trading is disabled/);
  });

  it("maps missing CLOB credentials to the profile hint", () => {
    expect(
      friendlySubmitError(
        new ApiError(400, "CLOB_CREDENTIALS_NOT_SET", "CLOB_CREDENTIALS_NOT_SET", null),
      ),
    ).toMatch(/Profile/);
  });

  it("passes other API messages through verbatim", () => {
    expect(
      friendlySubmitError(
        new ApiError(403, "GEO_BLOCKED", "Trading is not available in your region.", null),
      ),
    ).toBe("Trading is not available in your region.");
  });

  it("maps a wallet rejection (EIP-1193 code 4001) to the declined sentence", () => {
    const rejection = Object.assign(new Error("User rejected the request."), { code: 4001 });
    expect(friendlySubmitError(rejection)).toMatch(/declined — nothing was submitted/);
  });

  it("maps rejection-worded errors without a code", () => {
    expect(friendlySubmitError(new Error("MetaMask Tx Signature: User denied"))).toMatch(
      /declined/,
    );
  });

  it("falls back to the raw message, then a generic sentence", () => {
    expect(friendlySubmitError(new Error("boom"))).toBe("boom");
    expect(friendlySubmitError(undefined)).toMatch(/Signing failed/);
  });

  // The reported bug: production serves HTTP/2, whose responses have no reason
  // phrase, so an ApiError built from a message-less body carries "" — which
  // used to render as a blank error banner.
  it("never returns an empty string, even for a message-less ApiError", () => {
    for (const status of [0, 400, 401, 403, 500, 502]) {
      const message = friendlySubmitError(new ApiError(status, `HTTP_${status}`, "", null));
      expect(message.trim()).not.toBe("");
    }
    expect(friendlySubmitError(new Error(""))).not.toBe("");
    expect(friendlySubmitError(null)).not.toBe("");
  });

  it("says the session died rather than blaming the order on a 401", () => {
    expect(friendlySubmitError(new ApiError(401, "Unauthorized", "", null))).toMatch(
      /session expired/i,
    );
  });

  it("explains a wallet that will not switch to Polygon (EIP-1193 4902)", () => {
    const unknownChain = Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
    expect(friendlySubmitError(unknownChain)).toMatch(/Polygon/);
  });
});
