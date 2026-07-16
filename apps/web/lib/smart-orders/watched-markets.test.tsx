import { beforeEach, describe, expect, it } from "vitest";
import type { MarketRef } from "@mx2/rules";
import { docMarketRefs, isTokenReferenced } from "./doc";
import { compileDoc } from "./compile";
import { useBuilderStore } from "./store";

const franceYes: MarketRef = { conditionId: "cond-fr", tokenId: "tok-fr-yes", outcome: "Yes" };
const btcYes: MarketRef = { conditionId: "cond-btc", tokenId: "tok-btc-yes", outcome: "Yes" };

beforeEach(() => useBuilderStore.getState().reset());

describe("watched markets", () => {
  it("addWatchedMarket adds once, stores meta and focuses the market", () => {
    const s = useBuilderStore.getState();
    s.addWatchedMarket(franceYes, { title: "France wins" });
    s.addWatchedMarket(franceYes, { title: "France wins" }); // dedupe
    const { doc, focusedMarketToken } = useBuilderStore.getState();
    expect(doc.watchedMarkets).toHaveLength(1);
    expect(doc.marketMeta["tok-fr-yes"]?.title).toBe("France wins");
    expect(focusedMarketToken).toBe("tok-fr-yes");
  });

  it("unbound refs are rejected", () => {
    useBuilderStore.getState().addWatchedMarket({ conditionId: "", tokenId: "", outcome: "YES" });
    expect(useBuilderStore.getState().doc.watchedMarkets).toHaveLength(0);
  });

  it("docMarketRefs unions watched markets after referenced ones, deduped", () => {
    const s = useBuilderStore.getState();
    s.addCondition({
      kind: "price",
      market: btcYes,
      source: "ask",
      comparator: "lte",
      threshold: 0.4,
    });
    s.addWatchedMarket(btcYes); // already referenced → deduped
    s.addWatchedMarket(franceYes);
    const refs = docMarketRefs(useBuilderStore.getState().doc);
    expect(refs.map((r) => r.tokenId)).toEqual(["tok-btc-yes", "tok-fr-yes"]);
  });

  it("removeWatchedMarket refuses while a condition references the token", () => {
    const s = useBuilderStore.getState();
    s.addWatchedMarket(franceYes);
    s.addCondition({
      kind: "price",
      market: franceYes,
      source: "ask",
      comparator: "lte",
      threshold: 0.4,
    });
    expect(isTokenReferenced(useBuilderStore.getState().doc, "tok-fr-yes")).toBe(true);
    useBuilderStore.getState().removeWatchedMarket("tok-fr-yes");
    expect(useBuilderStore.getState().doc.watchedMarkets).toHaveLength(1);

    // Unbind by removing the condition → removal now succeeds.
    const condId = useBuilderStore.getState().doc.expr.children[0]!.id;
    useBuilderStore.getState().removeNode(condId);
    useBuilderStore.getState().removeWatchedMarket("tok-fr-yes");
    expect(useBuilderStore.getState().doc.watchedMarkets).toHaveLength(0);
  });

  it("compileDoc strips watchedMarkets", () => {
    const s = useBuilderStore.getState();
    s.addWatchedMarket(franceYes);
    const compiled = compileDoc(useBuilderStore.getState().doc) as unknown as Record<
      string,
      unknown
    >;
    expect("watchedMarkets" in compiled).toBe(false);
  });
});
