"use client";

/**
 * Confirm-mode inbox: shows the worker's CURRENT pending batch and lets the
 * owner approve it by hash. Stale approvals are structurally impossible — the
 * server's WHERE guard 409s (BATCH_STALE) when the proposal changed, and the
 * worker re-verifies the hash against the live book before executing.
 */
import { ShieldCheck } from "lucide-react";
import { Button, ErrorNote } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { useApproveBatch, type QuoteSession } from "@/lib/farming/queries";

const cents = (p: number) => `${Math.round(p * 100)}¢`;

export function ConfirmInbox({ session }: { session: QuoteSession }) {
  const approve = useApproveBatch(session.ruleId);
  if (session.mode !== "confirm") return null;

  const batch = session.pendingBatch;
  const stale =
    approve.error instanceof ApiError && approve.error.message.toLowerCase().includes("moved");

  if (!batch || !session.pendingBatchHash) {
    return (
      <div className="rounded-xl border border-border bg-surface-2/60 px-4 py-3 text-[12px] text-muted">
        <ShieldCheck size={13} className="mr-1.5 inline text-pos" aria-hidden />
        Confirm mode — nothing awaiting approval. The worker proposes a batch whenever it wants to
        place quotes or merge pairs.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-brand/40 bg-brand-soft/30 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-fg">Awaiting your approval</span>
        <span className="tabular text-[10px] text-faint">
          batch {session.pendingBatchHash.slice(0, 10)}…
        </span>
      </div>
      <ul className="mb-3 space-y-1 text-[12px] text-fg">
        {batch.places.map((p, i) => (
          <li key={i} className="tabular">
            Place BUY {p.size} @ {cents(p.price)}{" "}
            <span className="text-muted">({p.tokenId.slice(0, 10)}…)</span>
          </li>
        ))}
        {batch.mergePairs > 0 ? (
          <li className="tabular">
            Merge {batch.mergePairs} YES+NO pairs → ${batch.mergePairs.toFixed(0)} collateral
          </li>
        ) : null}
      </ul>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={approve.isPending}
          onClick={() => approve.mutate(session.pendingBatchHash!)}
        >
          {approve.isPending ? "Approving…" : "Approve batch"}
        </Button>
        <span className="text-[11px] text-muted">
          Executes only while prices still match this exact batch.
        </span>
      </div>
      {approve.isError ? (
        <div className="mt-2">
          <ErrorNote
            message={
              stale
                ? "Prices moved — the batch above has been refreshed; review and approve again."
                : approve.error instanceof Error
                  ? approve.error.message
                  : "Approval failed"
            }
          />
        </div>
      ) : null}
    </div>
  );
}
