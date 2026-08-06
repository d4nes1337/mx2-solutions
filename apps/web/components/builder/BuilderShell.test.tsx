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
import { useBuilderStore } from "@/lib/strategies/store";
import { emptyDoc } from "@/lib/strategies/doc";
import { loadDraftLocal } from "@/lib/strategies/drafts";

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

  it("?template= lands on a fresh draft and canonicalizes the URL", async () => {
    searchParams = new URLSearchParams({ template: "anything" });
    const previousId = useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("My custom play");
    renderShell();

    await waitFor(() => expect(useBuilderStore.getState().draftId).not.toBe(previousId));
    expect(useBuilderStore.getState().doc.name).not.toBe("My custom play");
    expect(replace).toHaveBeenCalledWith(
      expect.stringContaining("/strategies/new?draft="),
      expect.objectContaining({ scroll: false }),
    );
  });

  // Owner decision 2026-07-31: entering the builder is always a fresh start.
  // It used to resume the live canvas (and, failing that, the most recent
  // draft, and failing THAT scaffold a default template) — so a bare visit
  // dropped the user inside a strategy they hadn't asked to open.
  it("bare /strategies/new opens blank, not the session's last canvas", async () => {
    searchParams = new URLSearchParams();
    const liveId = useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("Still working on this");
    renderShell();

    await waitFor(() => expect(useBuilderStore.getState().doc.name).toBe(""));
    expect(useBuilderStore.getState().draftId).not.toBe(liveId);
    expect(useBuilderStore.getState().doc.expr.children).toHaveLength(0);
    expect(useBuilderStore.getState().draftOrigin).toBe("blank");
  });

  it("does not resume the most recent saved draft on a bare visit", async () => {
    const savedId = useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("Saved yesterday");
    useBuilderStore.getState().saveDraftNow();
    useBuilderStore.setState({ draftId: null, dirty: false, pristine: true });
    useBuilderStore.getState().reset(emptyDoc());
    searchParams = new URLSearchParams();
    renderShell();

    await waitFor(() => expect(useBuilderStore.getState().draftId).not.toBeNull());
    expect(useBuilderStore.getState().draftId).not.toBe(savedId);
    expect(useBuilderStore.getState().doc.name).toBe("");
    // …but it is still there to reopen from the picker.
    expect(loadDraftLocal(savedId)?.doc.name).toBe("Saved yesterday");
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

describe("BuilderShell canvas strip", () => {
  it("shows the grid and the canvas together, and remembers the strip height", async () => {
    searchParams = new URLSearchParams("start=blank");
    const { getByText, getByTestId, findByText } = renderShell();

    // The grid is the editing surface AND the canvas is on screen with it —
    // no hidden toggle: the canvas is discoverable from the first render.
    await findByText("Add market to watch");
    expect(getByTestId("canvas-stub")).toBeInTheDocument();
    expect(getByText("Canvas")).toBeInTheDocument();

    getByText("Expand").click();
    await waitFor(() =>
      expect(window.localStorage.getItem("arima.builder.canvas-height.v1")).toBe("tall"),
    );

    getByText("Collapse").click();
    await waitFor(() =>
      expect(window.localStorage.getItem("arima.builder.canvas-height.v1")).toBe("peek"),
    );
  });
});
