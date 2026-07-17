/**
 * Deep-link behavior of the builder shell: a ?prompt= entry must always land
 * on the AI tab (the module-level tab store survives navigation with a stale
 * tab), and ?pinned= must reach the AiPanel parsed, capped and sanitized.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { BuilderShell, parsePinnedParam } from "./BuilderShell";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { emptyDoc } from "@/lib/smart-orders/doc";

const push = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}));

// useSignIn needs a WagmiProvider; the save card is not under test here.
vi.mock("@/lib/auth", () => ({
  useSession: () => ({ data: null }),
  useSignIn: () => ({ mutate: vi.fn(), isPending: false }),
}));

// React Flow needs browser layout APIs; the canvas is not under test here.
vi.mock("./BuilderCanvas", () => ({
  default: () => <div data-testid="canvas-stub" />,
}));

// Capture what the shell plumbs into the chat without running the real one.
const aiPanelProps = vi.fn();
vi.mock("./AiPanel", () => ({
  AiPanel: (props: Record<string, unknown>) => {
    aiPanelProps(props);
    return <div data-testid="ai-panel-stub" />;
  },
}));

/** Routes /api/feature-flags (AI on) vs everything else (empty payloads). */
const mockFetch = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/feature-flags")
        ? { aiChat: true }
        : url.includes("/api/auth/me")
          ? null
          : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

const renderShell = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BuilderShell />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  aiPanelProps.mockClear();
  push.mockClear();
  useBuilderStore.getState().reset(emptyDoc());
  mockFetch();
});

describe("BuilderShell deep links", () => {
  it("?prompt= lands on the AI tab even when the store held another tab", async () => {
    searchParams = new URLSearchParams({ prompt: "buy the dip on btc" });
    useBuilderStore.getState().setActiveTab("settings");
    renderShell();

    await waitFor(() => expect(useBuilderStore.getState().activeTab).toBe("ai"));
    expect(aiPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialPrompt: "buy the dip on btc" }),
    );
  });

  it("parses ?pinned= and forwards it to the AI panel", async () => {
    searchParams = new URLSearchParams({
      prompt: "hedge these",
      pinned: "cond-a~France%20wins,malformed,cond-b~Spain%20wins",
    });
    renderShell();

    await waitFor(() =>
      expect(aiPanelProps).toHaveBeenCalledWith(
        expect.objectContaining({
          initialPinned: [
            { conditionId: "cond-a", title: "France wins" },
            { conditionId: "cond-b", title: "Spain wins" },
          ],
        }),
      ),
    );
  });
});

describe("parsePinnedParam", () => {
  it("caps at 4 entries and drops malformed ones", () => {
    const raw = [
      "c1~One",
      "c2~Two",
      "no-separator",
      "~NoId",
      "c3~",
      "c4~Fo%20ur",
      "c5~Five",
      "c6~Six",
    ].join(",");
    expect(parsePinnedParam(raw)).toEqual([
      { conditionId: "c1", title: "One" },
      { conditionId: "c2", title: "Two" },
      { conditionId: "c4", title: "Fo ur" },
      { conditionId: "c5", title: "Five" },
    ]);
  });

  it("drops broken percent-encoding and returns [] for null", () => {
    expect(parsePinnedParam("c1~%E0%A4%A")).toEqual([]);
    expect(parsePinnedParam(null)).toEqual([]);
  });
});
