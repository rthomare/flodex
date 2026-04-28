"use client";

import { motion } from "framer-motion";
import { Reveal } from "./Reveal";

const works = [
  "X25519 + HKDF + XChaCha20-Poly1305 transport",
  "secp256k1 node identity, signed registrations + heartbeats",
  "Agent loop with cross-boundary client-side tools",
  "Two backends: hosted Claude (mock TEE) + sandboxed llama.cpp (local)",
  "Per-round-trip token usage, accumulated per session",
  "NodeRegistry on Base Sepolia (USDC stake)",
  "Bilateral payment channels, cumulative receipts",
  "macOS sandbox on the local LLM subprocess",
  "TS CLI + Next.js dashboard with d3-force graph",
];

const todo = [
  "Real Nitro / SGX attestation",
  "FHE backend (TFHE-rs research track)",
  "JobChannel redeploy after rewrite",
  "Session keys (kill the per-receipt wallet popup)",
  "Linux + Windows sandbox parity",
  "Tier-aware automatic routing",
];

export function Status() {
  return (
    <section className="relative py-32 md:py-48 px-6">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <div className="mono text-xs uppercase tracking-[0.3em] text-accent/80 mb-4">
            // status
          </div>
          <h2 className="text-4xl md:text-6xl font-semibold tracking-tight leading-[1.1] max-w-3xl">
            What works.
            <br />
            <span className="text-fg/50">What doesn&apos;t. Yet.</span>
          </h2>
          <p className="mt-6 text-lg text-fg/65 max-w-2xl leading-relaxed">
            fldx is pre-alpha v0. The protocol is real, the encryption is real,
            the on-chain settlement is real. The trust tiers people will care
            most about — FHE, real TEEs — are not.
          </p>
        </Reveal>

        <div className="mt-16 grid md:grid-cols-2 gap-5">
          <Column
            title="Live today"
            items={works}
            dot="bg-holo-green"
            badge="text-holo-green border-holo-green/30 bg-holo-green/10"
          />
          <Column
            title="Not yet"
            items={todo}
            dot="bg-holo-amber"
            badge="text-holo-amber border-holo-amber/30 bg-holo-amber/10"
          />
        </div>
      </div>
    </section>
  );
}

function Column({
  title,
  items,
  dot,
  badge,
}: {
  title: string;
  items: string[];
  dot: string;
  badge: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="glass rounded-2xl p-7 md:p-8"
    >
      <div
        className={`inline-block mono text-[10px] uppercase tracking-[0.25em] px-2.5 py-1 rounded-full border ${badge} mb-6`}
      >
        {title}
      </div>
      <ul className="space-y-3.5">
        {items.map((item, i) => (
          <motion.li
            key={item}
            initial={{ opacity: 0, x: -8 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{
              duration: 0.5,
              delay: i * 0.04,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="flex items-start gap-3 text-fg/80 text-[15px]"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 ${dot}`}
            />
            <span>{item}</span>
          </motion.li>
        ))}
      </ul>
    </motion.div>
  );
}
