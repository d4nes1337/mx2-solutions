"use client";

/** Small shared pieces of the Funds sheet panels. */
import { useMemo, useState } from "react";
import { encode } from "uqr";
import { Check, Copy } from "lucide-react";
import { ApiError } from "@/lib/api";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded p-1 text-muted hover:text-fg"
      title="Copy"
    >
      {copied ? <Check size={13} className="text-pos" /> : <Copy size={13} />}
    </button>
  );
}

/** Scannable deposit address. Fixed white/black: scanners need the contrast. */
export function QrBadge({ value }: { value: string }) {
  const qr = useMemo(() => encode(value, { border: 2, ecc: "M" }), [value]);
  const path = useMemo(() => {
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return d;
  }, [qr]);
  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className="h-[104px] w-[104px] shrink-0 rounded-md bg-white"
      shapeRendering="crispEdges"
      role="img"
      aria-label="Deposit address QR code"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

export const errorText = (e: unknown): string | null =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : null;
