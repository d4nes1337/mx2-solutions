import { describe, expect, it } from "vitest";
import { createLogger } from "@mx2/observability";
import { createInProcessEventBus } from "./event-bus.js";

const logger = createLogger({ name: "event-bus-test", level: "silent" });

describe("event bus fan-out", () => {
  it("delivers events only to the matching wallet, case-insensitively", () => {
    const bus = createInProcessEventBus(logger);
    const mine: unknown[] = [];
    const theirs: unknown[] = [];
    bus.subscribe("0xABCD", (e) => mine.push(e));
    bus.subscribe("0xother", (e) => theirs.push(e));

    bus.publish({ kind: "rule.triggered", walletAddress: "0xabcd", triggerId: "t1" });
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it("drops events without a wallet (never broadcast)", () => {
    const bus = createInProcessEventBus(logger);
    const seen: unknown[] = [];
    bus.subscribe("0xabcd", (e) => seen.push(e));
    bus.publish({ kind: "rule.triggered" });
    expect(seen).toHaveLength(0);
  });

  it("unsubscribe stops delivery; a throwing subscriber never blocks others", () => {
    const bus = createInProcessEventBus(logger);
    const seen: unknown[] = [];
    bus.subscribe("0xabcd", () => {
      throw new Error("bad subscriber");
    });
    const unsub = bus.subscribe("0xabcd", (e) => seen.push(e));
    bus.publish({ kind: "k", walletAddress: "0xabcd" });
    expect(seen).toHaveLength(1);
    unsub();
    bus.publish({ kind: "k", walletAddress: "0xabcd" });
    expect(seen).toHaveLength(1);
  });
});
