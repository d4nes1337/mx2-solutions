import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@mx2/config";
import type { AuditStore } from "@mx2/db";
import type { GammaClient } from "@mx2/polymarket-client";
import type { StrategyDefinition } from "@mx2/rules";
import { makeRateLimit } from "../middleware/rate-limit.js";
import { generateStrategy } from "../ai/generate.js";
import type { AiClient } from "../ai/client.js";
import { StrategyDefinitionSchema } from "./smart-orders.js";

export interface AiRoutesDeps {
  config: AppConfig;
  auditStore: AuditStore;
  gammaClient: GammaClient;
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
});

export const registerAiRoutes = (app: FastifyInstance, deps: AiRoutesDeps): void => {
  const requireEnabled = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.config.features.aiChat || !deps.aiClient) {
      await reply.code(503).send({
        error: "AI_DISABLED",
        message: "AI strategy generation is disabled on this server.",
      });
    }
  };

  // ── POST /api/ai/generate-strategy — PUBLIC (landing-page wow path) ────────
  // Double-limited per IP: a burst brake and a daily budget. The LLM call is
  // the expensive resource, so limits sit BEFORE any model work.
  app.post(
    "/api/ai/generate-strategy",
    {
      preHandler: [
        requireEnabled,
        makeRateLimit({ scope: "ai-burst", limit: 5, windowMs: 60_000 }),
        makeRateLimit({ scope: "ai-daily", limit: 15, windowMs: 86_400_000 }),
      ],
    },
    async (req, reply) => {
      const parsed = GenerateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: "INVALID_REQUEST",
          message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        };
      }

      // Rebuild through explicit fields (not a spread) so zod's `?: T | undefined`
      // optionals don't collide with exactOptionalPropertyTypes on the DSL types.
      const cd = parsed.data.currentDefinition;
      const currentDefinition: StrategyDefinition | null = cd
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
                    ...(cd.action.negRisk !== undefined ? { negRisk: cd.action.negRisk } : {}),
                    ...(cd.action.tickSize !== undefined ? { tickSize: cd.action.tickSize } : {}),
                  }
                : cd.action,
            recurrence: cd.recurrence,
            limits: cd.limits,
            expiresAtMs: cd.expiresAtMs,
          }
        : null;

      const result = await generateStrategy(
        {
          aiClient: deps.aiClient!,
          gammaClient: deps.gammaClient,
          logger: req.log,
          model: deps.config.ai.model,
        },
        {
          prompt: parsed.data.prompt,
          history: parsed.data.history,
          currentDefinition,
        },
      );

      if (result.status === "ok") {
        // Metadata only — never the prompt text (PII-lean audit trail).
        await deps.auditStore.emit({
          actor: `anon:${req.ip}`,
          action: "ai.strategy_generated",
          subject: null,
          metadata: {
            model: deps.config.ai.model,
            modelCalls: result.modelCalls,
            marketCount: Object.keys(result.markets).length,
            actionKind: result.definition.action.kind,
            iterated: currentDefinition !== null,
          },
        });
        const { modelCalls: _ignored, ...body } = result;
        return body;
      }

      if (result.status === "clarify") return result;

      reply.code(result.code === "AI_UPSTREAM" ? 502 : 422);
      return { error: result.code, message: result.message };
    },
  );
};
