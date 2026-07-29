import { z } from "zod";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@mx2/config";
import type { AuditStore } from "@mx2/db";
import type { ClobClient, GammaClient } from "@mx2/polymarket-client";
import type { StrategyDefinition } from "@mx2/rules";
import { makeRateLimit } from "../middleware/rate-limit.js";
import {
  GenerateAborted,
  generateStrategy,
  type GenerateResult,
  type GenerateStage,
} from "../ai/generate.js";
import type { AiClient } from "../ai/client.js";
import { StrategyDefinitionSchema } from "./strategies.js";

export interface AiRoutesDeps {
  config: AppConfig;
  auditStore: AuditStore;
  gammaClient: GammaClient;
  clobClient: ClobClient;
  /** Null when FEATURE_AI_CHAT is off — the route then 503s (fail-closed). */
  aiClient: AiClient | null;
}

const GenerateBodySchema = z.object({
  prompt: z.string().trim().min(3).max(500),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(600),
      }),
    )
    .max(6)
    .default([]),
  currentDefinition: StrategyDefinitionSchema.nullish(),
  // @-pinned markets from the panel — resolved + verified server-side.
  pinnedConditionIds: z.array(z.string().min(10).max(100)).max(4).optional(),
});

type GenerateBody = z.infer<typeof GenerateBodySchema>;

/**
 * Rebuild through explicit fields (not a spread) so zod's `?: T | undefined`
 * optionals don't collide with exactOptionalPropertyTypes on the DSL types.
 */
const toStrategyDefinition = (cd: GenerateBody["currentDefinition"]): StrategyDefinition | null =>
  cd
    ? {
        version: 2,
        name: cd.name,
        templateId: cd.templateId,
        expr: cd.expr,
        holdsForMs: cd.holdsForMs,
        maxDataAgeMs: cd.maxDataAgeMs,
        action:
          cd.action.kind === "order"
            ? {
                kind: "order",
                market: cd.action.market,
                side: cd.action.side,
                price: cd.action.price,
                size: cd.action.size,
                orderType: cd.action.orderType,
                execution: cd.action.execution,
                ...(cd.action.postOnly !== undefined ? { postOnly: cd.action.postOnly } : {}),
                ...(cd.action.expiresAfterMs !== undefined
                  ? { expiresAfterMs: cd.action.expiresAfterMs }
                  : {}),
                ...(cd.action.negRisk !== undefined ? { negRisk: cd.action.negRisk } : {}),
                ...(cd.action.tickSize !== undefined ? { tickSize: cd.action.tickSize } : {}),
              }
            : cd.action.kind === "quote_loop"
              ? {
                  kind: "quote_loop",
                  market: {
                    conditionId: cd.action.market.conditionId,
                    yesTokenId: cd.action.market.yesTokenId,
                    noTokenId: cd.action.market.noTokenId,
                    ...(cd.action.market.title !== undefined
                      ? { title: cd.action.market.title }
                      : {}),
                    ...(cd.action.market.negRisk !== undefined
                      ? { negRisk: cd.action.market.negRisk }
                      : {}),
                    ...(cd.action.market.tickSize !== undefined
                      ? { tickSize: cd.action.market.tickSize }
                      : {}),
                  },
                  sizeShares: cd.action.sizeShares,
                  targetSpreadCents: cd.action.targetSpreadCents,
                  requoteToleranceCents: cd.action.requoteToleranceCents,
                  maxInventoryShares: cd.action.maxInventoryShares,
                  maxCapitalUsd: cd.action.maxCapitalUsd,
                  maxDailyLossUsd: cd.action.maxDailyLossUsd,
                }
              : cd.action,
        recurrence: cd.recurrence,
        limits: cd.limits,
        expiresAtMs: cd.expiresAtMs,
      }
    : null;

/** Counters ride the result for the audit trail but never the wire. */
const toWireBody = (result: Extract<GenerateResult, { status: "ok" }>): unknown => {
  const { modelCalls: _mc, statsCalls: _sc, webSearches: _ws, ...body } = result;
  return body;
};

