import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StrategyDefinition } from "@mx2/rules";
import { AiPanel } from "./AiPanel";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { loadDraftLocal } from "@/lib/smart-orders/drafts";

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
    {
      eventId: "ev-2",
      marketId: "m-2",
      title: "Will Spain win the World Cup?",
      eventTitle: "World Cup winner",
      image: "",
      conditionId: "cond-spain",
      tokenIds: ["tok-es-yes", "tok-es-no"],
      outcomes: ["Yes", "No"],
      outcomePrices: ["0.22", "0.78"],
      volume: "150000000",
      liquidity: "50000",
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

const renderPanel = (
  initialPrompt?: string,
  initialPinned?: { conditionId: string; title: string }[],
) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AiPanel
        initialPrompt={initialPrompt ?? null}
        {...(initialPinned ? { initialPinned } : {})}
      />
    </QueryClientProvider>,
  );
};

/** Calls made to the generate endpoint (URL + init pairs). */
const genCalls = () =>
  (
    (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as [RequestInfo | URL, RequestInit?][]
  ).filter(([u]) => String(u).includes("/api/ai/generate-strategy"));

beforeEach(() => {
  window.localStorage.clear();
  useBuilderStore.getState().reset();
  // Chat + draft identity live in the module store now — reset per test.
  useBuilderStore.setState({
    draftId: null,
    draftOrigin: "blank",
    pristine: true,
    dirty: false,
    aiMessages: [],
    aiHistory: [],
  });
  useBuilderStore.getState().setAiStatus("idle");
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
    // Deep-link failures get the softer draft-first copy plus a Retry chip.
    expect(await screen.findByText(/couldn't draft that/i)).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    // The deferred timer + ref guard must not double-fire the request.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("renders assistant summaries as markdown, user turns as plain text", async () => {
    mockFetch(200, {
      ...okResponse,
      summary: "Bound **the BTC market**.\n\n- Buys 100 Yes\n- Exit below 45¢",
    });
    const { container } = renderPanel("draft **something** for btc");

    await screen.findByText(/the BTC market/);
    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("the BTC market");
    expect(container.querySelectorAll("li")).not.toHaveLength(0);
    // The user bubble keeps the raw asterisks (no markdown for user turns).
    expect(screen.getByText("draft **something** for btc")).toBeInTheDocument();
  });

  it("open-question chips prefill and focus the composer", async () => {
    mockFetch(200, {
      ...okResponse,
      openQuestions: ["Should the budget be $100?", "Keep the 5-minute hold?"],
    });
    renderPanel("buy the dip on btc");

    expect(await screen.findByText("I assumed / quick questions")).toBeInTheDocument();
    const chip = screen.getByText("Should the budget be $100?");
    fireEvent.click(chip);

    const box = screen.getByLabelText("Describe your strategy") as HTMLTextAreaElement;
    expect(box.value).toBe("Should the budget be $100?");
    expect(document.activeElement).toBe(box);
  });

  it("Retry re-submits the last prompt and tracks aiStatus through the failure", async () => {
    mockFetch(502, { error: "AI_UPSTREAM", message: "unavailable" });
    renderPanel();

    const box = screen.getByLabelText("Describe your strategy");
    fireEvent.change(box, { target: { value: "buy the dip on btc" } });
    fireEvent.click(screen.getByLabelText("Generate strategy"));
    expect(useBuilderStore.getState().aiStatus).toBe("drafting");

    // Manual submits keep the generic copy (deep-link copy is deep-link only).
    expect(await screen.findByText(/unreachable/i)).toBeInTheDocument();
    expect(useBuilderStore.getState().aiStatus).toBe("error");

    fireEvent.click(screen.getByText("Retry"));
    expect(useBuilderStore.getState().aiStatus).toBe("drafting");
    await waitFor(() => expect(genCalls()).toHaveLength(2));
    const prompts = genCalls().map(([, init]) => JSON.parse(String(init?.body)).prompt);
    expect(prompts).toEqual(["buy the dip on btc", "buy the dip on btc"]);
  });

  it("aiStatus returns to idle after a successful draft", async () => {
    mockFetch(200, okResponse);
    renderPanel("buy the dip on btc");
    await waitFor(() => expect(useBuilderStore.getState().aiStatus).toBe("idle"));
    expect(useBuilderStore.getState().doc.expr.children).toHaveLength(1);
  });

  // Draft isolation: the first AI turn over a hand-edited canvas must fork
  // into a new draft (manual work survives on its own) instead of replacing it.
  it("first AI turn over hand-edited work forks; the manual draft survives", async () => {
    mockFetch(200, okResponse);
    const handBuiltId = useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("Hand built");
    useBuilderStore.getState().addCondition({
      kind: "price",
      market: { conditionId: "cond-x", tokenId: "tok-x", outcome: "YES" },
      source: "ask",
      comparator: "lte",
      threshold: 0.5,
    });
    renderPanel();

    const box = screen.getByLabelText("Describe your strategy");
    fireEvent.change(box, { target: { value: "buy the dip on btc" } });
    fireEvent.click(screen.getByLabelText("Generate strategy"));

    await waitFor(() => expect(useBuilderStore.getState().draftId).not.toBe(handBuiltId));
    // The manual draft was flushed intact before the AI result took over.
    const rec = loadDraftLocal(handBuiltId);
    expect(rec?.doc.name).toBe("Hand built");
    expect(rec?.doc.expr.children).toHaveLength(1);
    // The conversation moved with the fork (user + assistant turns visible).
    expect(useBuilderStore.getState().aiMessages.length).toBeGreaterThanOrEqual(2);
    expect(useBuilderStore.getState().doc.name).toBe("Buy the dip");
  });

  it("seeds initialPinned before the auto-fired deep link submits", async () => {
    mockFetch(200, okResponse);
    renderPanel("buy the dip on btc", [{ conditionId: "cond-seeded", title: "Seeded market" }]);

    await waitFor(() => {
      const gen = genCalls()[0];
      expect(gen).toBeDefined();
      expect(String(gen![1]?.body)).toContain('"pinnedConditionIds":["cond-seeded"]');
    });
    expect(screen.getByLabelText("Unpin Seeded market")).toBeInTheDocument();
  });

  it("@-mention allows internal spaces and ends on a double space", async () => {
    mockFetch(200, okResponse);
    renderPanel();

    const box = screen.getByLabelText("Describe your strategy");
    fireEvent.change(box, { target: { value: "buy @world cu" } });
    await screen.findByText("Will France win the World Cup?");

    const searches = (
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as [RequestInfo | URL][]
    ).filter(([u]) => String(u).includes("/api/markets/search"));
    expect(String(searches.at(-1)![0])).toContain("q=world%20cu");

    fireEvent.change(box, { target: { value: "buy @world cup  " } });
    expect(screen.queryByText("Will France win the World Cup?")).not.toBeInTheDocument();
  });

  it("Escape dismisses the dropdown and the same token stays dismissed", async () => {
    mockFetch(200, okResponse);
    renderPanel();

    const box = screen.getByLabelText("Describe your strategy");
    fireEvent.change(box, { target: { value: "@world cup" } });
    await screen.findByText("Will France win the World Cup?");

    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByText("Will France win the World Cup?")).not.toBeInTheDocument();

    // Growing the same token must not reopen it (past the debounce window).
    fireEvent.change(box, { target: { value: "@world cup fin" } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(screen.queryByText("Will France win the World Cup?")).not.toBeInTheDocument();
  });

  it("arrow keys move the mention cursor and Enter picks the active row", async () => {
    mockFetch(200, okResponse);
    renderPanel();

    const box = screen.getByLabelText("Describe your strategy");
    fireEvent.change(box, { target: { value: "@world" } });
    await screen.findByText("Will Spain win the World Cup?");

    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toContain('@"Will Spain win the World Cup?"');
    expect(screen.getByLabelText(/Unpin Will Spain/)).toBeInTheDocument();
  });
});
