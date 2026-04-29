"use client";

import { motion } from "framer-motion";
import { Reveal } from "./Reveal";

const truths = [
  {
    n: "01",
    title: "API prices keep climbing.",
    body: "Every quarter the bill goes up — per-token rates, premium tiers, rate limits you can only escape by paying more. The agents you depend on get more expensive every time you blink.",
    color: "text-holo-amber",
  },
  {
    n: "02",
    title: "Running it yourself is a hardware tax.",
    body: "Open models are catching up, but the GPUs to run them aren't cheap, aren't quiet, and aren't sitting in most people's homes. \"Just run it locally\" is a luxury most of us can't afford.",
    color: "text-holo-red",
  },
  {
    n: "03",
    title: "Meanwhile, capable machines sit idle.",
    body: "Gaming rigs, workstations, dev boxes — millions of them are powered on, online, and doing nothing for most of the day. That's compute the world already paid for, going to waste.",
    color: "text-holo-violet",
  },
];

export function Problem() {
  return (
    <section className="relative py-32 md:py-48 px-6">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <div className="mono text-xs uppercase tracking-[0.3em] text-accent/80 mb-4">
            // the problem
          </div>
          <h2 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-3xl leading-[1.1]">
            AI is getting more expensive. The compute to run it isn&apos;t.
          </h2>
        </Reveal>

        <div className="mt-20 grid md:grid-cols-3 gap-5">
          {truths.map((t, i) => (
            <motion.div
              key={t.n}
              initial={{ opacity: 0, y: 32 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{
                duration: 0.7,
                delay: i * 0.12,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="glass rounded-2xl p-7 hover:border-accent/40 transition-colors"
            >
              <div className={`mono text-sm ${t.color} mb-6`}>{t.n}</div>
              <h3 className="text-xl font-semibold mb-3 leading-tight">
                {t.title}
              </h3>
              <p className="text-fg/65 leading-relaxed text-[15px]">{t.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
