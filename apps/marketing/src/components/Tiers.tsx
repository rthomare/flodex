"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import { Reveal } from "./Reveal";

type Tier = {
  name: string;
  status: "live" | "live-research" | "research" | "planned";
  tagline: string;
  body: string;
  privacy: number; // 0-4
  cost: string;
  accent: string;
};

const tiers: Tier[] = [
  {
    name: "frontier model",
    status: "live",
    tagline: "Top-tier AI, encrypted in transit.",
    body: "A best-in-class hosted model behind the encrypted protocol. Same answers you'd get from a big provider, but the request is sealed end-to-end and you pay per use. No accounts. No retention.",
    privacy: 2,
    cost: "$$$",
    accent: "text-holo-cyan",
  },
  {
    name: "local model",
    status: "live",
    tagline: "Open models on someone's home rig.",
    body: "Pick from open-source models running on a host's actual hardware. The host's machine is sandboxed: while it runs your model, it can't reach the internet at all. Cheap, private, and the host literally cannot leak your data.",
    privacy: 3,
    cost: "$",
    accent: "text-holo-green",
  },
  {
    name: "encrypted math",
    status: "research",
    tagline: "Even the host can't read it.",
    body: "Run computations directly on encrypted data. The host's machine never sees your prompt in plaintext — not in memory, not anywhere. Early research today; the strongest privacy guarantee on the roadmap.",
    privacy: 4,
    cost: "$$$$",
    accent: "text-holo-violet",
  },
  {
    name: "secure enclave",
    status: "planned",
    tagline: "Hardware-proven privacy.",
    body: "Specialized chips (the same ones Apple and AWS use) run the model inside a locked vault and prove cryptographically what's running before you trust it. Same experience, with hardware-backed receipts.",
    privacy: 4,
    cost: "$$$",
    accent: "text-holo-amber",
  },
];

const statusLabel: Record<Tier["status"], string> = {
  live: "live",
  "live-research": "live · research",
  research: "research",
  planned: "planned",
};

const statusColor: Record<Tier["status"], string> = {
  live: "bg-holo-green/15 text-holo-green border-holo-green/30",
  "live-research": "bg-holo-amber/15 text-holo-amber border-holo-amber/30",
  research: "bg-holo-violet/15 text-holo-violet border-holo-violet/30",
  planned: "bg-fg/10 text-fg/60 border-fg/20",
};

export function Tiers() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });
  // Translate the inner row left as we scroll. -75% covers 4 cards on desktop.
  const x = useTransform(scrollYProgress, [0, 1], ["0%", "-75%"]);

  return (
    <section
      ref={ref}
      className="relative h-[400vh] hidden md:block"
      aria-label="Trust tiers"
    >
      <div className="sticky top-0 h-screen flex flex-col overflow-hidden">
        <div className="pt-28 px-6 max-w-7xl w-full mx-auto">
          <Reveal>
            <div className="mono text-xs uppercase tracking-[0.3em] text-accent/80 mb-4">
              // trust tiers
            </div>
            <div className="flex items-end justify-between gap-8 flex-wrap">
              <h2 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-3xl leading-[1.1]">
                Privacy is a dial,
                <br />
                not a switch.
              </h2>
              <p className="mono text-xs uppercase tracking-[0.25em] text-fg/40">
                ↓ scroll to traverse
              </p>
            </div>
          </Reveal>
        </div>

        <div className="flex-1 flex items-center">
          <motion.div
            style={{ x }}
            className="flex gap-6 px-[8vw] will-change-transform"
          >
            {tiers.map((t) => (
              <TierCard key={t.name} tier={t} />
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
}

// Mobile fallback: vertical stack, no pin.
export function TiersMobile() {
  return (
    <section className="md:hidden py-24 px-6">
      <Reveal>
        <div className="mono text-xs uppercase tracking-[0.3em] text-accent/80 mb-4">
          // trust tiers
        </div>
        <h2 className="text-4xl font-semibold tracking-tight leading-[1.1]">
          Privacy is a dial, not a switch.
        </h2>
      </Reveal>
      <div className="mt-12 grid gap-5">
        {tiers.map((t) => (
          <TierCard key={t.name} tier={t} />
        ))}
      </div>
    </section>
  );
}

function TierCard({ tier }: { tier: Tier }) {
  return (
    <motion.div
      whileHover={{ y: -4 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="glass rounded-2xl p-7 md:p-8 w-[88vw] md:w-[420px] flex-shrink-0"
    >
      <div className="flex items-center justify-between mb-5">
        <span
          className={`mono text-[10px] uppercase tracking-[0.25em] px-2.5 py-1 rounded-full border ${statusColor[tier.status]}`}
        >
          {statusLabel[tier.status]}
        </span>
        <span className="mono text-xs text-fg/40">{tier.cost}</span>
      </div>
      <h3 className={`text-3xl font-semibold mb-1 ${tier.accent}`}>
        {tier.name}
      </h3>
      <p className="text-fg/80 mb-5 text-base">{tier.tagline}</p>
      <p className="text-fg/60 leading-relaxed text-[15px] mb-6">{tier.body}</p>
      <PrivacyBar level={tier.privacy} />
    </motion.div>
  );
}

function PrivacyBar({ level }: { level: number }) {
  return (
    <div>
      <div className="flex items-center justify-between mono text-[10px] uppercase tracking-[0.25em] text-fg/40 mb-2">
        <span>privacy</span>
        <span>{level}/4</span>
      </div>
      <div className="flex gap-1.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full ${
              i < level ? "bg-accent" : "bg-fg/10"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
