"use client";

import { useRef, useState } from "react";
import type { FlexCardModel } from "./types";
import { getFlexTemplate, listFlexTemplates } from "./templates/registry";
import {
  canCopyImage,
  canShareImage,
  copyBlobToClipboard,
  downloadBlob,
  flexCardFilename,
  shareBlob,
  svgNodeToPngBlob,
} from "./export";
import { Button, Segmented } from "../ui";

/**
 * Preview + export a shareable card. Renders the selected registered template
 * (a designer adds more via the registry) and rasterizes its <svg> to PNG.
 */
export function FlexCardSheet({
  model,
  open,
  onClose,
}: {
  model: FlexCardModel;
  open: boolean;
  onClose: () => void;
}) {
  const [templateId, setTemplateId] = useState(model.templateId ?? "default");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  if (!open) return null;

  const tpl = getFlexTemplate(templateId);
  const Template = tpl.Component;
  const templates = listFlexTemplates();

  const run = async (kind: string, fn: (blob: Blob) => Promise<void> | void) => {
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return;
    setBusy(kind);
    setStatus(null);
    try {
      const blob = await svgNodeToPngBlob(svg as SVGSVGElement, 2);
      await fn(blob);
    } catch {
      setStatus("Export failed — check the template’s images are inlined.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="glass relative w-full max-w-2xl rounded-lg p-4 shadow-pop">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg">Share your PnL</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted transition-colors hover:text-fg"
          >
            ✕
          </button>
        </div>

        {templates.length > 1 ? (
          <div className="mb-3">
            <Segmented
              options={templates.map((t) => ({ value: t.id, label: t.label }))}
              value={templateId}
              onChange={setTemplateId}
            />
          </div>
        ) : null}

        <div
          ref={containerRef}
          className="overflow-hidden rounded-md border border-border [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
        >
          <Template model={{ ...model, templateId }} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            onClick={() => run("download", (b) => downloadBlob(b, flexCardFilename(model)))}
            disabled={Boolean(busy)}
          >
            {busy === "download" ? "Rendering…" : "Download PNG"}
          </Button>
          {canCopyImage() ? (
            <Button
              variant="ghost"
              onClick={() =>
                run("copy", async (b) => {
                  await copyBlobToClipboard(b);
                  setStatus("Copied to clipboard");
                })
              }
              disabled={Boolean(busy)}
            >
              Copy
            </Button>
          ) : null}
          {canShareImage() ? (
            <Button
              variant="ghost"
              onClick={() =>
                run("share", (b) => shareBlob(b, flexCardFilename(model), model.title))
              }
              disabled={Boolean(busy)}
            >
              Share
            </Button>
          ) : null}
          {status ? <span className="text-xs text-muted">{status}</span> : null}
          <span className="ml-auto text-[10px] text-faint">No wallet address on the card.</span>
        </div>
      </div>
    </div>
  );
}
