import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        track: "var(--track)",
        void: "#050510",
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
        display: ["SF Pro Display", "Inter", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 24px rgba(102, 204, 255, 0.35)",
        cardGlow:
          "0 0 0 1px rgba(102, 204, 255, 0.15), 0 12px 40px rgba(0,0,0,0.5)",
      },
      keyframes: {
        drift: {
          "0%, 100%": { transform: "translate3d(0,0,0)" },
          "50%": { transform: "translate3d(20px, -10px, 0)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "0.9" },
        },
      },
      animation: {
        drift: "drift 18s ease-in-out infinite",
        pulseSoft: "pulseSoft 3.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
