"use client";

import { motion } from "framer-motion";
import { Reveal } from "./Reveal";

const truths = [
  {
    n: "01",
    title: "Your prompts are training data.",
    body: "Every major hosted provider reserves the right — implicit or explicit — to log, retain, or train on what you send. Privacy policies change. Yours doesn't get to.",
    color: "text-holo-amber",
  },
  {
    n: "02",
    title: "Your provider is your trust boundary.",
    body: "There is no inspection layer between you and the GPU. \"Don't be evil\" is a configuration, not a guarantee. Compromise the operator, compromise everyone.",
    color: "text-holo-red",
  },
  {
    n: "03",
    title: "You can't verify what ran.",
    body: "Did your request really hit the model you paid for? The version you expected? On hardware you'd accept? Today, you take their word for it.",
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
            Centralized inference asks you to trust three things at once.
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
