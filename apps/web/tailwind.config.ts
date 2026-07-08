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
      // Calm card language: soft radii, generous corners (Polymarket-like).
      borderRadius: {
        none: "0",
        sm: "4px",
        DEFAULT: "8px",
        md: "10px",
        lg: "12px",
        xl: "16px",
        "2xl": "20px",
        full: "9999px",
      },
      boxShadow: {
        panel: "0 1px 2px 0 rgba(16,24,64,0.04), 0 8px 24px -16px rgba(16,24,64,0.1)",
        pop: "0 12px 40px -12px rgba(16,24,64,0.18), 0 0 0 1px var(--border)",
        elev: "0 2px 4px -2px rgba(16,24,64,0.06), 0 18px 48px -24px rgba(16,24,64,0.14)",
        "glow-pos": "0 0 20px -6px rgba(15,157,99,0.35)",
        "glow-neg": "0 0 20px -6px rgba(217,45,63,0.35)",
      },
      transitionTimingFunction: {
        snap: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
