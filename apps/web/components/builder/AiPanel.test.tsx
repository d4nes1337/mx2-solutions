import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StrategyDefinition } from "@mx2/rules";
import { AiPanel } from "./AiPanel";
import { useBuilderStore } from "@/lib/smart-orders/store";

const definition: StrategyDefinition = {
  version: 2,
  name: "Buy the dip",
  templateId: "ai",
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
          market: { conditionId: "cond-btc", tokenId: "tok-btc", outcome: "Yes" },
          source: "ask",
          comparator: "lte",
          threshold: 0.45,
        },
      },
    ],
  },
  holdsForMs: 300_000,
  maxDataAgeMs: 5_000,
  action: {
    kind: "order",
    market: { conditionId: "cond-btc", tokenId: "tok-btc", outcome: "Yes" },
    side: "BUY",
    price: 0.44,
    size: 100,
    orderType: "GTC",
    execution: "prepare",
  },
  recurrence: { kind: "once" },
  limits: null,
  expiresAtMs: null,
};

const okResponse = {
  status: "ok",
  definition,
  summary: "Buys 100 Yes shares when the price dips below 45¢ for 5 minutes.",
  warnings: ["Heads up: your order price is far from the current price."],
  markets: {
    "tok-btc": {
      title: "Will BTC hit $150k in 2026?",
      outcome: "Yes",
      rewardsMinSize: null,
      rewardsMaxSpread: null,
    },
  },
};

const searchResults = {
  results: [
    {
      eventId: "ev-1",
      marketId: "m-1",
      title: "Will France win the World Cup?",
      eventTitle: "World Cup winner",
      image: "",
      conditionId: "cond-france",
      tokenIds: ["tok-fr-yes", "tok-fr-no"],
      outcomes: ["Yes", "No"],
      outcomePrices: ["0.39", "0.61"],
      volume: "215000000",
      liquidity: "90000",
      endDate: null,
      negRisk: false,
      rewardsMinSize: null,
      rewardsMaxSpread: null,
    },
  ],
};

/** Routes /api/ai/generate-strategy vs /api/markets/search by URL. */
const mockFetch = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/markets/search")) {
        return new Response(JSON.stringify(searchResults), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

const renderPanel = (initialPrompt?: string) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AiPanel initialPrompt={initialPrompt ?? null} />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  useBuilderStore.getState().reset();
});
afterEach(() => vi.restoreAllMocks());

describe("AiPanel", () => {
  it("auto-fires the ?prompt= deep link and fills the builder store", async () => {
    mockFetch(200, okResponse);
    renderPanel("buy the dip on btc");

    await waitFor(() => {
      expect(useBuilderStore.getState().doc.expr.children).toHaveLength(1);
    });
    const doc = useBuilderStore.getState().doc;
    expect(doc.name).toBe("Buy the dip");
    expect(doc.marketMeta["tok-btc"]?.title).toContain("BTC");
    expect(useBuilderStore.getState().revealTick).toBe(1);
    // Summary + warning surface in the panel.
    expect(await screen.findByText(/dips below 45¢/)).toBeInTheDocument();
    expect(screen.getByText(/far from the current price/)).toBeInTheDocument();
  });

  it("renders clarify questions without touching the canvas", async () => {
    mockFetch(200, { status: "clarify", question: "Which market do you mean?" });
    renderPanel("do something");

    expect(await screen.findByText("Which market do you mean?")).toBeInTheDocument();
    expect(useBuilderStore.getState().doc.expr.children).toHaveLength(0);
  });

  it("shows the daily-limit copy and template fallback on 429", async () => {
    mockFetch(429, { error: "RATE_LIMITED", message: "Too many requests" });
    renderPanel("buy the dip on btc");

    expect(await screen.findByText(/free AI limit/)).toBeInTheDocument();
    // Template chips offer a non-AI path forward.
    expect(screen.getByText("Dip buy")).toBeInTheDocument();
  });

  it("@-mention: typing @fra surfaces markets; picking pins a chip and rewrites the input", async () => {
    mockFetch(200, okResponse);
    renderPanel();

    const box = screen.getByLabelText("Describe your strategy");
    fireEvent.change(box, { target: { value: "buy the dip on @fra" } });

    // Dropdown row appears from the mocked search.
    const row = await screen.findByText("Will France win the World Cup?");
    fireEvent.click(row);

    // Input rewritten with the quoted title; chip pinned.
    expect((box as HTMLTextAreaElement).value).toContain('@"Will France win the World Cup?"');
    expect(screen.getByLabelText(/Unpin Will France win/)).toBeInTheDocument();

    // Submitting includes the pinned conditionIds in the request body.
    fireEvent.click(screen.getByLabelText("Generate strategy"));
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as [
        RequestInfo | URL,
        RequestInit?,
      ][];
      const gen = calls.find(([u]) => String(u).includes("/api/ai/generate-strategy"));
      expect(gen).toBeDefined();
      expect(String(gen![1]?.body)).toContain('"pinnedConditionIds":["cond-france"]');
    });
  });

  // Regression: mutating synchronously inside the mount effect loses the settle
  // notification under React StrictMode (Next dev/prod default) — the panel
  // then spins forever. The auto-fire must be deferred out of the mount phase.
  it("settles the auto-fired generation under StrictMode (error path)", async () => {
    mockFetch(502, { error: "AI_UPSTREAM", message: "unavailable" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <AiPanel initialPrompt="buy the dip on btc" />
        </QueryClientProvider>
      </StrictMode>,
    );
    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument();
    // The deferred timer + ref guard must not double-fire the request.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
