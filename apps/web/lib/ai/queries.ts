"use client";

/**
 * AI strategy generation data layer. Stateless server: the panel holds the
 * compact conversation and re-sends it (plus the current compiled definition)
 * on every turn.
 *
 * Transport: the SSE endpoint first (real progress stages), falling back to
 * the plain JSON endpoint whenever the stream isn't available — network
 * hiccup, buffering proxy, anything that isn't `text/event-stream`. Both
 * routes share one server-side rate-limit budget.
 */
import { useMutation } from "@tanstack/react-query";
import type { StrategyDefinition } from "@mx2/rules";
import { api, ApiError } from "../api";
import type { StrategyDefinitionInput } from "../strategies/doc";

export interface AiHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface AiGeneratedMarketMeta {
  title: string;
  eventTitle?: string;
  image?: string;
  outcome: string;
  rewardsMinSize: number | null;
  rewardsMaxSpread: number | null;
}

export interface AiSource {
  url: string;
  title: string;
}

/** Real progress phases emitted by the SSE endpoint. */
export type AiStage = "searching" | "drafting" | "analyzing" | "researching" | "repairing";

export type AiGenerateResponse =
  | {
      status: "ok";
      definition: StrategyDefinition;
      summary: string;
      warnings: string[];
      markets: Record<string, AiGeneratedMarketMeta>;
      /** Assumptions/follow-ups the model recorded while drafting (≤3). */
      openQuestions?: string[];
      /** True when the server substituted the guaranteed minimal draft. */
      fallback?: boolean;
      /** Web pages the model consulted (hosted web search citations). */
      sources?: AiSource[];
    }
  | { status: "clarify"; question: string; sources?: AiSource[] };

export interface AiGenerateRequest {
  prompt: string;
  history?: AiHistoryEntry[];
  currentDefinition?: StrategyDefinitionInput | null;
  /** Markets the user @-pinned — resolved and pre-verified server-side. */
  pinnedConditionIds?: string[];
}

/** Parse one SSE frame ("event: x\ndata: {...}") into its parts. */
const parseFrame = (frame: string): { event: string; data: unknown } | null => {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
};

async function generateStrategyStream(
  req: AiGenerateRequest,
  onStage?: (stage: AiStage) => void,
): Promise<AiGenerateResponse> {
  let res: Response;
  try {
    res = await fetch("/api/ai/generate-strategy/stream", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(req),
    });
  } catch {
    return api.post<AiGenerateResponse>("/api/ai/generate-strategy", req);
  }

  if (!res.ok) {
    // Mirror api.post error semantics so the panel's error copy keeps working.
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    const body = (json ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      res.status,
      body.error ?? `HTTP_${res.status}`,
      body.message ?? res.statusText,
      json,
    );
  }

  if (!res.headers.get("content-type")?.includes("text/event-stream") || !res.body) {
    // A proxy rewrote the stream — degrade to the JSON transport.
    return api.post<AiGenerateResponse>("/api/ai/generate-strategy", req);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: AiGenerateResponse | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawFrame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (rawFrame.trim().length === 0 || rawFrame.startsWith(":")) continue; // keep-alive
      const frame = parseFrame(rawFrame);
      if (!frame) continue;
      if (frame.event === "stage") {
        const s = (frame.data as { stage?: string }).stage;
        if (s) onStage?.(s as AiStage);
      } else if (frame.event === "result") {
        finalResult = frame.data as AiGenerateResponse;
      } else if (frame.event === "error") {
        const e = frame.data as { error?: string; message?: string; status?: number };
        throw new ApiError(
          e.status ?? 502,
          e.error ?? "AI_UPSTREAM",
          e.message ?? "AI generation failed",
          frame.data,
        );
      }
    }
  }

  if (finalResult) return finalResult;
  // Stream ended without a terminal event (connection cut) — one JSON retry.
  return api.post<AiGenerateResponse>("/api/ai/generate-strategy", req);
}

export function useGenerateStrategy(onStage?: (stage: AiStage) => void) {
  return useMutation({
    mutationFn: (req: AiGenerateRequest) => generateStrategyStream(req, onStage),
  });
}
