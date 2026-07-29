"use client";

import { useAdminWaitlist } from "@/lib/queries";
import { Badge, Card, CardHeader, ErrorNote, Skeleton } from "@/components/ui";
import { CopyButton } from "@/components/profile/funds/shared";
import { AdminTable, Td, Th, fmtDate, shortWallet } from "./shared";

const STATUS_TONE: Record<string, "pos" | "neutral" | "warn" | "neg" | "accent"> = {
  waiting: "warn",
  invited: "accent",
  accepted: "pos",
  rejected: "neg",
  withdrawn: "neutral",
};

export function WaitlistTab() {
  const waitlist = useAdminWaitlist(true);

  return (
    <Card>
      <CardHeader>Waitlist</CardHeader>
      <div className="p-2">
        {waitlist.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : waitlist.isError ? (
          <ErrorNote message="Could not load the waitlist." />
        ) : waitlist.data.entries.length === 0 ? (
          <p className="p-2 text-[12px] text-muted">No waitlist entries yet.</p>
        ) : (
          <AdminTable
            head={
              <>
                <Th>Contact</Th>
                <Th>Wallet</Th>
                <Th>Status</Th>
                <Th>Frequency</Th>
                <Th>Use case</Th>
                <Th>Heard via</Th>
                <Th>Joined</Th>
              </>
            }
          >
            {waitlist.data.entries.map((e) => (
              <tr key={e.id} className="text-fg">
                <Td>
                  <span className="inline-flex items-center gap-1">
                    {e.email ?? e.socialHandle ?? "—"}
                    {e.email ? <CopyButton text={e.email} /> : null}
                  </span>
                </Td>
                <Td mono>{e.walletAddress ? shortWallet(e.walletAddress) : "—"}</Td>
                <Td>
                  <Badge tone={STATUS_TONE[e.status] ?? "neutral"} dot>
                    {e.status}
                  </Badge>
                </Td>
                <Td>
                  <span className="text-muted">{e.tradingFrequency ?? "—"}</span>
                </Td>
                <Td>
                  <span className="block max-w-[220px] truncate text-muted" title={e.useCase ?? ""}>
                    {e.useCase ?? "—"}
                  </span>
                </Td>
                <Td>
                  <span className="text-muted">{e.referral ?? "—"}</span>
                </Td>
                <Td>
                  <span className="text-muted">{fmtDate(e.createdAt)}</span>
                </Td>
              </tr>
            ))}
          </AdminTable>
        )}
      </div>
    </Card>
  );
}
