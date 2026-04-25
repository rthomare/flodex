import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // CSS-var driven semantic tokens (theme-aware via [data-theme]).
        // Vars hold space-separated R G B so Tailwind's <alpha-value>
        // syntax (e.g. `text-fg/40`) composes correctly.
        bg: "rgb(var(--bg) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        // `track` carries baked alpha — used as `bg-track` (no /X suffix).
        track: "var(--track)",
        // Legacy fixed background; kept for any inline style that hardcodes it.
        void: "#050510",
        // Status accents stay fixed across themes — they encode meaning,
        // not chrome.
        holo: {
          cyan: "#66ccff",
          amber: "#ffbb44",
          green: "#66ffaa",
          red: "#ff5566",
          violet: "#b48cff",
        },
      },
      fontFamily: {
        mono: ["SF Mono", "Geist Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px rgba(102, 204, 255, 0.35)",
        cardGlow: "0 0 0 1px rgba(102, 204, 255, 0.15), 0 12px 40px rgba(0,0,0,0.5)",
      },
    },
  },
  plugins: [],
};
export default config;
