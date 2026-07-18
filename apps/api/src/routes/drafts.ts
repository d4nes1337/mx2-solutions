import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "@mx2/config";
import type { DraftStore, SessionStore, StrategyDraftRow } from "@mx2/db";
import { makeRequireAuth } from "../middleware/require-auth.js";

/**
 * Server-synced builder drafts (ADR-0019). The doc is FREE-FORM StrategyDoc
 * JSON — validated only for shape/size, never compiled: drafts may reference
 * dead markets or be half-built, that's their job. The worker never sees this
 * table; arming goes through POST /api/smart-orders with full validation.
 */

export interface DraftsRoutesDeps {
  config: AppConfig;
  sessions: SessionStore;
  draftStore: DraftStore;
}

/** Serialized doc size cap — a canvas doc is a few KB; 64KB is generous. */
const MAX_DOC_BYTES = 64_000;
const MAX_CHAT_BYTES = 64_000;

const PutDraftSchema = z
  .object({
    name: z.string().max(200).default(""),
    origin: z.string().max(64).default("blank"),
    doc: z.record(z.unknown()),
    aiMessages: z.array(z.unknown()).max(60).default([]),
    aiHistory: z.array(z.unknown()).max(12).default([]),
    tags: z.array(z.string().min(1).max(24)).max(10).default([]),
    schemaVersion: z.number().int().min(1).max(100),
    /** Client updatedAt (ms) — the last-write-wins clock. */
    updatedAt: z.number().int().positive(),
    status: z.enum(["active", "archived", "consumed"]).optional(),
    armedRuleId: z.string().uuid().nullish(),
  })
  .strict();

const serializeDraft = (row: StrategyDraftRow) => ({
  clientDraftId: row.clientDraftId,
  name: row.name,
  origin: row.origin,
  doc: row.doc,
  aiMessages: row.aiMessages,
  aiHistory: row.aiHistory,
  tags: row.tags,
  schemaVersion: row.schemaVersion,
  status: row.status,
  armedRuleId: row.armedRuleId,
  updatedAt: row.updatedAtClient,
});

export const registerDraftsRoutes = (app: FastifyInstance, deps: DraftsRoutesDeps): void => {
  const requireAuth = makeRequireAuth({ sessions: deps.sessions });

  const requireEnabled = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.config.features.conditionalRules || !deps.config.features.smartOrdersV2) {
      await reply.code(503).send({
        error: "SMART_ORDERS_DISABLED",
        message: "Smart Orders are disabled on this server.",
      });
    }
  };
  const guard = { preHandler: [requireAuth, requireEnabled] };

  app.get("/api/drafts", guard, async (req) => {
    const user = req.user!;
    const rows = await deps.draftStore.listActive(user.walletAddress);
    return { drafts: rows.map(serializeDraft) };
  });

  app.put("/api/drafts/:clientDraftId", guard, async (req, reply) => {
    const user = req.user!;
    const { clientDraftId } = req.params as { clientDraftId: string };
    if (clientDraftId.length < 4 || clientDraftId.length > 80) {
      reply.code(400);
      return { error: "INVALID_REQUEST", message: "Invalid draft id." };
    }
    const parsed = PutDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: "INVALID_REQUEST",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    const b = parsed.data;
    if (JSON.stringify(b.doc).length > MAX_DOC_BYTES) {
      reply.code(413);
      return { error: "DRAFT_TOO_LARGE", message: "Draft document is too large to sync." };
    }
    if (JSON.stringify(b.aiMessages).length + JSON.stringify(b.aiHistory).length > MAX_CHAT_BYTES) {
      reply.code(413);
      return { error: "DRAFT_TOO_LARGE", message: "Draft chat is too large to sync." };
    }
    const row = await deps.draftStore.upsert({
      walletAddress: user.walletAddress,
      clientDraftId,
      name: b.name,
      origin: b.origin,
      doc: b.doc,
      aiMessages: b.aiMessages,
      aiHistory: b.aiHistory,
      tags: b.tags,
      schemaVersion: b.schemaVersion,
      updatedAtClient: b.updatedAt,
      ...(b.status ? { status: b.status } : {}),
      ...(b.armedRuleId !== undefined ? { armedRuleId: b.armedRuleId } : {}),
    });
    return serializeDraft(row);
  });

  app.post("/api/drafts/:clientDraftId/archive", guard, async (req, reply) => {
    const user = req.user!;
    const { clientDraftId } = req.params as { clientDraftId: string };
    const row = await deps.draftStore.archive(user.walletAddress, clientDraftId);
    if (!row) {
      reply.code(404);
      return { error: "NOT_FOUND", message: "Draft not found." };
    }
    return serializeDraft(row);
  });
};
