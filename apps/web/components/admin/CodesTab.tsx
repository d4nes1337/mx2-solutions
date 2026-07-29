"use client";

import { useState } from "react";
import { Loader2, Pause, Play, Plus } from "lucide-react";
import { useAdminCodes, useMintAdminCode, usePatchAdminCode } from "@/lib/queries";
import { ApiError } from "@/lib/api";
import type { AdminCodeItem } from "@/lib/types";
import { Button, Card, CardHeader, ErrorNote, Skeleton } from "@/components/ui";
import { SheetShell } from "@/components/motion/primitives";
import { CopyButton } from "@/components/profile/funds/shared";
import { AdminTable, StatusBadge, Td, Th, fmtDate, fmtUsd, shortWallet } from "./shared";

function MintCodeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mint = useMintAdminCode();
  const [code, setCode] = useState("");
  const [ownerWallet, setOwnerWallet] = useState("");
  const [maxUses, setMaxUses] = useState("5");
  const [note, setNote] = useState("");

  const error =
    mint.error instanceof ApiError || mint.error instanceof Error ? mint.error.message : null;

  const submit = () => {
    const uses = parseInt(maxUses, 10);
    if (!Number.isFinite(uses) || uses < 0) return;
    mint.mutate(
      {
        maxUses: uses,
        ...(code.trim() ? { code: code.trim() } : {}),
        ...(ownerWallet.trim() ? { ownerWallet: ownerWallet.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: () => {
          mint.reset();
          setCode("");
          setOwnerWallet("");
          setNote("");
          onClose();
        },
      },
    );
  };

  const field =
    "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-brand";

  return (
    <SheetShell open={open} onClose={onClose} label="Issue referral code">
      <div className="space-y-3 p-4">
        <h2 className="text-[14px] font-semibold text-fg">Issue referral code</h2>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted">
            Vanity code (blank = auto-generated)
          </span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ANSEM"
            className={field}
            maxLength={20}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted">
            Owner wallet (blank = campaign code)
          </span>
          <input
            value={ownerWallet}
            onChange={(e) => setOwnerWallet(e.target.value)}
            placeholder="0x…"
            className={field}
            spellCheck={false}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted">Seats (max uses)</span>
            <input
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              className={field}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted">Note</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. CT influencer drop"
              className={field}
              maxLength={200}
            />
          </label>
        </div>
        {error ? <ErrorNote message={error} /> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={mint.isPending}>
            {mint.isPending ? <Loader2 size={13} className="animate-spin" /> : "Issue code"}
          </Button>
        </div>
      </div>
    </SheetShell>
  );
}

function SeatsCell({ item }: { item: AdminCodeItem }) {
  const patch = usePatchAdminCode();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(item.maxUses));

  const save = () => {
    const maxUses = parseInt(value, 10);
    setEditing(false);
    if (Number.isFinite(maxUses) && maxUses >= 0 && maxUses !== item.maxUses) {
      patch.mutate({ id: item.id, maxUses });
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && save()}
        className="w-14 rounded border border-brand bg-surface px-1 py-0.5 text-right text-[12px] text-fg outline-none"
        inputMode="numeric"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setValue(String(item.maxUses));
        setEditing(true);
      }}
      className="rounded px-1 py-0.5 font-mono hover:bg-surface-2"
      title="Click to change the seat cap"
    >
      {item.usedCount}/{patch.isPending ? "…" : item.maxUses}
    </button>
  );
}

export function CodesTab() {
  const codes = useAdminCodes(true);
  const patch = usePatchAdminCode();
  const [mintOpen, setMintOpen] = useState(false);

  return (
    <Card>
      <CardHeader
        right={
          <Button size="sm" onClick={() => setMintOpen(true)}>
            <Plus size={13} /> Issue code
          </Button>
        }
      >
        Referral codes
      </CardHeader>
      <div className="p-2">
        {codes.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : codes.isError ? (
          <ErrorNote message="Could not load codes." />
        ) : (
          <AdminTable
            head={
              <>
                <Th>Code</Th>
                <Th>Status</Th>
                <Th>Owner</Th>
                <Th right>Seats</Th>
                <Th right>Joined</Th>
                <Th right>Volume</Th>
                <Th>Note</Th>
                <Th>Created</Th>
                <Th />
              </>
            }
          >
            {codes.data.codes.map((item) => (
              <tr key={item.id} className="text-fg">
                <Td mono>
                  <span className="inline-flex items-center gap-1 font-semibold tracking-wider">
                    {item.code}
                    <CopyButton text={item.code} />
                  </span>
                </Td>
                <Td>
                  <StatusBadge status={item.status} />
                </Td>
                <Td mono>{item.ownerWallet ? shortWallet(item.ownerWallet) : "campaign"}</Td>
                <Td right>
                  <SeatsCell item={item} />
                </Td>
                <Td right>{item.refereeCount}</Td>
                <Td right>{fmtUsd(item.attributedVolumeUsd)}</Td>
                <Td>
                  <span className="text-muted">{item.note ?? "—"}</span>
                </Td>
                <Td>
                  <span className="text-muted">{fmtDate(item.createdAt)}</span>
                </Td>
                <Td right>
                  <button
                    type="button"
                    onClick={() =>
                      patch.mutate({ id: item.id, disabled: item.status !== "disabled" })
                    }
                    className="rounded p-1 text-muted hover:text-fg"
                    title={item.status === "disabled" ? "Enable code" : "Pause code"}
                  >
                    {item.status === "disabled" ? <Play size={13} /> : <Pause size={13} />}
                  </button>
                </Td>
              </tr>
            ))}
          </AdminTable>
        )}
      </div>
      <MintCodeDialog open={mintOpen} onClose={() => setMintOpen(false)} />
    </Card>
  );
}
