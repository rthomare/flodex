"use client";

import { motion } from "framer-motion";
import { Reveal } from "./Reveal";
import { SavingsCalculator } from "./SavingsCalculator";

const rentBullets = [
  "Pick a model, send a request — it runs on someone else's hardware.",
  "Pay per request. No subscription, no minimums, no credit card.",
  "Your prompt is sealed before it leaves your computer. The host can't read it.",
  "Wallet connect, run, done.",
];

const earnBullets = [
  "Your machine is online anyway. Let it earn while you're not using it.",
  "List the models you can run and the price you'll accept.",
  "Get paid in stablecoins, automatically, every time someone uses your node.",
  "Walk away whenever you want — no lock-in, no contract.",
];

export function TwoSides() {
  return (
    <section
      id="earn"
      className="relative py-32 md:py-48 px-6 overflow-hidden"
    >
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent"
      />
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <div className="mono text-xs uppercase tracking-[0.3em] text-accent/80 mb-4">
            // two sides
          </div>
          <h2 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-3xl leading-[1.1]">
            One marketplace.
            <br />
            <span className="text-fg/50">Both sides of the trade.</span>
          </h2>
          <p className="mt-6 text-lg text-fg/65 max-w-2xl leading-relaxed">
            Whether you&apos;re paying for AI or paying off a graphics card,
            fldx puts you in the same room as the other half of the deal.
          </p>
        </Reveal>

        <div className="mt-20 grid md:grid-cols-2 gap-5">
          <Side
            tag="for users"
            tagColor="text-holo-cyan border-holo-cyan/30 bg-holo-cyan/10"
            title="Rent compute."
            tagline="Pay-per-request access to AI, in crypto."
            bullets={rentBullets}
            cta={{ label: "open dashboard", href: "https://dashboard.fldx.ai" }}
            accent="from-holo-cyan via-accent to-holo-cyan"
          />
          <Side
            tag="for hosts"
            tagColor="text-holo-green border-holo-green/30 bg-holo-green/10"
            title="Earn with your machine."
            tagline="List your idle hardware. Get paid when it runs."
            bullets={earnBullets}
            cta={{
              label: "run a node",
              href: "https://github.com/rthomare/flodex#running-a-node",
            }}
            accent="from-holo-green via-accent to-holo-violet"
          />
        </div>

        <SavingsCalculator />
      </div>
    </section>
  );
}

function Side({
  tag,
  tagColor,
  title,
  tagline,
  bullets,
  cta,
  accent,
}: {
  tag: string;
  tagColor: string;
  title: string;
  tagline: string;
  bullets: string[];
  cta: { label: string; href: string };
  accent: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 32 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="glass rounded-2xl p-7 md:p-9 relative overflow-hidden"
    >
      <div
        aria-hidden
        className={`absolute -top-24 -right-24 w-56 h-56 rounded-full blur-3xl bg-gradient-to-br ${accent} opacity-20`}
      />
      <div className="relative">
        <div
          className={`inline-block mono text-[10px] uppercase tracking-[0.25em] px-2.5 py-1 rounded-full border ${tagColor} mb-6`}
        >
          {tag}
        </div>
        <h3 className="text-3xl md:text-4xl font-semibold tracking-tight mb-2">
          {title}
        </h3>
        <p className="text-fg/70 text-[17px] mb-7 leading-relaxed">{tagline}</p>
        <ul className="space-y-3.5 mb-8">
          {bullets.map((b, i) => (
            <motion.li
              key={b}
              initial={{ opacity: 0, x: -8 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{
                duration: 0.5,
                delay: i * 0.05,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="flex items-start gap-3 text-fg/80 text-[15px] leading-relaxed"
            >
              <span className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-accent" />
              <span>{b}</span>
            </motion.li>
          ))}
        </ul>
        <a
          href={cta.href}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-2 mono text-xs uppercase tracking-[0.25em] text-accent hover:text-fg transition-colors"
        >
          {cta.label}
          <span className="transition-transform group-hover:translate-x-1">
            →
          </span>
        </a>
      </div>
    </motion.div>
  );
}
