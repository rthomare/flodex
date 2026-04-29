"use client";

import { motion } from "framer-motion";
import { Reveal } from "./Reveal";

const numbers = [
  {
    n: "100",
    unit: "stablecoin deposit",
    body: "Hosts put down a refundable stablecoin deposit before listing. Misbehave and they lose it. Skin in the game, not promises.",
  },
  {
    n: "1,000:1",
    unit: "requests per settlement",
    body: "You and the host sign tiny receipts off-chain as you go. One on-chain transaction settles thousands of requests. Gas stays out of your way.",
  },
  {
    n: "no custody",
    unit: "ever",
    body: "Money moves directly between your wallet and the host's. We never hold your funds — there's nothing for us to lose, freeze, or reverse.",
  },
];

export function OnChain() {
  return (
    <section className="relative py-32 md:py-48 px-6">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <div className="mono text-xs uppercase tracking-[0.3em] text-accent/80 mb-4">
            // on-chain layer
          </div>
          <div className="grid md:grid-cols-2 gap-12 items-start">
            <h2 className="text-4xl md:text-6xl font-semibold tracking-tight leading-[1.1]">
              Pay-per-use,
              <br />
              <span className="text-fg/50">without the gas tax.</span>
            </h2>
            <div className="space-y-5 text-fg/65 leading-relaxed text-[17px]">
              <p>
                Connect your wallet, deposit once into a private channel with a
                host, and pay per request from there. Each request is a tiny
                signed receipt — instant, gasless, and only between the two of
                you.
              </p>
              <p>
                Done? Close the channel and the final balance settles on-chain
                in one transaction. Hosts get paid, you get the rest back.
                No subscriptions, no middleman, nothing held.
              </p>
            </div>
          </div>
        </Reveal>

        <div className="mt-20 grid md:grid-cols-3 gap-5">
          {numbers.map((item, i) => (
            <motion.div
              key={item.unit}
              initial={{ opacity: 0, y: 32 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{
                duration: 0.7,
                delay: i * 0.12,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="glass rounded-2xl p-7 relative overflow-hidden group"
            >
              <div
                aria-hidden
                className="absolute -top-20 -right-20 w-48 h-48 rounded-full blur-3xl bg-accent/20 group-hover:bg-accent/30 transition-colors"
              />
              <div className="relative">
                <div className="text-5xl md:text-6xl font-semibold tracking-tight mb-2 bg-gradient-to-br from-accent to-holo-violet bg-clip-text text-transparent">
                  {item.n}
                </div>
                <div className="mono text-xs uppercase tracking-[0.25em] text-fg/50 mb-4">
                  {item.unit}
                </div>
                <p className="text-fg/65 leading-relaxed text-[15px]">
                  {item.body}
                </p>
              </div>
            </motion.div>
          ))}
        </div>

        <Reveal delay={0.1}>
          <div className="mt-16 glass-soft rounded-2xl p-6 md:p-7 mono text-sm overflow-x-auto">
            <div className="flex items-center gap-2 text-fg/40 mb-4 text-xs uppercase tracking-[0.25em]">
              <span className="w-2 h-2 rounded-full bg-holo-green" />
              base sepolia · live
            </div>
            <div className="grid md:grid-cols-2 gap-x-10 gap-y-2 text-[13px]">
              <Row
                label="NodeRegistry"
                value="0xf52b8f75…7A51C"
                href="https://sepolia.basescan.org/address/0xf52b8f75eed06E61801D5251022FD052aa97A51C"
              />
              <Row
                label="Stake token"
                value="USDC (Circle)"
                href="https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e"
              />
              <Row label="Min stake" value="100 USDC" />
              <Row label="Channel close" value="1h challenge / 24h reclaim" />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-accent/10 last:border-b-0 md:border-b">
      <span className="text-fg/45 uppercase tracking-[0.2em] text-[11px]">
        {label}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline truncate"
        >
          {value} ↗
        </a>
      ) : (
        <span className="text-fg/85 truncate">{value}</span>
      )}
    </div>
  );
}
