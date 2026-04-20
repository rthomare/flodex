import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#050510",
        panel: "rgba(10, 14, 28, 0.75)",
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
