/**
 * Draft persistence invariants: spawn forks dirty work (the draft-loss fix),
 * pristine spawns replace in place, per-draft AI chat isolation, clear-canvas
 * semantics, and the localStorage layer's caps/tombstones.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { emptyDoc } from "./doc";
import {
  DRAFT_SCHEMA_VERSION,
  deleteDraftLocal,
  duplicateDraftLocal,
  listDraftsLocal,
  loadDraftLocal,
  markDraftConsumedLocal,
  newDraftId,
  renameDraftLocal,
  saveDraftLocal,
  type DraftRecord,
} from "./drafts";
import { draftRecordFromState, useBuilderStore } from "./store";

const priceCondition = {
  kind: "price",
  market: { conditionId: "cond-1", tokenId: "tok-1", outcome: "YES" },
  source: "ask",
  comparator: "lte",
  threshold: 0.5,
} as const;

const record = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  id: newDraftId(),
  schemaVersion: DRAFT_SCHEMA_VERSION,
  name: "r",
  origin: "blank",
  updatedAt: Date.now(),
  doc: emptyDoc(),
  aiMessages: [],
  aiHistory: [],
  ...over,
});

beforeEach(() => {
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
});

describe("spawnDraft / loadDraft", () => {
  it("forks dirty work: the outgoing draft is flushed intact (draft-loss fix)", () => {
    const a = useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("My custom play");
    useBuilderStore.getState().addCondition(priceCondition);

    const b = useBuilderStore.getState().spawnDraft({ ...emptyDoc(), name: "Preset" });
    expect(b).not.toBe(a);
    const rec = loadDraftLocal(a);
    expect(rec?.doc.name).toBe("My custom play");
    expect(rec?.doc.expr.children).toHaveLength(1);
    expect(useBuilderStore.getState().doc.name).toBe("Preset");
  });

  it("replaces a pristine spawn in place — cycling presets doesn't spray drafts", () => {
    const a = useBuilderStore.getState().spawnDraft({ ...emptyDoc(), name: "Preset A" });
    const b = useBuilderStore.getState().spawnDraft({ ...emptyDoc(), name: "Preset B" });
    expect(b).toBe(a);
    expect(listDraftsLocal()).toHaveLength(0); // untouched spawns never persist
  });

  it("isolates the AI chat per draft and restores it on load", () => {
    const a = useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("Draft A");
    useBuilderStore.getState().pushAiMessage({ role: "user", content: "hello from A" });
    useBuilderStore.getState().pushAiHistory([{ role: "user", content: "hello from A" }]);

    useBuilderStore.getState().spawnDraft();
    expect(useBuilderStore.getState().aiMessages).toHaveLength(0);
    expect(useBuilderStore.getState().aiHistory).toHaveLength(0);

    expect(useBuilderStore.getState().loadDraft(a)).toBe(true);
    expect(useBuilderStore.getState().doc.name).toBe("Draft A");
    expect(useBuilderStore.getState().aiMessages[0]?.content).toBe("hello from A");
    expect(useBuilderStore.getState().aiHistory).toHaveLength(1);
  });

  it("loadDraft returns false for unknown ids and keeps the current canvas", () => {
    useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("Keep me");
    expect(useBuilderStore.getState().loadDraft("nope")).toBe(false);
    expect(useBuilderStore.getState().doc.name).toBe("Keep me");
  });

  it("caps the chat: 40 display messages, 6 history turns", () => {
    const s = useBuilderStore.getState();
    for (let i = 0; i < 45; i++) s.pushAiMessage({ role: "user", content: `m${i}` });
    for (let i = 0; i < 5; i++) {
      s.pushAiHistory([
        { role: "user", content: `u${i}` },
        { role: "assistant", content: `a${i}` },
      ]);
    }
    expect(useBuilderStore.getState().aiMessages).toHaveLength(40);
    expect(useBuilderStore.getState().aiHistory).toHaveLength(6);
    expect(useBuilderStore.getState().aiMessages[0]?.content).toBe("m5"); // oldest evicted
  });
});

describe("clearCanvas", () => {
  it("wipes doc + chat, deletes the record, keeps the draft id", () => {
    const a = useBuilderStore.getState().spawnDraft();
    useBuilderStore.getState().setName("Doomed");
    useBuilderStore.getState().pushAiMessage({ role: "user", content: "bye" });
    saveDraftLocal(draftRecordFromState(useBuilderStore.getState()));
    expect(loadDraftLocal(a)).not.toBeNull();

    useBuilderStore.getState().clearCanvas();
    expect(useBuilderStore.getState().draftId).toBe(a); // ?draft= URLs stay stable
    expect(useBuilderStore.getState().doc.name).toBe("");
    expect(useBuilderStore.getState().doc.expr.children).toHaveLength(0);
    expect(useBuilderStore.getState().aiMessages).toHaveLength(0);
    expect(loadDraftLocal(a)).toBeNull();
  });
});

describe("drafts localStorage layer", () => {
  it("round-trips records and lists newest first", () => {
    saveDraftLocal(record({ id: "d1", name: "one", updatedAt: 1_000 }));
    saveDraftLocal(record({ id: "d2", name: "two", updatedAt: 2_000 }));
    expect(listDraftsLocal().map((d) => d.id)).toEqual(["d2", "d1"]);
    expect(loadDraftLocal("d1")?.name).toBe("one");
  });

  it("evicts past the 30-draft LRU cap (oldest go first)", () => {
    for (let i = 0; i < 32; i++) {
      saveDraftLocal(record({ id: `d${i}`, updatedAt: i }));
    }
    const ids = listDraftsLocal().map((d) => d.id);
    expect(ids).toHaveLength(30);
    expect(ids).not.toContain("d0");
    expect(ids).not.toContain("d1");
    expect(loadDraftLocal("d0")).toBeNull(); // record gone, not just unlisted
    expect(loadDraftLocal("d31")).not.toBeNull();
  });

  it("refuses newer-major records (forward-compat guard)", () => {
    saveDraftLocal(record({ id: "vNext", schemaVersion: DRAFT_SCHEMA_VERSION + 1 }));
    expect(loadDraftLocal("vNext")).toBeNull();
  });

  it("consumed drafts become tombstones: unlisted but still loadable", () => {
    saveDraftLocal(record({ id: "armed", name: "went live" }));
    markDraftConsumedLocal("armed", "rule-123");
    expect(listDraftsLocal().find((d) => d.id === "armed")).toBeUndefined();
    expect(loadDraftLocal("armed")?.armedRuleId).toBe("rule-123");
  });

  it("rename and duplicate keep doc.name in sync", () => {
    saveDraftLocal(record({ id: "orig", name: "before" }));
    renameDraftLocal("orig", "after");
    expect(loadDraftLocal("orig")?.doc.name).toBe("after");

    const copyId = duplicateDraftLocal("orig");
    expect(copyId).not.toBeNull();
    const copy = loadDraftLocal(copyId!);
    expect(copy?.name).toBe("after (copy)");
    expect(copy?.origin).toBe("clone");

    deleteDraftLocal("orig");
    expect(loadDraftLocal("orig")).toBeNull();
    expect(loadDraftLocal(copyId!)).not.toBeNull();
  });
});
