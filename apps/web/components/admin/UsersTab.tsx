"use client";

import { useState } from "react";
import { ShieldOff, ShieldCheck } from "lucide-react";
import { useAdminGrantAccess, useAdminRevokeAccess, useAdminUsers } from "@/lib/queries";
import type { AdminUserItem } from "@/lib/types";
import { Badge, Button, Card, CardHeader, ErrorNote, Skeleton } from "@/components/ui";
import { SheetShell } from "@/components/motion/primitives";
import { CopyButton } from "@/components/profile/funds/shared";
import { AdminTable, Td, Th, fmtDate, fmtUsd, shortWallet } from "./shared";

function RevokeDialog({ user, onClose }: { user: AdminUserItem | null; onClose: () => void }) {
  const revoke = useAdminRevokeAccess();
  return (
    <SheetShell open={user !== null} onClose={onClose} label="Revoke beta access">
      <div className="space-y-3 p-4">
        <h2 className="text-[14px] font-semibold text-fg">Revoke beta access</h2>
        <p className="text-[12px] leading-snug text-muted">
          <span className="font-mono">{user ? shortWallet(user.walletAddress) : ""}</span> loses
          access immediately: allowlist off and every live session cut. Their referral binding is
          kept, so they cannot re-enter with another code — you can re-grant access here later.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={revoke.isPending}
            onClick={() => {
              if (!user) return;
              revoke.mutate(user.walletAddress, { onSuccess: onClose });
            }}
          >
            Revoke access
          </Button>
        </div>
      </div>
    </SheetShell>
  );
}

export function UsersTab() {
  const users = useAdminUsers(true);
  const grant = useAdminGrantAccess();
  const [revoking, setRevoking] = useState<AdminUserItem | null>(null);

  return (
    <Card>
      <CardHeader>Users</CardHeader>
      <div className="p-2">
        {users.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : users.isError ? (
          <ErrorNote message="Could not load users." />
        ) : (
          <AdminTable
            head={
              <>
                <Th>Wallet</Th>
                <Th>Access</Th>
                <Th>Referred by</Th>
                <Th right>Volume</Th>
                <Th right>Trades</Th>
                <Th>Last trade</Th>
                <Th>Joined</Th>
                <Th>Last seen</Th>
                <Th />
              </>
            }
          >
            {users.data.users.map((u) => (
              <tr key={u.walletAddress} className="text-fg">
                <Td mono>
                  <span className="inline-flex items-center gap-1">
                    {shortWallet(u.walletAddress)}
                    <CopyButton text={u.walletAddress} />
                  </span>
                </Td>
                <Td>
                  {u.allowlisted ? (
                    <Badge tone="pos" dot>
                      active
                    </Badge>
                  ) : (
                    <Badge tone="neg" dot>
                      revoked
                    </Badge>
                  )}
                </Td>
                <Td mono>
                  {u.referredByCode ?? (
                    <span className="text-faint">{u.allowlistAddedBy ?? "—"}</span>
                  )}
                </Td>
                <Td right>{fmtUsd(u.lifetimeVolumeUsd)}</Td>
                <Td right>{u.tradeCount}</Td>
                <Td>
                  <span className="text-muted">{fmtDate(u.lastTradeAt)}</span>
                </Td>
                <Td>
                  <span className="text-muted">{fmtDate(u.createdAt)}</span>
                </Td>
                <Td>
                  <span className="text-muted">{fmtDate(u.lastSeenAt)}</span>
                </Td>
                <Td right>
                  {u.allowlisted ? (
                    <button
                      type="button"
                      onClick={() => setRevoking(u)}
                      className="rounded p-1 text-muted hover:text-neg"
                      title="Revoke access"
                    >
                      <ShieldOff size={13} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => grant.mutate(u.walletAddress)}
                      className="rounded p-1 text-muted hover:text-pos"
                      title="Re-grant access"
                    >
                      <ShieldCheck size={13} />
                    </button>
                  )}
                </Td>
              </tr>
            ))}
          </AdminTable>
        )}
      </div>
      <RevokeDialog user={revoking} onClose={() => setRevoking(null)} />
    </Card>
  );
}
