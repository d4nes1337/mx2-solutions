import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * Route the fetch mock by URL: flags, showcases, market search (mention
 * dropdown + demo binding) and prices-history (empty → binding stays
 * synthetic, deterministic). Everything else 404s.
 */
const mockApis = (opts: { aiChat: boolean; showcases: ShowcasesResponse | "error" }) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/api/feature-flags")) return json(flagsResponse(opts.aiChat));
      if (url.includes("/api/showcases")) {
        return opts.showcases === "error"
          ? json({ error: "UPSTREAM_ERROR", message: "down" }, 502)
          : json(opts.showcases);
      }
      if (url.includes("/api/markets/search")) return json(searchResults);
      if (url.includes("/api/markets/prices-history")) {
        return json({ tokenId: "tok-fr-yes", history: [] });
      }
      return json({ error: "NOT_FOUND" }, 404);
    }),
  );

/** Static demo (prefers-reduced-motion) → deterministic renders, no 35ms timer. */
const stubReducedMotion = () =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );

const renderHero = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Hero />
    </QueryClientProvider>,
  );
};

beforeEach(() => stubReducedMotion());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("Hero (centered, identity-first)", () => {
  it("always leads with the identity line and trust copy", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();
    expect(await screen.findByText(/If this,/)).toBeInTheDocument();
    expect(screen.getByText(/conditional strategies engine for Polymarket/)).toBeInTheDocument();
    expect(screen.getByText("Nothing trades without your signature.")).toBeInTheDocument();
    expect(screen.getByText("Build manually")).toBeInTheDocument();
  });

  it("degrades to market search + static preview when the AI flag is off", async () => {
    mockApis({ aiChat: false, showcases: "error" });
    renderHero();
    expect(await screen.findByLabelText("Search markets")).toBeInTheDocument();
    expect(screen.queryByText("Build it")).not.toBeInTheDocument();
    expect(screen.getByText("Strategy · Re-entry")).toBeInTheDocument();
  });

  it("deep-links the prompt on submit", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();

    const button = await screen.findByText("Build it");
    const box = screen.getByLabelText("Describe your strategy");
    fireEvent.change(box, { target: { value: "buy YES on fed cuts below 40¢" } });
    fireEvent.click(button);

    expect(push).toHaveBeenCalledWith(
      `/strategies/new?prompt=${encodeURIComponent("buy YES on fed cuts below 40¢")}`,
    );
  });

  it("does not navigate on an empty prompt", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();
    fireEvent.click(await screen.findByText("Build it"));
    expect(push).not.toHaveBeenCalled();
  });

  it("capability chips insert a teaching phrase into the composer", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();
    const box = await screen.findByLabelText("Describe your strategy");
    fireEvent.click(screen.getByText("volume & liquidity"));
    expect((box as HTMLTextAreaElement).value).toContain("at least $2k of liquidity");
  });

  it("@-mention: picking a market pins a chip and rides along in ?pinned=", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();

    const box = await screen.findByLabelText("Describe your strategy");
    fireEvent.change(box, { target: { value: "buy the dip on @fra" } });

    // Dropdown row appears from the mocked search (debounced 250ms).
    const row = await screen.findByText("Will France win the World Cup?");
    fireEvent.click(row);

    expect((box as HTMLTextAreaElement).value).toContain('@"Will France win the World Cup?"');
    expect(screen.getByLabelText(/Unpin Will France win/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Build it"));
    expect(push).toHaveBeenCalledTimes(1);
    const url = String(push.mock.calls[0]![0]);
    expect(url).toContain("/strategies/new?prompt=");
    expect(url).toContain(
      `&pinned=cond-france~${encodeURIComponent("Will France win the World Cup?")}`,
    );
  });

  it("a pasted Polymarket link resolves to a pinned market instead of URL noise", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();
    const box = await screen.findByLabelText("Describe your strategy");
    fireEvent.paste(box, {
      clipboardData: {
        getData: () => "https://polymarket.com/event/will-france-win-the-world-cup",
      },
    });
    expect(await screen.findByLabelText(/Unpin Will France win/)).toBeInTheDocument();
    expect((box as HTMLTextAreaElement).value).not.toContain("polymarket.com");
  });

  it("plays the demo in the preview block: typed bubble + chips + dots", async () => {
    mockApis({ aiChat: true, showcases: "error" });
    renderHero();

    // Reduced motion → first scenario fully revealed and static. The market
    // name shows in the typed bubble, the action chip and the bound-market
    // line — all derived from the same player state.
    expect((await screen.findAllByText(/Trump-Iran market/)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Demo · News-momentum cross-market")).toBeInTheDocument();
    expect(screen.getByText("then")).toBeInTheDocument(); // logic chip revealed
    expect(screen.getByText(/Build this/)).toBeInTheDocument();
    // Synthetic binding (empty history) is captioned honestly.
    expect(screen.getByText(/Illustrative price path/)).toBeInTheDocument();

    // Manual dots swap the scenario.
    fireEvent.click(screen.getByLabelText("Show demo 2 of 5"));
    expect(await screen.findByText("Demo · Maker range farming")).toBeInTheDocument();
    expect(screen.getAllByText(/Spain wins the World Cup/).length).toBeGreaterThanOrEqual(2);
  });
});
