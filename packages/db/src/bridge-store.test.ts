import { describe, expect, it } from "vitest";
import {
  BRIDGE_WITHDRAWAL_STATE_RANK,
  WITHDRAWAL_TERMINAL,
  bridgeWithdrawalStateFromRelayer,
  depositStateFromProvider,
} from "./bridge-store.js";

// The Polygon-leg relayer poll is the only writer of polygon_confirmed /
// failed_polygon — the mapping and rank tables below are what keep it from
// regressing rows the Bridge status pass already advanced.
describe("bridgeWithdrawalStateFromRelayer", () => {
  it("maps mined/confirmed to polygon_confirmed", () => {
    expect(bridgeWithdrawalStateFromRelayer("STATE_MINED")).toBe("polygon_confirmed");
    expect(bridgeWithdrawalStateFromRelayer("STATE_CONFIRMED")).toBe("polygon_confirmed");
  });

  it("maps failed/invalid to failed_polygon", () => {
    expect(bridgeWithdrawalStateFromRelayer("STATE_FAILED")).toBe("failed_polygon");
    expect(bridgeWithdrawalStateFromRelayer("STATE_INVALID")).toBe("failed_polygon");
  });

  it("maps non-final and unknown states to null (no transition)", () => {
    expect(bridgeWithdrawalStateFromRelayer("STATE_NEW")).toBeNull();
    expect(bridgeWithdrawalStateFromRelayer("STATE_EXECUTED")).toBeNull();
    expect(bridgeWithdrawalStateFromRelayer("SOMETHING_ELSE")).toBeNull();
  });
});

describe("bridge withdrawal state machine tables", () => {
  it("ranks the happy path strictly forward", () => {
    const path = [
      "requested",
      "address_created",
      "polygon_submitted",
      "polygon_confirmed",
      "bridging",
      "completed",
    ];
    for (let i = 1; i < path.length; i += 1) {
      expect(BRIDGE_WITHDRAWAL_STATE_RANK[path[i]!]!).toBeGreaterThan(
        BRIDGE_WITHDRAWAL_STATE_RANK[path[i - 1]!]!,
      );
    }
  });

  it("polygon_confirmed never outranks bridging (late relayer poll cannot regress)", () => {
    expect(BRIDGE_WITHDRAWAL_STATE_RANK["polygon_confirmed"]!).toBeLessThan(
      BRIDGE_WITHDRAWAL_STATE_RANK["bridging"]!,
    );
  });

  it("terminal set covers completed and every failure leg", () => {
    expect([...WITHDRAWAL_TERMINAL].sort()).toEqual([
      "completed",
      "failed_address",
      "failed_bridge",
      "failed_polygon",
    ]);
  });
});

describe("depositStateFromProvider", () => {
  it("covers every documented provider status", () => {
    expect(depositStateFromProvider("DEPOSIT_DETECTED")).toBe("detected");
    expect(depositStateFromProvider("PROCESSING")).toBe("processing");
    expect(depositStateFromProvider("ORIGIN_TX_CONFIRMED")).toBe("origin_confirmed");
    expect(depositStateFromProvider("SUBMITTED")).toBe("submitted");
    expect(depositStateFromProvider("COMPLETED")).toBe("completed");
    expect(depositStateFromProvider("FAILED")).toBe("failed");
  });

  it("buckets unknown provider statuses into processing", () => {
    expect(depositStateFromProvider("SOME_FUTURE_STATUS")).toBe("processing");
  });
});
