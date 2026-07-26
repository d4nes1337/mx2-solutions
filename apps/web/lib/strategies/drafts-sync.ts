"use client";

/**
 * Account sync for builder drafts (hybrid persistence): localStorage stays the
 * source of truth for the open canvas; signed-in users additionally push
 * drafts to the server and import them on other devices. Merge is
 * last-write-wins on the client updatedAt clock (single-user tradeoff,
 * ADR-0019). Every call is fail-soft: signed-out (401) or offline just means
 * local-only, never a broken builder.
 */
import { api } from "../api";
import {
  DRAFT_SCHEMA_VERSION,
  listDraftsLocal,
  loadDraftLocal,
  saveDraftLocal,
  type DraftRecord,
} from "./drafts";

interface ServerDraft {
  clientDraftId: string;
  name: string;
  origin: string;
  doc: DraftRecord["doc"];
  aiMessages: DraftRecord["aiMessages"];
  aiHistory: DraftRecord["aiHistory"];
  tags: string[];
  schemaVersion: number;
  status: "active" | "archived" | "consumed";
  armedRuleId: string | null;
  updatedAt: number;
}

export const pushDraftToServer = async (record: DraftRecord): Promise<void> => {
  try {
    await api.put(`/api/drafts/${encodeURIComponent(record.id)}`, {
      name: record.name,
      origin: record.origin,
      doc: record.doc,
      aiMessages: record.aiMessages,
      aiHistory: record.aiHistory,
      tags: [],
      schemaVersion: record.schemaVersion,
      updatedAt: record.updatedAt,
      ...(record.armedRuleId ? { status: "consumed", armedRuleId: record.armedRuleId } : {}),
    });
  } catch {
    // Signed out / offline / server draft newer — local copy is still safe.
  }
};

/**
 * Pull the account's drafts and merge into localStorage (newer side wins).
 * Returns how many local records changed, so list UIs know to refresh.
 */
export const importServerDrafts = async (): Promise<number> => {
  try {
    const { drafts } = await api.get<{ drafts: ServerDraft[] }>("/api/drafts");
    let changed = 0;
    for (const remote of drafts) {
      if (remote.status !== "active") continue;
      if (remote.schemaVersion > DRAFT_SCHEMA_VERSION) continue; // future format
      const local = loadDraftLocal(remote.clientDraftId);
      if (local && local.updatedAt >= remote.updatedAt) continue;
      saveDraftLocal({
        id: remote.clientDraftId,
        schemaVersion: remote.schemaVersion,
        name: remote.name,
        origin: remote.origin,
        updatedAt: remote.updatedAt,
        doc: remote.doc,
        aiMessages: remote.aiMessages ?? [],
        aiHistory: remote.aiHistory ?? [],
      });
      changed += 1;
    }
    return changed;
  } catch {
    return 0; // signed out / offline — local drafts only
  }
};

/** Push any local drafts the server doesn't have yet (first sign-in upload). */
export const pushLocalDraftsToServer = async (): Promise<void> => {
  for (const meta of listDraftsLocal().slice(0, 20)) {
    const record = loadDraftLocal(meta.id);
    if (record) await pushDraftToServer(record);
  }
};

export const markDraftConsumedOnServer = async (
  clientDraftId: string,
  armedRuleId: string,
): Promise<void> => {
  const record = loadDraftLocal(clientDraftId);
  if (!record) return;
  await pushDraftToServer({ ...record, armedRuleId, updatedAt: Date.now() });
};
