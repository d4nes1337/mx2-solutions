import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        "surface-3": "var(--surface-3)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        fg: "var(--fg)",
        brand: "var(--brand)",
        "brand-strong": "var(--brand-strong)",
        "brand-soft": "var(--brand-soft)",
        accent: "var(--accent)",
        pos: "var(--pos)",
        neg: "var(--neg)",
        warn: "var(--warn)",
      },
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      // Semantic type ramp (Polymarket-calm). Additive — merges with Tailwind's
      // defaults; numbers stay mono via the `.tabular` class.
      fontSize: {
        micro: ["10px", { lineHeight: "14px", letterSpacing: "0.02em" }],
        label: ["11px", { lineHeight: "14px", letterSpacing: "0.02em" }],
        title: ["15px", { lineHeight: "20px", letterSpacing: "-0.01em" }],
        hero: ["28px", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
        "hero-lg": ["40px", { lineHeight: "1.0", letterSpacing: "-0.03em" }],
      },
      // Sharp design language: tight radii, never pill-soft (except `full`).
      borderRadius: {
        none: "0",
        sm: "2px",
        DEFAULT: "3px",
        md: "4px",
        lg: "6px",
        xl: "8px",
        "2xl": "10px",
        full: "9999px",
      },
      boxShadow: {
        panel: "0 1px 0 0 rgba(255,255,255,0.02) inset, 0 8px 24px -16px rgba(0,0,0,0.8)",
        pop: "0 12px 40px -12px rgba(0,0,0,0.85), 0 0 0 1px var(--border)",
        elev: "0 2px 4px -2px rgba(0,0,0,0.6), 0 18px 48px -24px rgba(0,0,0,0.9)",
        "glow-pos": "0 0 20px -6px rgba(43,217,140,0.6)",
        "glow-neg": "0 0 20px -6px rgba(255,77,94,0.6)",
      },
      transitionTimingFunction: {
        snap: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
