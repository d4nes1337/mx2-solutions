"use client";

/**
 * Local draft persistence for the strategy builder. Every canvas the user
 * touches lives in exactly one draft; presets, AI generations and deep links
 * spawn new drafts instead of overwriting in-progress work.
 *
 * Storage shape: an index key (`mx2.drafts.v1`) listing draft metadata plus
 * one record key per draft (`mx2.draft.<id>`). All access is fail-soft — a
 * throwing localStorage (private browsing, quota, SSR) degrades to in-memory
 * editing instead of breaking the builder.
 */
import type { StrategyDoc } from "./doc";

/** A chat turn as displayed in the AI panel (optimistic user turns included). */
export interface DraftChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Engine warnings attached to an assistant turn. */
  warnings?: string[];
  /** "I assumed / quick questions" chips — tap to prefill the composer. */
  openQuestions?: string[];
}

/** A compact API-contract turn (what the generate endpoint receives back). */
export interface DraftHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface DraftRecord {
  id: string;
  schemaVersion: number;
  /** Denormalized doc.name, for the index/list UI. */
  name: string;
  /** Entry that created it: "blank" | "template:<id>" | "ai" | "showcase:<id>" | "scenario:<id>" | "edit:<ruleId>" | "clone". */
  origin: string;
  updatedAt: number;
  doc: StrategyDoc;
  /** Per-draft AI conversation — display log + API history. */
  aiMessages: DraftChatMessage[];
  aiHistory: DraftHistoryEntry[];
  /** Set when Save & arm consumed this draft into a live strategy. */
  armedRuleId?: string;
}

export interface DraftMeta {
  id: string;
  name: string;
  origin: string;
  updatedAt: number;
  armedRuleId?: string;
}

const INDEX_KEY = "mx2.drafts.v1";
const RECORD_PREFIX = "mx2.draft.";
export const DRAFT_SCHEMA_VERSION = 1;
/** LRU cap — oldest drafts (by updatedAt) are evicted past this. */
const MAX_DRAFTS = 30;

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const readIndex = (): DraftMeta[] => {
  const ls = storage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is DraftMeta =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as DraftMeta).id === "string" &&
        typeof (e as DraftMeta).updatedAt === "number",
    );
  } catch {
    return [];
  }
};

const writeIndex = (index: DraftMeta[]): void => {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Quota/private mode — drafts stay in-memory for this session.
  }
};

export const newDraftId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
};

/** Persist a draft record and its index entry; evicts past the LRU cap. */
export const saveDraftLocal = (record: DraftRecord): void => {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(RECORD_PREFIX + record.id, JSON.stringify(record));
  } catch {
    return; // Record didn't fit — leave the index untouched.
  }
  const meta: DraftMeta = {
    id: record.id,
    name: record.name,
    origin: record.origin,
    updatedAt: record.updatedAt,
    ...(record.armedRuleId ? { armedRuleId: record.armedRuleId } : {}),
  };
  const index = [meta, ...readIndex().filter((e) => e.id !== record.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  for (const evicted of index.slice(MAX_DRAFTS)) {
    try {
      ls.removeItem(RECORD_PREFIX + evicted.id);
    } catch {
      // Best-effort cleanup.
    }
  }
  writeIndex(index.slice(0, MAX_DRAFTS));
};

export const loadDraftLocal = (id: string): DraftRecord | null => {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(RECORD_PREFIX + id);
    if (!raw) return null;
    const rec = JSON.parse(raw) as DraftRecord;
    // Newer-major records (future app versions) are unreadable here.
    if (typeof rec.schemaVersion !== "number" || rec.schemaVersion > DRAFT_SCHEMA_VERSION) {
      return null;
    }
    if (!rec.doc || typeof rec.doc !== "object") return null;
    return {
      ...rec,
      aiMessages: Array.isArray(rec.aiMessages) ? rec.aiMessages : [],
      aiHistory: Array.isArray(rec.aiHistory) ? rec.aiHistory : [],
    };
  } catch {
    return null;
  }
};

/** Active (not consumed) drafts, most recently updated first. */
export const listDraftsLocal = (): DraftMeta[] =>
  readIndex()
    .filter((e) => !e.armedRuleId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

export const deleteDraftLocal = (id: string): void => {
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(RECORD_PREFIX + id);
  } catch {
    // Best-effort.
  }
  writeIndex(readIndex().filter((e) => e.id !== id));
};

export const renameDraftLocal = (id: string, name: string): void => {
  const rec = loadDraftLocal(id);
  if (!rec) return;
  saveDraftLocal({ ...rec, name, doc: { ...rec.doc, name }, updatedAt: Date.now() });
};

/** Copy a draft under a fresh id (chat comes along). Returns the new id. */
export const duplicateDraftLocal = (id: string): string | null => {
  const rec = loadDraftLocal(id);
  if (!rec) return null;
  const copyId = newDraftId();
  const name = rec.name.trim() === "" ? "" : `${rec.name} (copy)`;
  saveDraftLocal({
    ...rec,
    id: copyId,
    name,
    doc: { ...rec.doc, name },
    origin: "clone",
    updatedAt: Date.now(),
  });
  return copyId;
};

/**
 * Save & arm consumed this draft: keep the record as a tombstone linked to the
 * created strategy, but drop it from the active drafts list.
 */
export const markDraftConsumedLocal = (id: string, armedRuleId: string): void => {
  const rec = loadDraftLocal(id);
  if (!rec) return;
  saveDraftLocal({ ...rec, armedRuleId, updatedAt: Date.now() });
};
