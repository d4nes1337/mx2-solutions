import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";

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

const mockFlags = (aiChat: boolean) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(flagsResponse(aiChat)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );

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
    mockFlags(false);
    renderHero();
    expect(await screen.findByText("Create Smart Order")).toBeInTheDocument();
    expect(screen.queryByText("Build it")).not.toBeInTheDocument();
  });

  it("shows the prompt card when the AI flag is on and deep-links the prompt", async () => {
    mockFlags(true);
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
    mockFlags(true);
    renderHero();
    fireEvent.click(await screen.findByText("Build it"));
    expect(push).not.toHaveBeenCalled();
  });
});
