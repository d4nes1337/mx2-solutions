// Turn a rendered <svg> template into a PNG the user can save/copy/share.
//
// SVG-first keeps export deterministic and dependency-free. The one rule: any
// <image> inside the SVG must be a data-URL — a cross-origin bitmap taints the
// canvas and `toBlob` throws. The default template avoids external images.

import type { FlexCardModel } from "./types";

/** Rasterize an <svg> DOM node to a PNG blob at `scale`× its viewBox size. */
export async function svgNodeToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const vb = svg.viewBox?.baseVal;
  const width = (vb && vb.width) || svg.clientWidth || 1200;
  const height = (vb && vb.height) || svg.clientHeight || 675;

  const xml = new XMLSerializer().serializeToString(svg);
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;

  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load serialized SVG"));
    img.src = src;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png",
    );
  });
}

export function flexCardFilename(model: FlexCardModel): string {
  const slug = (model.title || "arima-card")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
  return `${model.brandLabel ?? "arima"}-${slug || "card"}.png`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function canCopyImage(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "clipboard" in navigator &&
    typeof ClipboardItem !== "undefined"
  );
}

export async function copyBlobToClipboard(blob: Blob): Promise<void> {
  if (!canCopyImage()) throw new Error("Clipboard image copy unsupported");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function canShareImage(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.canShare === "function";
}

export async function shareBlob(blob: Blob, filename: string, text?: string): Promise<void> {
  const file = new File([blob], filename, { type: "image/png" });
  if (!canShareImage() || !navigator.canShare({ files: [file] })) {
    throw new Error("Web Share (files) unsupported");
  }
  await navigator.share({ files: [file], text });
}
