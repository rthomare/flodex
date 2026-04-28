"use client";

import { motion, useScroll, useTransform } from "framer-motion";

export function Nav() {
  const { scrollY } = useScroll();
  const blur = useTransform(scrollY, [0, 120], [0, 14]);
  const bg = useTransform(
    scrollY,
    [0, 120],
    ["rgba(5,5,16,0)", "rgba(5,5,16,0.7)"],
  );
  const border = useTransform(
    scrollY,
    [0, 120],
    ["rgba(102,204,255,0)", "rgba(102,204,255,0.15)"],
  );

  return (
    <motion.nav
      style={{
        backdropFilter: blur.get() ? `blur(${blur.get()}px)` : undefined,
        background: bg,
        borderBottom: "1px solid",
        borderBottomColor: border,
      }}
      className="fixed top-0 inset-x-0 z-50 px-6 md:px-10 py-4 flex items-center justify-between"
    >
      <a href="#top" className="flex items-center gap-2 group">
        <Logo />
        <span className="mono text-fg/90 text-sm tracking-[0.2em] uppercase">
          fldx
        </span>
      </a>
      <div className="flex items-center gap-3 md:gap-5">
        <a
          href="https://github.com/rthomare/flodex"
          target="_blank"
          rel="noreferrer"
          className="hidden md:inline mono text-xs text-fg/60 hover:text-fg transition-colors"
        >
          github
        </a>
        <a
          href="https://dashboard.fldx.ai"
          target="_blank"
          rel="noreferrer"
          className="mono text-xs px-3 py-1.5 rounded-full border border-accent/30 text-accent hover:bg-accent/10 transition-colors"
        >
          launch dashboard
        </a>
      </div>
    </motion.nav>
  );
}

function Logo() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 32 32"
      className="text-accent group-hover:rotate-90 transition-transform duration-700"
    >
      <circle
        cx="16"
        cy="16"
        r="13"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        opacity="0.4"
      />
      <circle cx="16" cy="3" r="2.5" fill="currentColor" />
      <circle cx="16" cy="29" r="2.5" fill="currentColor" />
      <circle cx="3" cy="16" r="2.5" fill="currentColor" />
      <circle cx="29" cy="16" r="2.5" fill="currentColor" />
      <circle cx="16" cy="16" r="3" fill="currentColor" opacity="0.7" />
    </svg>
  );
}
