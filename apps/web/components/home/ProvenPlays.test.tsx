import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ShowcasesResponse } from "@/lib/types";
import { ProvenPlays } from "./ProvenPlays";

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
  prompt: 'Buy $100 of Yes on "Will BTC hit $150k in 2026?" if the price dips to 45¢',
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

const mockShowcases = (body: ShowcasesResponse | "error") =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/showcases")) {
        return body === "error"
          ? new Response(JSON.stringify({ error: "UPSTREAM_ERROR", message: "down" }), {
              status: 502,
              headers: { "Content-Type": "application/json" },
            })
          : new Response(JSON.stringify(body), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    }),
  );

const renderPlays = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProvenPlays />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProvenPlays", () => {
  it("renders a LIVE backtested showcase with its chart and honesty label", async () => {
    mockShowcases({
      generatedAt: new Date().toISOString(),
      showcases: [showcase as unknown as ShowcasesResponse["showcases"][number]],
    });
    renderPlays();

    expect(await screen.findByText("Will BTC hit $150k in 2026?")).toBeInTheDocument();
    expect(screen.getByText("Proven plays")).toBeInTheDocument();
    expect(screen.getByText(/Backtested on the last 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/\+\$18\.50/)).toBeInTheDocument();
    expect(screen.getByText(/across 3 × \$100 dip-buys/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "price chart" })).toBeInTheDocument();
    // The honesty label is non-negotiable (R-023).
    expect(screen.getByText(/past performance doesn/i)).toBeInTheDocument();
    expect(screen.getByText(/Open this strategy/)).toHaveAttribute(
      "href",
      `/smart-orders/new?showcase=${encodeURIComponent("cond-btc:5")}`,
    );
  });

  it("empty showcases → sample cards keep their charts, captioned as samples", async () => {
    mockShowcases({ generatedAt: new Date().toISOString(), showcases: [] });
    renderPlays();

    expect(
      await screen.findByText("Sample plays — live backtests refresh every 15 min"),
    ).toBeInTheDocument();
    // A chart still renders (never the chartless template gallery).
    expect(screen.getByRole("img", { name: "price chart" })).toBeInTheDocument();
    expect(screen.queryByText("Start from a template")).not.toBeInTheDocument();
    expect(screen.getByText("Will the Fed cut rates in September?")).toBeInTheDocument();
    expect(screen.getByText(/past performance doesn/i)).toBeInTheDocument();

    // Sample cards deep-link their prompt (sample ids don't resolve).
    expect(String(screen.getByText(/Open this strategy/).getAttribute("href"))).toContain(
      "/smart-orders/new?prompt=",
    );

    // All three curated samples are reachable via the dots.
    fireEvent.click(screen.getByLabelText("Show strategy 2 of 3"));
    expect(await screen.findByText("Will Team Spirit win the CS2 Major?")).toBeInTheDocument();
  });

  it("showcase API error → same sample fallback", async () => {
    mockShowcases("error");
    renderPlays();
    expect(
      await screen.findByText("Sample plays — live backtests refresh every 15 min"),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "price chart" })).toBeInTheDocument();
  });
});
