"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import { Reveal } from "./Reveal";

const steps = [
  {
    n: "01",
    label: "client",
    title: "Encrypt at the source.",
    body: "X25519 ECDH against the node's static public key. HKDF-SHA256 derives a session key. Payload sealed with XChaCha20-Poly1305. The bytes that leave your machine are unreadable to anyone but the chosen node.",
  },
  {
    n: "02",
    label: "coordinator",
    title: "Match without inspecting.",
    body: "A thin axum service routes by spec — backend, model, price ceiling — never by request body. Nodes register and bid; clients pick. The coordinator is replaceable; the encryption isn't.",
  },
  {
    n: "03",
    label: "node",
    title: "Decrypt inside a backend.",
    body: "The execution backend is the trust boundary. Today: a mock TEE running Claude, or a sandboxed local llama.cpp. Tomorrow: real Nitro/SGX, FHE compute, zkML. Same wire protocol; different physics.",
  },
];

export function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const lineProgress = useTransform(scrollYProgress, [0.1, 0.85], [0, 1]);

  return (
    <section
      id="how"
      ref={ref}
      className="relative py-32 md:py-48 px-6 overflow-hidden"
    >
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent"
      />
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <div className="mono text-xs uppercase tracking-[0.3em] text-accent/80 mb-4">
            // how it works
          </div>
          <h2 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-3xl leading-[1.1]">
            Three roles. One encrypted path.
          </h2>
          <p className="mt-6 text-lg text-fg/65 max-w-2xl leading-relaxed">
            The whole point of fldx is that no link in the chain has to be
            trusted with your data. Here&apos;s why.
          </p>
        </Reveal>

        {/* Animated wire diagram (desktop) */}
        <div className="mt-20 hidden md:block relative">
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox="0 0 1000 120"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="wire" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="#66ccff" />
                <stop offset="50%" stopColor="#b48cff" />
                <stop offset="100%" stopColor="#66ffaa" />
              </linearGradient>
            </defs>
            <motion.line
              x1="0"
              y1="60"
              x2="1000"
              y2="60"
              stroke="url(#wire)"
              strokeWidth="1.5"
              style={{ pathLength: lineProgress }}
              strokeDasharray="0 1"
            />
          </svg>

          <div className="grid grid-cols-3 gap-6 relative">
            {steps.map((s, i) => (
              <Step key={s.n} step={s} index={i} />
            ))}
          </div>
        </div>

        {/* Stacked (mobile) */}
        <div className="mt-16 grid md:hidden gap-5">
          {steps.map((s, i) => (
            <Step key={s.n} step={s} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Step({
  step,
  index,
}: {
  step: (typeof steps)[number];
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 36 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.7, delay: index * 0.15, ease: [0.16, 1, 0.3, 1] }}
      className="glass rounded-2xl p-7 relative"
    >
      <div className="absolute -top-3 left-7 px-3 py-1 rounded-full bg-bg border border-accent/30 mono text-[10px] uppercase tracking-[0.25em] text-accent">
        {step.label}
      </div>
      <div className="flex items-baseline justify-between mt-3 mb-5">
        <span className="mono text-sm text-fg/40">{step.n}</span>
        <span className="w-2 h-2 rounded-full bg-holo-green animate-pulseSoft" />
      </div>
      <h3 className="text-xl font-semibold mb-3 leading-tight">{step.title}</h3>
      <p className="text-fg/65 leading-relaxed text-[15px]">{step.body}</p>
    </motion.div>
  );
}
