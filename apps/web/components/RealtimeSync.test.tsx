import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RealtimeSync } from "./RealtimeSync";

/** Minimal EventSource fake capturing listeners for manual dispatch. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

// Signed-in session so the hook connects.
vi.mock("@/lib/auth", () => ({
  useSession: () => ({ data: { walletAddress: "0xabc" } }),
}));

describe("RealtimeSync", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderWithClient = (qc: QueryClient, children: ReactNode) =>
    render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>);

  it("opens the stream and invalidates action-center/strategy queries on events", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderWithClient(qc, <RealtimeSync />);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/realtime/stream");

    source.emit("mx2", { kind: "rule.triggered", triggerId: "t-9" });
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["action-center"]));
    expect(keys).toContain(JSON.stringify(["triggers"]));
    expect(keys).toContain(JSON.stringify(["strategies"]));
    expect(keys).toContain(JSON.stringify(["trigger", "t-9"]));
  });

  it("closes the stream on unmount", async () => {
    const qc = new QueryClient();
    const view = renderWithClient(qc, <RealtimeSync />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    view.unmount();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });
});
