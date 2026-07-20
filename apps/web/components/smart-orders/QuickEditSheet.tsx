"use client";

/**
 * Quick edit — change an armed strategy's parameters right from the list or
 * detail page, no canvas trip needed (owner request). Mounts the SAME
 * store-bound editors the builder uses against the strategy's stable
 * `edit-<id>` draft slot, and applies as a versioned edit: the server
 * atomically creates the replacement, cancels the old rule, links both and
 * carries spend caps forward (D-020 — definitions stay immutable).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button, ErrorNote } from "@/components/ui";
import { SheetShell } from "@/components/motion/primitives";
import { useBuilderStore } from "@/lib/smart-orders/store";
import { conditionLeavesOf, docFromDefinition } from "@/lib/smart-orders/doc";
import { layoutDoc } from "@/lib/smart-orders/layout";
import { compileDoc, validateDoc } from "@/lib/smart-orders/compile";
import { strategySentence } from "@/lib/smart-orders/sentence";
import { markDraftConsumedLocal } from "@/lib/smart-orders/drafts";
import { markDraftConsumedOnServer } from "@/lib/smart-orders/drafts-sync";
import { useCreateStrategy, type StrategyRow } from "@/lib/smart-orders/queries";
import { ApiError } from "@/lib/api";
import { StrategySettings } from "@/components/builder/StrategySettings";
import { ConditionEditor } from "@/components/builder/editors/ConditionEditor";
import { OrderActionEditor } from "@/components/builder/editors/OrderActionEditor";

export function QuickEditSheet({
  row,
  open,
  onClose,
  onApplied,
}: {
  row: StrategyRow;
  open: boolean;
  onClose: () => void;
  /** Called with the REPLACEMENT strategy's id after a successful apply. */
  onApplied?: (newId: string) => void;
}) {
  const create = useCreateStrategy();
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the per-strategy draft slot exactly as the builder does — an
  // in-progress edit (canvas or sheet) resumes; otherwise seed from the
  // immutable definition. spawnDraft flushes any dirty canvas draft first.
  useEffect(() => {
    if (!open) {
      setHydrated(false);
      return;
    }
    const st = useBuilderStore.getState();
    if (st.draftId === `edit-${row.id}` || st.loadDraft(`edit-${row.id}`)) {
      setHydrated(true);
      return;
    }
    st.spawnDraft(layoutDoc(docFromDefinition(row.definitionV2)), {
      id: `edit-${row.id}`,
      origin: `edit:${row.id}`,
    });
    setHydrated(true);
  }, [open, row.id, row.definitionV2]);

  const doc = useBuilderStore((s) => s.doc);
  const draftId = useBuilderStore((s) => s.draftId);
  const ready = hydrated && draftId === `edit-${row.id}`;
  const issues = ready ? validateDoc(doc) : [];
  const leaves = ready ? conditionLeavesOf(doc.expr) : [];

  const apply = () => {
    create.mutate(
      { ...compileDoc(doc), supersedes: row.id },
      {
        onSuccess: (created) => {
          const consumedId = useBuilderStore.getState().draftId;
          useBuilderStore.getState().spawnDraft();
          if (consumedId) {
            markDraftConsumedLocal(consumedId, created.id);
            void markDraftConsumedOnServer(consumedId, created.id);
          }
          onClose();
          onApplied?.(created.id);
        },
      },
    );
  };

  const applyError =
    create.error instanceof ApiError || create.error instanceof Error ? create.error.message : null;

  return (
    <SheetShell
      open={open}
      onClose={onClose}
      label="Quick edit"
      panelClassName="w-full max-w-lg rounded-t-xl border border-border bg-bg p-5 shadow-xl sm:rounded-xl"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded p-1 text-muted hover:text-fg"
        aria-label="Close"
      >
        <X size={16} />
      </button>

      <h2 className="mb-1 text-[15px] font-semibold text-fg">
        Edit — {row.name || doc.name || "Smart Order"}
      </h2>
      {ready ? (
        <>
          <p className="mb-3 text-xs leading-relaxed text-muted">{strategySentence(doc)}</p>

          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {leaves.map(({ id }) => (
              <div key={id} className="rounded-lg border border-border bg-surface p-3">
                <ConditionEditor id={id} />
              </div>
            ))}
            {doc.action.kind === "order" ? (
              <div className="rounded-lg border border-border bg-surface p-3">
                <OrderActionEditor action={doc.action} />
              </div>
            ) : null}
            <div className="rounded-lg border border-border bg-surface p-3">
              <StrategySettings />
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {issues.length > 0 ? (
              <ErrorNote message={issues[0]!.message} />
            ) : (
              <p className="text-[11px] leading-snug text-muted">
                Applies as a new version — the hold window and trigger count restart; spend caps
                carry over.
              </p>
            )}
            {applyError ? <ErrorNote message={applyError} /> : null}
            <div className="flex items-center gap-2">
              <Button
                className="flex-1"
                disabled={issues.length > 0 || create.isPending}
                onClick={apply}
              >
                {create.isPending ? "Applying…" : "Apply changes"}
              </Button>
              <Link
                href={`/smart-orders/${row.id}/edit`}
                className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs font-medium text-fg transition-colors hover:border-border-strong"
                onClick={onClose}
              >
                Open in builder
              </Link>
            </div>
          </div>
        </>
      ) : (
        <p className="py-8 text-center text-sm text-muted">Loading…</p>
      )}
    </SheetShell>
  );
}