export const registerAiRoutes = (app: FastifyInstance, deps: AiRoutesDeps): void => {
  const requireEnabled = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.config.features.aiChat || !deps.aiClient) {
      await reply.code(503).send({
        error: "AI_DISABLED",
        message: "AI strategy generation is disabled on this server.",
      });
    }
  };

  // ONE guard array for both transports: the limiter state is keyed by scope,
  // so JSON and SSE share a single burst + daily budget per IP.
  const guards = [
    requireEnabled,
    makeRateLimit({ scope: "ai-burst", limit: 5, windowMs: 60_000 }),
    makeRateLimit({ scope: "ai-daily", limit: 15, windowMs: 86_400_000 }),
  ];

  /** Shared core: generate + audit. Response writing is per-transport. */
  const runGeneration = async (opts: {
    body: GenerateBody;
    log: FastifyBaseLogger;
    ip: string;
    onStage?: (stage: GenerateStage, detail?: string) => void;
    signal?: AbortSignal;
  }): Promise<GenerateResult> => {
    const currentDefinition = toStrategyDefinition(opts.body.currentDefinition);
    const result = await generateStrategy(
      {
        aiClient: deps.aiClient!,
        gammaClient: deps.gammaClient,
        clobClient: deps.clobClient,
        logger: opts.log,
        model: deps.config.ai.model,
        webSearch: deps.config.features.aiWebSearch,
        ...(deps.config.ai.baseUrl ? { baseUrl: deps.config.ai.baseUrl } : {}),
        ...(opts.onStage ? { onStage: opts.onStage } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      {
        prompt: opts.body.prompt,
        history: opts.body.history,
        currentDefinition,
        ...(opts.body.pinnedConditionIds
          ? { pinnedConditionIds: opts.body.pinnedConditionIds }
          : {}),
      },
    );

    if (result.status === "ok") {
      // Metadata only — never the prompt text (PII-lean audit trail).
      await deps.auditStore.emit({
        actor: `anon:${opts.ip}`,
        action: "ai.strategy_generated",
        subject: null,
        metadata: {
          model: deps.config.ai.model,
          modelCalls: result.modelCalls,
          statsCalls: result.statsCalls ?? 0,
          webSearches: result.webSearches ?? 0,
          marketCount: Object.keys(result.markets).length,
          actionKind: result.definition.action.kind,
          iterated: currentDefinition !== null,
          fallback: result.fallback === true,
        },
      });
    }
    return result;
  };

  // ── POST /api/ai/generate-strategy — PUBLIC (landing-page wow path) ────────
  // Double-limited per IP: a burst brake and a daily budget. The LLM call is
  // the expensive resource, so limits sit BEFORE any model work.
  app.post("/api/ai/generate-strategy", { preHandler: guards }, async (req, reply) => {
    const parsed = GenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }

    const result = await runGeneration({ body: parsed.data, log: req.log, ip: req.ip });
    if (result.status === "ok") return toWireBody(result);
    if (result.status === "clarify") return result;
    reply.code(result.code === "AI_UPSTREAM" ? 502 : 422);
    return { error: result.code, message: result.message };
  });

  // ── POST /api/ai/generate-strategy/stream — same contract over SSE ─────────
  // Emits `stage` events while the generator works, then exactly one terminal
  // `result` (the JSON route's body, ok OR clarify) or `error` event. Clients
  // that get anything but text/event-stream back (buffering proxy) fall back
  // to the JSON route — both share the same rate-limit budget above.
  app.post("/api/ai/generate-strategy/stream", { preHandler: guards }, async (req, reply) => {
    const parsed = GenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tell nginx-style proxies not to buffer the stream.
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown): void => {
      if (!raw.writableEnded) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ping = setInterval(() => {
      if (!raw.writableEnded) raw.write(":ka\n\n");
    }, 15_000);
    const aborter = new AbortController();
    req.raw.on("close", () => aborter.abort());

    try {
      const result = await runGeneration({
        body: parsed.data,
        log: req.log,
        ip: req.ip,
        onStage: (stage) => send("stage", { stage }),
        signal: aborter.signal,
      });
      if (result.status === "ok") send("result", toWireBody(result));
      else if (result.status === "clarify") send("result", result);
      else {
        send("error", {
          error: result.code,
          message: result.message,
          status: result.code === "AI_UPSTREAM" ? 502 : 422,
        });
      }
    } catch (err) {
      if (err instanceof GenerateAborted) {
        // Client went away — nothing to write, nothing to audit.
      } else {
        req.log.warn({ err }, "ai.stream unexpected failure");
        send("error", {
          error: "AI_UPSTREAM",
          message: "The AI service failed mid-generation — try again.",
          status: 502,
        });
      }
    } finally {
      clearInterval(ping);
      raw.end();
    }
  });
};
