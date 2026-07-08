"use client";

/**
 * Cockpit entry into the Smart Order builder, pre-bound to this market:
 * the killer feature is one click away from every market page.
 */
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { Card, CardHeader } from "@/components/ui";
import { TEMPLATES } from "@/lib/smart-orders/templates";

export function AutomateCard({
  conditionId,
  tokenId,
  outcome,
  title,
}: {
  conditionId: string;
  tokenId: string | undefined;
  outcome: string;
  title: string;
}) {
  const href = (templateId: string) =>
    `/smart-orders/new?template=${templateId}` +
    (tokenId
      ? `&conditionId=${encodeURIComponent(conditionId)}&tokenId=${encodeURIComponent(tokenId)}` +
        `&outcome=${encodeURIComponent(outcome)}&title=${encodeURIComponent(title.slice(0, 120))}`
      : "");

  return (
    <Card className="h-fit">
      <CardHeader>Automate this market</CardHeader>
      <div className="space-y-1.5 p-3">
        {TEMPLATES.map((t) => (
          <Link
            key={t.id}
            href={href(t.id)}
            className="group flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2 transition-colors hover:border-brand/50"
          >
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-fg">{t.name}</div>
              <div className="truncate text-[11px] text-muted">{t.blurb}</div>
            </div>
            <ArrowRight
              size={14}
              className="shrink-0 text-faint transition-colors group-hover:text-accent"
              aria-hidden
            />
          </Link>
        ))}
        <Link
          href={href(TEMPLATES[0]!.id)}
          className="mt-1 flex items-center justify-center gap-1.5 rounded-lg border border-brand bg-brand px-3 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-brand-strong"
        >
          <Sparkles size={13} aria-hidden /> Create Smart Order
        </Link>
      </div>
    </Card>
  );
}
