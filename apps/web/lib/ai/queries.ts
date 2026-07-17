"use client";

/**
 * AI strategy generation data layer. Stateless server: the panel holds the
 * compact conversation and re-sends it (plus the current compiled definition)
 * on every turn.
 */
import { useMutation } from "@tanstack/react-query";
import type { StrategyDefinition } from "@mx2/rules";
import { api } from "../api";
import type { StrategyDefinitionInput } from "../smart-orders/doc";

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

export type AiGenerateResponse =
  | {
      status: "ok";
      definition: StrategyDefinition;
      summary: string;
      warnings: string[];
      markets: Record<string, AiGeneratedMarketMeta>;
      /** Assumptions/follow-ups the model recorded while drafting (≤3). */
      openQuestions?: string[];
    }
  | { status: "clarify"; question: string };

export interface AiGenerateRequest {
  prompt: string;
  history?: AiHistoryEntry[];
  currentDefinition?: StrategyDefinitionInput | null;
  /** Markets the user @-pinned — resolved and pre-verified server-side. */
  pinnedConditionIds?: string[];
}

export function useGenerateStrategy() {
  return useMutation({
    mutationFn: (req: AiGenerateRequest) =>
      api.post<AiGenerateResponse>("/api/ai/generate-strategy", req),
  });
}
