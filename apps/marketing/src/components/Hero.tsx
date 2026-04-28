"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";

export function Hero() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });
  const yGrid = useTransform(scrollYProgress, [0, 1], [0, 200]);
  const opacityFade = useTransform(scrollYProgress, [0, 0.8], [1, 0]);
  const scaleHero = useTransform(scrollYProgress, [0, 1], [1, 0.94]);

  return (
    <section
      id="top"
      ref={ref}
      className="relative min-h-[100svh] flex items-center justify-center overflow-hidden"
    >
      {/* Animated grid backdrop */}
      <motion.div
        style={{ y: yGrid }}
        className="absolute inset-0 hex-grid opacity-60 fade-edge-bottom"
      />

      {/* Floating orbs */}
      <motion.div
        aria-hidden
        className="absolute -top-40 -left-40 w-[520px] h-[520px] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgba(102,204,255,0.18), transparent 60%)",
        }}
        animate={{ x: [0, 60, 0], y: [0, 40, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        aria-hidden
        className="absolute -bottom-40 -right-40 w-[600px] h-[600px] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgba(180,140,255,0.15), transparent 60%)",
        }}
        animate={{ x: [0, -50, 0], y: [0, -30, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
      />

      <motion.div
        style={{ opacity: opacityFade, scale: scaleHero }}
        className="relative z-10 max-w-5xl mx-auto px-6 text-center"
      >
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="inline-flex items-center gap-2 mono text-[11px] uppercase tracking-[0.25em] px-3 py-1.5 rounded-full border border-accent/30 text-accent/90 mb-8 shimmer"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-holo-green animate-pulseSoft" />
          pre-alpha v0 — live on base sepolia
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="text-5xl md:text-7xl lg:text-8xl font-semibold tracking-tight leading-[1.05]"
        >
          LLM execution
          <br />
          <span className="bg-gradient-to-r from-holo-cyan via-accent to-holo-violet bg-clip-text text-transparent">
            you don&apos;t have to trust.
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="mt-7 text-lg md:text-xl text-fg/70 max-w-2xl mx-auto leading-relaxed"
        >
          End-to-end encrypted requests. Pluggable trust tiers. On-chain
          settlement. fldx is a decentralized network where the operator never
          sees your prompt — and you can prove it.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3"
        >
          <a
            href="https://dashboard.fldx.ai"
            target="_blank"
            rel="noreferrer"
            className="group relative px-6 py-3 rounded-full bg-accent text-bg mono text-sm font-medium hover:shadow-glow transition-shadow"
          >
            launch dashboard
            <span className="ml-2 inline-block transition-transform group-hover:translate-x-1">
              →
            </span>
          </a>
          <a
            href="#how"
            className="px-6 py-3 rounded-full border border-accent/30 text-fg/90 mono text-sm hover:bg-accent/10 transition-colors"
          >
            how it works
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1.2, delay: 0.8 }}
          className="mt-16 mono text-[11px] uppercase tracking-[0.3em] text-fg/40"
        >
          ↓ scroll
        </motion.div>
      </motion.div>
    </section>
  );
}
