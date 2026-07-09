/**
 * Single source of truth for the arima "A" mark (two angular shards forming a
 * capital A). Shared by the header logo, static favicon/app-icon, and the
 * standalone share-card SVG template — each renders it with its own fill
 * treatment, but the path data itself is defined exactly once.
 */
export const LOGO_MARK_VIEWBOX = "0 0 456 392";

export const LOGO_MARK_PATHS = [
  "M0 391.779L227.917 0L291.646 115.448C291.646 115.448 260.257 176.152 226.428 234.621C197.769 284.152 179.503 328.007 140.028 343.738C100.552 359.469 0 391.779 0 391.779Z",
  "M245.042 281.916C252.486 268.882 318.035 156.785 318.035 156.785L455.456 390.661C455.456 390.661 274.466 329.059 257.704 322.509C240.942 315.959 237.597 294.951 245.042 281.916Z",
] as const;
