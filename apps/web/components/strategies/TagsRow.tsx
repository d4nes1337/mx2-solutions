"use client";

/** Inline tag chips + editor: click + to add (Enter commits), × removes. */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useSetStrategyTags, type StrategyRow } from "@/lib/strategies/queries";

export function TagsRow({ row }: { row: StrategyRow }) {
  const setTags = useSetStrategyTags();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const tags = row.tags ?? [];

  const commit = () => {
    const tag = draft.trim().toLowerCase();
    setDraft("");
    setEditing(false);
    if (tag === "" || tags.includes(tag) || tags.length >= 10) return;
    setTags.mutate({ id: row.id, tags: [...tags, tag] });
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand-soft px-2 py-0.5 text-[10px] font-medium text-accent"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => setTags.mutate({ id: row.id, tags: tags.filter((t) => t !== tag) })}
            className="text-accent/60 transition-colors hover:text-accent"
          >
            <X size={9} aria-hidden />
          </button>
        </span>
      ))}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft("");
              setEditing(false);
            }
          }}
          maxLength={24}
          placeholder="tag name…"
          aria-label="New tag"
          className="w-24 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] text-fg outline-none focus:border-brand"
        />
      ) : tags.length < 10 ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Add tag"
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] font-medium text-faint transition-colors hover:border-border-strong hover:text-muted"
        >
          <Plus size={9} aria-hidden /> tag
        </button>
      ) : null}
    </div>
  );
}
