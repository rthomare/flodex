"use client";

import { motion } from "framer-motion";
import { Reveal } from "./Reveal";

export function Footer() {
  return (
    <footer className="relative pt-32 pb-12 px-6 overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent"
      />
      <motion.div
        aria-hidden
        className="absolute -bottom-40 left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgba(102,204,255,0.10), transparent 60%)",
        }}
        animate={{ scale: [1, 1.08, 1] }}
        transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="relative max-w-5xl mx-auto text-center">
        <Reveal>
          <h2 className="text-5xl md:text-7xl font-semibold tracking-tight leading-[1.05]">
            <span className="bg-gradient-to-r from-holo-cyan via-accent to-holo-violet bg-clip-text text-transparent">
              Run a node.
            </span>
            <br />
            Earn for inference.
          </h2>
          <p className="mt-7 text-lg md:text-xl text-fg/65 max-w-2xl mx-auto leading-relaxed">
            Operators set their own price, stake USDC, and get paid in
            channelized USDC per round trip. Two laptops, fifteen minutes, live
            on Sepolia.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href="https://github.com/rthomare/flodex#onboarding"
              target="_blank"
              rel="noreferrer"
              className="group px-6 py-3 rounded-full bg-accent text-bg mono text-sm font-medium hover:shadow-glow transition-shadow"
            >
              run a node
              <span className="ml-2 inline-block transition-transform group-hover:translate-x-1">
                →
              </span>
            </a>
            <a
              href="https://dashboard.fldx.ai"
              target="_blank"
              rel="noreferrer"
              className="px-6 py-3 rounded-full border border-accent/30 text-fg/90 mono text-sm hover:bg-accent/10 transition-colors"
            >
              open dashboard
            </a>
            <a
              href="https://github.com/rthomare/flodex"
              target="_blank"
              rel="noreferrer"
              className="px-6 py-3 rounded-full border border-fg/20 text-fg/70 mono text-sm hover:border-fg/40 hover:text-fg transition-colors"
            >
              source on github
            </a>
          </div>
        </Reveal>

        <div className="mt-24 pt-8 border-t border-accent/10 flex flex-col md:flex-row items-center justify-between gap-4 mono text-xs text-fg/40">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-holo-green animate-pulseSoft" />
            fldx · pre-alpha v0
          </div>
          <div className="flex items-center gap-5">
            <a
              href="https://github.com/rthomare/flodex"
              target="_blank"
              rel="noreferrer"
              className="hover:text-fg transition-colors"
            >
              github
            </a>
            <a
              href="https://dashboard.fldx.ai"
              target="_blank"
              rel="noreferrer"
              className="hover:text-fg transition-colors"
            >
              dashboard
            </a>
            <a
              href="https://coordinator.fldx.ai/nodes"
              target="_blank"
              rel="noreferrer"
              className="hover:text-fg transition-colors"
            >
              coordinator
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
