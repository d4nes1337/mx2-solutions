"use client";

/**
 * Browser tab title + favicon badge (brief §6.7). A pure signal — the header
 * bell remains the clickable control. With actionable items the title becomes
 * "(N) Ready to sign · Arima" and the favicon is replaced by a high-contrast
 * badged icon; at zero (and on sign-out) both restore to the original.
 */

let originalTitle: string | null = null;
let originalFavicon: string | null = null;
let faviconLink: HTMLLinkElement | null = null;

const ensureFaviconLink = (): HTMLLinkElement | null => {
  if (typeof document === "undefined") return null;
  if (faviconLink) return faviconLink;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  faviconLink = link;
  if (originalFavicon === null) originalFavicon = link.getAttribute("href");
  return link;
};

/** Draws a brand-square favicon with a small count (or a dot for presence). */
const drawBadge = (count: number): string | null => {
  if (typeof document === "undefined") return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  // Canvas may be unavailable (SSR/jsdom); degrade to no favicon swap.
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return null;
  }
  if (!ctx) return null;
  // Brand rounded square.
  ctx.fillStyle = "#2a36ff";
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
  ctx.fill();
  // Count (1–9, then 9+) or a dot.
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (count > 0) {
    const label = count > 9 ? "9+" : String(count);
    ctx.font = `bold ${count > 9 ? 34 : 44}px system-ui, sans-serif`;
    ctx.fillText(label, size / 2, size / 2 + 3);
  } else {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 14, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.toDataURL("image/png");
};

/** count > 0 → badge the title + favicon; count === 0 → restore. */
export const setTabBadge = (count: number): void => {
  if (typeof document === "undefined") return;
  if (originalTitle === null) originalTitle = document.title;

  if (count > 0) {
    document.title = `(${count > 9 ? "9+" : count}) Ready to sign · Arima`;
    const link = ensureFaviconLink();
    const dataUrl = drawBadge(count);
    if (link && dataUrl) link.setAttribute("href", dataUrl);
  } else {
    restoreTab();
  }
};

/** Restore the route title + original favicon (zero count, or sign-out). */
export const restoreTab = (): void => {
  if (typeof document === "undefined") return;
  if (originalTitle !== null) document.title = originalTitle;
  const link = ensureFaviconLink();
  if (link && originalFavicon !== null) link.setAttribute("href", originalFavicon);
  else if (link) link.setAttribute("href", "/icon.svg");
};
