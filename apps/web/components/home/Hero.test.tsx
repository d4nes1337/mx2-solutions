import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ShowcasesResponse } from "@/lib/types";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { Hero } from "./Hero";

const flagsResponse = (aiChat: boolean) => ({
  liveTrading: false,
  conditionalRules: true,
  smartOrdersV2: true,
  conditionalLiveExecution: false,
  relayer: false,
  privySigning: false,
  aiChat,
  openBeta: aiChat,
});

const showcase = {
  id: "cond-btc:5",
  market: {
    title: "Will BTC hit $150k in 2026?",
    image: "",
    conditionId: "cond-btc",
    tokenId: "tok-1",
    outcome: "Yes",
    currentPriceCents: 50,
  },
  sentence: "If Yes dips below 45¢ and holds 15 min → buy $100 at 45¢",
  definition: {
    version: 2,
    name: "Dip-buy: BTC",
    templateId: "showcase",
    expr: {
      type: "group",
      id: "root",
      op: "and",
      children: [
        {
          type: "condition",
          id: "c1",
          condition: {
            kind: "price",
            market: { conditionId: "cond-btc", tokenId: "tok-1", outcome: "Yes" },
            source: "ask",
            comparator: "lte",
            threshold: 0.45,
          },
        },
      ],
    },
    holdsForMs: 900_000,
    maxDataAgeMs: 5_000,
    action: {
      kind: "order",
      market: { conditionId: "cond-btc", tokenId: "tok-1", outcome: "Yes" },
      side: "BUY",
      price: 0.45,
      size: 222,
      orderType: "GTC",
      execution: "prepare",
    },
    recurrence: { kind: "once" },
    limits: null,
    expiresAtMs: null,
  },
  stats: { stakeUsd: 100, hypotheticalPnlUsd: 18.5, triggerCount: 3, windowDays: 30 },
  series: [
    { t: 1_750_000_000, p: 0.5 },
    { t: 1_750_100_000, p: 0.44 },
    { t: 1_750_200_000, p: 0.6 },
  ],
  triggers: [{ t: 1_750_100_000_000, price: 0.44 }],
};

/** Route the fetch mock by URL: flags, showcases, everything else 404s. */
const mockApis = (opts: { aiChat: boolean; showcases: ShowcasesResponse | "error" }) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/feature-flags")) {
        return new Response(JSON.stringify(flagsResponse(opts.aiChat)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/showcases")) {
        if (opts.showcases === "error") {
          return new Response(JSON.stringify({ error: "UPSTREAM_ERROR", message: "down" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(opts.showcases), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    }),
  );

const oneShowcase: ShowcasesResponse = {
  generatedAt: new Date().toISOString(),
  showcases: [showcase as unknown as ShowcasesResponse["showcases"][number]],
};

const renderHero = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Hero />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.restoreAllMocks();
  push.mockReset();
});

describe("Hero", () => {
  it("keeps the classic hero when the AI flag is off", async () => {
    mockApis({ aiChat: false, showcases: "error" });
    renderHero();
    expect(await screen.findByText("Create Smart Order")).toBeInTheDocument();
    expect(screen.queryByText("Build it")).not.toBeInTheDocument();
  });

  it("shows the prompt card when the AI flag is on and deep-links the prompt", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();

    const button = await screen.findByText("Build it");
    const box = screen.getByLabelText("Describe your trading idea");
    fireEvent.change(box, { target: { value: "buy YES on fed cuts below 40¢" } });
    fireEvent.click(button);

    expect(push).toHaveBeenCalledWith(
      `/smart-orders/new?prompt=${encodeURIComponent("buy YES on fed cuts below 40¢")}`,
    );
  });

  it("does not navigate on an empty prompt", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();
    fireEvent.click(await screen.findByText("Build it"));
    expect(push).not.toHaveBeenCalled();
  });

  it("falls back to the static preview when showcases are unavailable", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();
    // The hardcoded marketing mock is the graceful fallback.
    expect(await screen.findByText("Smart Order · Re-entry")).toBeInTheDocument();
    expect(screen.queryByText(/Open this strategy/)).not.toBeInTheDocument();
  });

  it("renders a LIVE showcase with real backtest numbers when available", async () => {
    mockApis({ aiChat: true, showcases: oneShowcase });
    renderHero();
    expect(await screen.findByText(/Open this strategy/)).toBeInTheDocument();
    expect(screen.getByText("Will BTC hit $150k in 2026?")).toBeInTheDocument();
    expect(screen.getByText(/\+\$18\.50/)).toBeInTheDocument();
    expect(screen.getByText(/across 3 × \$100 dip-buys/)).toBeInTheDocument();
    // The prompt appears both as an example chip and in the carousel bubble.
    expect(screen.getAllByText(/Buy the dip on Will BTC hit/).length).toBeGreaterThanOrEqual(1);
    // The honesty label is non-negotiable (R-023).
    expect(screen.getByText(/past performance doesn/i)).toBeInTheDocument();
  });

  it("rotates showcases via the carousel and seeds the prompt box on request", async () => {
    const second = {
      ...showcase,
      id: "cond-eth:5",
      prompt: 'Buy $100 of Yes on "ETH flips BTC?" if the price dips to 30¢',
      market: { ...showcase.market, title: "ETH flips BTC?", conditionId: "cond-eth" },
    };
    mockApis({
      aiChat: true,
      showcases: {
        generatedAt: new Date().toISOString(),
        showcases: [showcase, second] as unknown as ShowcasesResponse["showcases"],
      },
    });
    renderHero();

    // Two showcases → dots + arrows appear; first card is the top showcase.
    expect(await screen.findByText("Will BTC hit $150k in 2026?")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show strategy 2 of 2"));
    expect(await screen.findByText("ETH flips BTC?")).toBeInTheDocument();

    // Its chat prompt is shown and can be pushed into the prompt box.
    fireEvent.click(screen.getByText("Try this prompt"));
    const box = screen.getByLabelText<HTMLTextAreaElement>("Describe your trading idea");
    expect(box.value).toContain("ETH flips BTC?");
  });

  it("shows no carousel controls for a single showcase", async () => {
    mockApis({ aiChat: true, showcases: oneShowcase });
    renderHero();
    expect(await screen.findByText(/Open this strategy/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Next strategy")).not.toBeInTheDocument();
  });
});
