import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { GammaEvent, GammaMarket, HomeFeedResponse } from "@/lib/types";
import { DiscoverySection } from "./DiscoverySection";

const market: GammaMarket = {
  id: "m1",
  question: "Will it happen?",
  description: "",
  conditionId: "0xc1",
  slug: "will-it-happen",
  image: "",
  icon: "",
  active: true,
  closed: false,
  liquidity: "10000",
  volume: "50000",
  lastTradePrice: "0.5",
  bestBid: "0.49",
  bestAsk: "0.51",
  spread: "0.02",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.5","0.5"]',
  clobTokenIds: '["t1","t2"]',
};

const event: GammaEvent = {
  id: "e1",
  ticker: "EV",
  slug: "ev",
  title: "Event title",
  description: "",
  image: "",
  icon: "",
  active: true,
  closed: false,
  volume1wk: "120000",
  markets: [market],
};

const homeFeed = {
  generatedAt: new Date().toISOString(),
  degraded: false,
  sourceCount: 1,
  candidateCount: 1,
  tuning: {},
  feeds: {
    now: { kind: "now", events: [], count: 0, candidateCount: 0, rejectedCount: 0 },
    top: { kind: "top", events: [event], count: 1, candidateCount: 1, rejectedCount: 0 },
    suggestedFavorites: {
      kind: "suggestedFavorites",
      events: [],
      count: 0,
      candidateCount: 0,
      rejectedCount: 0,
    },
  },
} as unknown as HomeFeedResponse;

const mockApis = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/api/feed/home")) return json(homeFeed);
      if (url.includes("/api/showcases")) {
        return json({ generatedAt: new Date().toISOString(), showcases: [] });
      }
      return json({ error: "NOT_FOUND" }, 404);
    }),
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DiscoverySection", () => {
  it("renders proven plays and hot-market suggestions side by side", async () => {
    mockApis();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DiscoverySection />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Proven plays")).toBeInTheDocument();
    expect(screen.getByText("Automate these markets now")).toBeInTheDocument();

    // Mid 0.50 → the dip-buy heuristic, with a one-click Build deep link.
    expect(await screen.findByText("Will it happen?")).toBeInTheDocument();
    expect(screen.getByText("Dip-buy below 45¢")).toBeInTheDocument();
    const build = screen.getByText("Build");
    expect(String(build.closest("a")?.getAttribute("href"))).toContain(
      "/smart-orders/new?prompt=",
    );

    // Left column fell back to sample plays (empty showcases) with charts.
    expect(
      await screen.findByText("Sample plays — live backtests refresh every 15 min"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "price chart" }).length).toBeGreaterThanOrEqual(1);
  });
});
