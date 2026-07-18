/**
 * Deep-link behavior of the builder shell: a ?prompt= entry must always land
 * on the AI tab (the module-level tab store survives navigation with a stale
 * tab), ?pinned= must reach the AiPanel parsed, capped and sanitized, and —
 * the draft-loss regression — no entry mode may overwrite in-progress work.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { BuilderShell, parsePinnedParam } from "./BuilderShell";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { emptyDoc } from "@/lib/smart-orders/doc";
import { loadDraftLocal } from "@/lib/smart-orders/drafts";

const push = vi.fn();
const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
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
  replace.mockClear();
  window.localStorage.clear();
  useBuilderStore.getState().reset(emptyDoc());
  useBuilderStore.setState({
    draftId: null,
    draftOrigin: "blank",
    pristine: true,
    dirty: false,
    aiMessages: [],
    aiHistory: [],
  });
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

  // THE draft-loss regression: entering via a homepage preset used to reset()
  // the module-level store, silently wiping a custom strategy in progress.
  it("?template= forks into a new draft instead of overwriting dirty work", async () => {
    searchParams = new URLSearchParams({ template: "anything" });
    // In-progress custom work from a previous visit lives in the module store.
    const customId = useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("My custom play");
    renderShell();

    await waitFor(() => expect(useBuilderStore.getState().draftId).not.toBe(customId));
    // The custom draft survived, flushed to localStorage, unchanged.
    expect(loadDraftLocal(customId)?.doc.name).toBe("My custom play");
    // The template landed on a fresh draft and the URL was canonicalized.
    expect(useBuilderStore.getState().doc.name).not.toBe("My custom play");
    expect(replace).toHaveBeenCalledWith(
      expect.stringContaining("/smart-orders/new?draft="),
      expect.objectContaining({ scroll: false }),
    );
  });

  it("bare /smart-orders/new keeps this session's live canvas", async () => {
    searchParams = new URLSearchParams();
    const liveId = useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("Still working on this");
    renderShell();

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`/smart-orders/new?draft=${liveId}`, {
        scroll: false,
      }),
    );
    expect(useBuilderStore.getState().draftId).toBe(liveId);
    expect(useBuilderStore.getState().doc.name).toBe("Still working on this");
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
