"use client";

import { motion } from "framer-motion";
import { useMemo, useState } from "react";

// Assumptions used to model the comparison.
const TRAD_BASE = 10; // USD per 1M tokens (typical hosted frontier API, blended)
const FLDX_BASE = 1.5; // USD per 1M tokens (open models on the marketplace)
const FLDX_HIKE_PCT = 3; // %/yr — competitive marketplace pricing stays flat
const YEARS = 5;
const MONTHS = YEARS * 12;

type Series = {
  trad: number[];
  fldx: number[];
  tradTotal: number;
  fldxTotal: number;
};

function compute(tokensM: number, hikePct: number): Series {
  const trad: number[] = [0];
  const fldx: number[] = [0];
  let tradCum = 0;
  let fldxCum = 0;
  for (let m = 1; m <= MONTHS; m++) {
    const yr = (m - 1) / 12;
    const tradRate = TRAD_BASE * Math.pow(1 + hikePct / 100, yr);
    const fldxRate = FLDX_BASE * Math.pow(1 + FLDX_HIKE_PCT / 100, yr);
    tradCum += tokensM * tradRate;
    fldxCum += tokensM * fldxRate;
    trad.push(tradCum);
    fldx.push(fldxCum);
  }
  return { trad, fldx, tradTotal: tradCum, fldxTotal: fldxCum };
}

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(0);
}

