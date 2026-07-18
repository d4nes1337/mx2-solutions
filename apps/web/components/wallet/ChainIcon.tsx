/**
 * Dependency-free chain badges: a brand-colored circle with a simple glyph or
 * letter, keyed by chainId. Recognizable next to the chain name, crisp at ~20px,
 * and self-contained (no external logo fetches — matches the app's SVG house
 * style and the artifact CSP constraints).
 */
import type { ReactNode } from "react";

interface ChainMark {
  bg: string;
  fg: string;
  glyph: (fg: string) => ReactNode;
}

const letter =
  (ch: string): ChainMark["glyph"] =>
  (fg) => (
    <text
      x="12"
      y="12.5"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={ch.length > 1 ? 8 : 11}
      fontWeight={700}
      fontFamily="ui-sans-serif, system-ui, sans-serif"
      fill={fg}
    >
      {ch}
    </text>
  );

const CHAINS: Record<string, ChainMark> = {
  // Ethereum — the diamond mark.
  "1": {
    bg: "#627EEA",
    fg: "#fff",
    glyph: () => (
      <g fill="#fff">
        <path d="M12 3.5 7.6 12 12 9.6 16.4 12 12 3.5Z" fillOpacity="0.95" />
        <path d="M12 20.5 7.6 12.9 12 15.4 16.4 12.9 12 20.5Z" fillOpacity="0.65" />
      </g>
    ),
  },
  // Optimism
  "10": { bg: "#FF0420", fg: "#fff", glyph: letter("OP") },
  // BNB Smart Chain — rotated-square diamond.
  "56": {
    bg: "#F3BA2F",
    fg: "#181818",
    glyph: (fg) => (
      <g fill={fg}>
        <rect x="8.8" y="8.8" width="6.4" height="6.4" rx="1" transform="rotate(45 12 12)" />
      </g>
    ),
  },
  // Polygon — pentagon.
  "137": {
    bg: "#8247E5",
    fg: "#fff",
    glyph: (fg) => <polygon points="12,5.5 17.2,9.3 15.2,15.5 8.8,15.5 6.8,9.3" fill={fg} />,
  },
  // Monad
  "143": { bg: "#6E54FF", fg: "#fff", glyph: letter("M") },
  // Robinhood
  "4663": { bg: "#00C805", fg: "#fff", glyph: letter("R") },
  // Base — ring.
  "8453": {
    bg: "#0052FF",
    fg: "#fff",
    glyph: (fg) => <circle cx="12" cy="12" r="4.4" fill="none" stroke={fg} strokeWidth="2.4" />,
  },
  // Arbitrum
  "42161": { bg: "#12AAFF", fg: "#fff", glyph: letter("A") },
  // HyperEVM
  "999": { bg: "#0F9D8C", fg: "#fff", glyph: letter("H") },
  // Ink
  "57073": { bg: "#7B3FE4", fg: "#fff", glyph: letter("I") },
  // Solana — three slanted bars (purple → green).
  "1151111081099710": {
    bg: "#120c1f",
    fg: "#fff",
    glyph: () => (
      <g>
        <path d="M8 8.4h7.2l-1.6 1.6H6.4z" fill="#9945FF" />
        <path d="M6.4 11.2h7.2l1.6 1.6H8z" fill="#7c53ff" />
        <path d="M8 14h7.2l-1.6 1.6H6.4z" fill="#14F195" />
      </g>
    ),
  },
  // Tron
  "728126428": { bg: "#EF0027", fg: "#fff", glyph: letter("T") },
  // Bitcoin
  "8253038": { bg: "#F7931A", fg: "#fff", glyph: letter("₿") },
};

const fallbackMark = (label: string): ChainMark => ({
  bg: "#3b3f52",
  fg: "#fff",
  glyph: letter((label.trim()[0] ?? "?").toUpperCase()),
});

export function ChainIcon({
  chainId,
  name = "",
  size = 20,
  className,
}: {
  chainId: string;
  /** Used for the fallback letter + accessible label. */
  name?: string;
  size?: number;
  className?: string;
}) {
  const mark = CHAINS[chainId] ?? fallbackMark(name || chainId);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={name ? `${name} logo` : `chain ${chainId}`}
    >
      <circle cx="12" cy="12" r="12" fill={mark.bg} />
      {mark.glyph(mark.fg)}
    </svg>
  );
}