export function SavingsCalculator() {
  const [tokensM, setTokensM] = useState(25);
  const [hikePct, setHikePct] = useState(15);

  const series = useMemo(() => compute(tokensM, hikePct), [tokensM, hikePct]);
  const savings = series.tradTotal - series.fldxTotal;
  const savingsPct = series.tradTotal > 0
    ? Math.round((savings / series.tradTotal) * 100)
    : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 32 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="glass rounded-3xl p-7 md:p-10 mt-8"
    >
      <div className="mb-8 md:mb-10">
        <div className="mono text-xs uppercase tracking-[0.3em] text-accent/80 mb-3">
          // savings calculator
        </div>
        <h3 className="text-3xl md:text-4xl font-semibold tracking-tight leading-[1.1]">
          See what you&apos;d save.
        </h3>
        <p className="mt-3 text-fg/65 max-w-xl text-[15px] leading-relaxed">
          Drag the sliders. As traditional API prices climb, the gap widens —
          and the marketplace stays roughly flat.
        </p>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-8 lg:gap-12 items-start">
        <div className="space-y-7">
          <Slider
            label="Tokens per month"
            value={tokensM}
            onChange={setTokensM}
            min={1}
            max={100}
            step={1}
            display={`${tokensM}M`}
            ticks={[1, 25, 50, 75, 100].map((t) => `${t}M`)}
          />
          <Slider
            label="Traditional API price hike"
            value={hikePct}
            onChange={setHikePct}
            min={0}
            max={30}
            step={1}
            display={`${hikePct}% / yr`}
            ticks={["0%", "10%", "20%", "30%"]}
          />

          <div className="pt-7 border-t border-accent/10">
            <div className="mono text-[10px] uppercase tracking-[0.3em] text-fg/45 mb-4">
              {YEARS}-year cumulative spend
            </div>
            <div className="space-y-2.5 mono text-[13px]">
              <Row
                label="Traditional API"
                value={`$${formatMoney(series.tradTotal)}`}
                color="text-holo-amber"
                dot="#ffbb44"
              />
              <Row
                label="fldx marketplace"
                value={`$${formatMoney(series.fldxTotal)}`}
                color="text-holo-green"
                dot="#66ffaa"
              />
            </div>
            <div className="mt-5 pt-5 border-t border-accent/10">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <span className="mono text-[10px] uppercase tracking-[0.3em] text-fg/55">
                  you save
                </span>
                <span className="mono text-[11px] uppercase tracking-[0.25em] text-holo-green">
                  ≈ {savingsPct}%
                </span>
              </div>
              <div className="mt-1 text-4xl md:text-5xl font-semibold tracking-tight bg-gradient-to-r from-holo-green to-accent bg-clip-text text-transparent">
                ${formatMoney(savings)}
              </div>
            </div>
          </div>

          <p className="mono text-[10px] uppercase tracking-[0.22em] text-fg/35 leading-relaxed">
            Assumes ${TRAD_BASE.toFixed(2)}/M tokens for hosted APIs · $
            {FLDX_BASE.toFixed(2)}/M on the marketplace · {FLDX_HIKE_PCT}% / yr
            marketplace drift
          </p>
        </div>

        <Graph series={series} />
      </div>

      <SliderStyles />
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Slider                                                              */
/* ------------------------------------------------------------------ */

function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  display,
  ticks,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  display: string;
  ticks: string[];
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <span className="mono text-[11px] uppercase tracking-[0.28em] text-fg/55">
          {label}
        </span>
        <span className="mono text-2xl md:text-[28px] text-accent font-medium tracking-tight">
          {display}
        </span>
      </div>
      <div
        className="relative h-2 rounded-full"
        style={{ background: "rgba(255,255,255,0.07)" }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${pct}%`,
            background:
              "linear-gradient(90deg, rgba(102,204,255,0.7), rgba(180,140,255,0.85))",
            boxShadow: "0 0 12px rgba(102,204,255,0.45)",
          }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="fldx-slider absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label={label}
        />
        <div
          aria-hidden
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full pointer-events-none"
          style={{
            left: `${pct}%`,
            background: "#66ccff",
            boxShadow:
              "0 0 0 2px rgba(5,5,16,0.9), 0 0 20px rgba(102,204,255,0.7)",
          }}
        />
      </div>
      <div className="flex items-center justify-between mt-2 mono text-[9.5px] uppercase tracking-[0.25em] text-fg/35">
        {ticks.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </div>
  );
}

function SliderStyles() {
  // Hide native thumb so our custom rendered thumb shows through.
  return (
    <style jsx global>{`
      input.fldx-slider {
        -webkit-appearance: none;
        appearance: none;
        background: transparent;
      }
      input.fldx-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 24px;
        height: 24px;
        background: transparent;
        cursor: pointer;
      }
      input.fldx-slider::-moz-range-thumb {
        width: 24px;
        height: 24px;
        background: transparent;
        border: none;
        cursor: pointer;
      }
      input.fldx-slider::-webkit-slider-runnable-track {
        background: transparent;
      }
      input.fldx-slider::-moz-range-track {
        background: transparent;
      }
      input.fldx-slider:focus {
        outline: none;
      }
      input.fldx-slider:focus-visible::-webkit-slider-thumb {
        outline: 2px solid rgba(102, 204, 255, 0.6);
        border-radius: 50%;
      }
    `}</style>
  );
}

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

function Row({
  label,
  value,
  color,
  dot,
}: {
  label: string;
  value: string;
  color: string;
  dot: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex items-center gap-2 text-fg/65">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: dot, boxShadow: `0 0 8px ${dot}aa` }}
        />
        {label}
      </span>
      <span className={`${color} font-medium tracking-tight text-base`}>
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Graph                                                               */
/* ------------------------------------------------------------------ */

const G = {
  w: 600,
  h: 360,
  padL: 56,
  padR: 16,
  padT: 24,
  padB: 36,
};

function Graph({ series }: { series: Series }) {
  const plotW = G.w - G.padL - G.padR;
  const plotH = G.h - G.padT - G.padB;

  const maxCost = series.tradTotal || 1;
  const xOf = (m: number) => G.padL + (m / MONTHS) * plotW;
  const yOf = (cost: number) =>
    G.padT + plotH - (cost / maxCost) * plotH;

  const tradPath = pathFrom(series.trad, xOf, yOf);
  const fldxPath = pathFrom(series.fldx, xOf, yOf);

  // Polygon points for the savings band (between the two lines).
  const bandPoints = [
    ...series.trad.map((c, i) => `${xOf(i)},${yOf(c)}`),
    ...series.fldx.map((c, i) => `${xOf(i)},${yOf(c)}`).reverse(),
  ].join(" ");

  // 4 horizontal grid lines + axis labels.
  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const frac = i / yTicks;
    const cost = maxCost * (1 - frac);
    return {
      y: G.padT + plotH * frac,
      label: `$${formatMoney(cost)}`,
    };
  });
  const xLabels = [0, 1, 2, 3, 4, 5].map((y) => ({
    x: xOf(y * 12),
    label: `Y${y}`,
  }));

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${G.w} ${G.h}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient
            id="savingsBand"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1={G.padT}
            x2="0"
            y2={G.padT + plotH}
          >
            <stop offset="0%" stopColor="#ffbb44" stopOpacity="0.35" />
            <stop offset="60%" stopColor="#66ffaa" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#66ffaa" stopOpacity="0.05" />
          </linearGradient>
          <linearGradient
            id="tradLine"
            gradientUnits="userSpaceOnUse"
            x1={G.padL}
            y1="0"
            x2={G.padL + plotW}
            y2="0"
          >
            <stop offset="0%" stopColor="#ffbb44" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#ff6677" />
          </linearGradient>
        </defs>

        {/* Horizontal grid */}
        <g stroke="rgba(255,255,255,0.16)" strokeWidth="0.7">
          {yLabels.map((t) => (
            <line
              key={`g-${t.y}`}
              x1={G.padL}
              y1={t.y}
              x2={G.w - G.padR}
              y2={t.y}
            />
          ))}
        </g>

        {/* Baseline axes */}
        <line
          x1={G.padL}
          y1={G.padT}
          x2={G.padL}
          y2={G.padT + plotH}
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="1"
        />
        <line
          x1={G.padL}
          y1={G.padT + plotH}
          x2={G.w - G.padR}
          y2={G.padT + plotH}
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="1"
        />

        {/* Tick marks */}
        <g stroke="rgba(255,255,255,0.55)" strokeWidth="1">
          {yLabels.map((t) => (
            <line
              key={`yt-${t.y}`}
              x1={G.padL - 4}
              y1={t.y}
              x2={G.padL}
              y2={t.y}
            />
          ))}
          {xLabels.map((t) => (
            <line
              key={`xt-${t.x}`}
              x1={t.x}
              y1={G.padT + plotH}
              x2={t.x}
              y2={G.padT + plotH + 4}
            />
          ))}
        </g>

        {/* Y labels */}
        <g
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="11"
          fill="rgba(230,236,246,0.92)"
          fontWeight="500"
        >
          {yLabels.map((t) => (
            <text
              key={`yl-${t.y}`}
              x={G.padL - 9}
              y={t.y + 3.5}
              textAnchor="end"
              letterSpacing="0.5"
            >
              {t.label}
            </text>
          ))}
        </g>

        {/* X labels */}
        <g
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="11"
          fill="rgba(230,236,246,0.92)"
          letterSpacing="1.2"
          fontWeight="500"
        >
          {xLabels.map((t) => (
            <text
              key={`xl-${t.x}`}
              x={t.x}
              y={G.h - G.padB + 20}
              textAnchor="middle"
            >
              {t.label}
            </text>
          ))}
        </g>

        {/* Savings band */}
        <polygon points={bandPoints} fill="url(#savingsBand)" />

        {/* Trad line */}
        <path
          d={tradPath}
          stroke="url(#tradLine)"
          strokeWidth="2.5"
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* fldx line */}
        <path
          d={fldxPath}
          stroke="#66ffaa"
          strokeWidth="2.5"
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* End-of-line dots + labels */}
        <EndDot
          cx={xOf(MONTHS)}
          cy={yOf(series.tradTotal)}
          color="#ffbb44"
          label={`$${formatMoney(series.tradTotal)}`}
          align="right"
        />
        <EndDot
          cx={xOf(MONTHS)}
          cy={yOf(series.fldxTotal)}
          color="#66ffaa"
          label={`$${formatMoney(series.fldxTotal)}`}
          align="right"
        />

        {/* Legend */}
        <g
          fontFamily="ui-monospace, 'SF Mono', monospace"
          fontSize="11"
          letterSpacing="1.4"
          fontWeight="500"
        >
          <g transform={`translate(${G.padL + 6}, ${G.padT + 14})`}>
            <circle cx="0" cy="-3.5" r="3.5" fill="#ffbb44" />
            <text x="10" y="0" fill="rgba(245,235,210,0.95)">
              TRADITIONAL
            </text>
          </g>
          <g transform={`translate(${G.padL + 6}, ${G.padT + 32})`}>
            <circle cx="0" cy="-3.5" r="3.5" fill="#66ffaa" />
            <text x="10" y="0" fill="rgba(220,255,235,0.95)">
              FLDX
            </text>
          </g>
        </g>
      </svg>
    </div>
  );
}

function pathFrom(
  values: number[],
  xOf: (m: number) => number,
  yOf: (cost: number) => number,
): string {
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${xOf(i)} ${yOf(v)}`)
    .join(" ");
}

function EndDot({
  cx,
  cy,
  color,
  label,
  align,
}: {
  cx: number;
  cy: number;
  color: string;
  label: string;
  align: "left" | "right";
}) {
  const dx = align === "right" ? -8 : 8;
  const anchor = align === "right" ? "end" : "start";
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r="8"
        fill={color}
        opacity="0.18"
        style={{ filter: "blur(3px)" }}
      />
      <circle cx={cx} cy={cy} r="3.5" fill={color} />
      <circle
        cx={cx}
        cy={cy}
        r="3.5"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.7"
        strokeWidth="0.8"
      />
      <text
        x={cx + dx}
        y={cy - 10}
        textAnchor={anchor}
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="12"
        fill={color}
        fontWeight="500"
      >
        {label}
      </text>
    </g>
  );
}
