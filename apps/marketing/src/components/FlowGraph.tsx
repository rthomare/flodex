"use client";

import { motion } from "framer-motion";
import { Reveal } from "./Reveal";

// Total cycle length, in seconds — covers the agent round trip.
const T = 15;

// One machine per completed loop. With 4 machines, full rotation = 4*T.
const N_MACHINES = 4;
const SCYC = T * N_MACHINES;

// Phase markers in [0,1] of the cycle.
const M = {
  termOpen: 0.005,
  bootIn: 0.02,
  promptShow: 0.03,
  promptIn: 0.05,
  promptHeld: 0.16,
  sendStart: 0.18,
  sendEnd: 0.30,
  thinkStart: 0.30,
  thinkEnd: 0.36,
  toolReqStart: 0.36,
  toolReqEnd: 0.44,
  toolResStart: 0.46,
  toolResEnd: 0.54,
  responseStart: 0.58,
  responseEnd: 0.68,
  settleStart: 0.74,
  settleEnd: 0.88,
  confirmStart: 0.88,
  confirmEnd: 0.96,
};

// SVG canvas (matches container aspect ratio).
const VB = { w: 1100, h: 540 };

// Station anchor points (SVG units).
// Terminal HTML panel occupies SVG x ∈ [200, 400]; chain ∈ [820, 1000].
// Wires are drawn in the gaps so they're not overlapped by panel backgrounds.
const A = {
  pcCenter: { x: 130, y: 270 },
  termCenter: { x: 300, y: 270 },
  termLeft: { x: 200, y: 270 },
  termRight: { x: 410, y: 270 },
  serverLeft: { x: 540, y: 270 },
  serverCenter: { x: 620, y: 270 },
  serverRight: { x: 700, y: 270 },
  chainLeft: { x: 820, y: 270 },
  chainCenter: { x: 910, y: 270 },
};

// Panel widths in SVG units (used to size the HTML overlays responsively).
const TERM_WIDTH = 200;
const CHAIN_WIDTH = 180;

const px = (v: number) => `${(v / VB.w) * 100}%`;
const py = (v: number) => `${(v / VB.h) * 100}%`;

export function FlowGraph() {
  return (
    <section
      id="flow"
      className="relative py-32 md:py-40 px-6 overflow-hidden"
    >
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent"
      />
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <div className="mono text-xs uppercase tracking-[0.3em] text-accent/80 mb-4">
            // anatomy of a request
          </div>
          <h2 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-3xl leading-[1.1]">
            One press of send.
            <br />
            <span className="text-fg/50">Encrypted, run, settled.</span>
          </h2>
          <p className="mt-6 text-lg text-fg/65 max-w-2xl leading-relaxed">
            Watch a single round trip — your agent calls a tool, the host
            answers, and the bill settles to chain when it&apos;s done.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-14 glass rounded-3xl p-5 md:p-10 overflow-hidden">
            <Diagram />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Diagram                                                             */
/* ------------------------------------------------------------------ */

function Diagram() {
  return (
    <div
      className="relative w-full"
      style={{ aspectRatio: `${VB.w} / ${VB.h}`, minHeight: 380 }}
    >
      <div
        aria-hidden
        className="absolute inset-0 hex-grid opacity-[0.18] rounded-2xl pointer-events-none"
      />

      <svg
        className="absolute inset-0 w-full h-full"
        viewBox={`0 0 ${VB.w} ${VB.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <Defs />

        <FlowingWire
          d={`M ${A.termRight.x} ${A.termRight.y} L ${A.serverLeft.x} ${A.serverLeft.y}`}
          stroke="url(#wireCompute)"
          width={11}
          dash="24 18"
          speed={1.2}
        />
        <FlowingWire
          d={`M ${A.serverRight.x} ${A.serverRight.y} L ${A.chainLeft.x} ${A.chainLeft.y}`}
          stroke="url(#wireSettle)"
          width={11}
          dash="24 18"
          speed={1.4}
        />

        <PCIllustration cx={A.pcCenter.x} cy={A.pcCenter.y} />
        <ServerStation cx={A.serverCenter.x} cy={A.serverCenter.y} />

        <TravelingDot
          fromX={A.termRight.x}
          toX={A.serverLeft.x}
          y={A.serverLeft.y}
          startT={M.sendStart}
          endT={M.sendEnd}
          color="#66ccff"
          label="encrypted prompt"
        />
        <TravelingDot
          fromX={A.serverLeft.x}
          toX={A.termRight.x}
          y={A.serverLeft.y}
          startT={M.toolReqStart}
          endT={M.toolReqEnd}
          color="#ffbb44"
          label="tool: read_file"
          labelBelow
        />
        <TravelingDot
          fromX={A.termRight.x}
          toX={A.serverLeft.x}
          y={A.serverLeft.y}
          startT={M.toolResStart}
          endT={M.toolResEnd}
          color="#66ffaa"
          label="tool result"
        />
        <TravelingDot
          fromX={A.serverLeft.x}
          toX={A.termRight.x}
          y={A.serverLeft.y}
          startT={M.responseStart}
          endT={M.responseEnd}
          color="#b48cff"
          label="answer"
          labelBelow
        />
        <TravelingDot
          fromX={A.serverRight.x}
          toX={A.chainLeft.x}
          y={A.serverLeft.y}
          startT={M.settleStart}
          endT={M.settleEnd}
          color="#66ffaa"
          label="signed receipt"
        />
      </svg>

      <TerminalPanel />
      <ChainPanel />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SVG defs                                                            */
/* ------------------------------------------------------------------ */

function Defs() {
  return (
    <defs>
      <linearGradient id="beige" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#e8d8b2" />
        <stop offset="100%" stopColor="#c8b88a" />
      </linearGradient>
      <linearGradient id="beigeDark" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#a89870" />
        <stop offset="100%" stopColor="#806c40" />
      </linearGradient>
      <linearGradient id="beigeTop" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#f4e6c0" />
        <stop offset="100%" stopColor="#dccca0" />
      </linearGradient>
      <linearGradient id="crtScreen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#0a1a0e" />
        <stop offset="100%" stopColor="#04100a" />
      </linearGradient>

      <linearGradient id="serverBody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#2a2f38" />
        <stop offset="100%" stopColor="#16191f" />
      </linearGradient>
      <linearGradient id="serverSide" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#1a1d24" />
        <stop offset="100%" stopColor="#0a0c10" />
      </linearGradient>
      <linearGradient id="serverTop" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#3a4048" />
        <stop offset="100%" stopColor="#2a2f38" />
      </linearGradient>

      <linearGradient id="towerBody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#22262e" />
        <stop offset="100%" stopColor="#0e1014" />
      </linearGradient>
      <linearGradient id="towerSide" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#16181d" />
        <stop offset="100%" stopColor="#06080b" />
      </linearGradient>

      <linearGradient id="gpuBody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#1a1c24" />
        <stop offset="100%" stopColor="#080a10" />
      </linearGradient>
      <linearGradient id="gpuGlass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#1a4060" stopOpacity="0.25" />
        <stop offset="100%" stopColor="#3a1a60" stopOpacity="0.35" />
      </linearGradient>

      <linearGradient id="aluTop" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#e8eaee" />
        <stop offset="100%" stopColor="#bcc0c8" />
      </linearGradient>
      <linearGradient id="aluFront" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#c0c4cc" />
        <stop offset="100%" stopColor="#84878d" />
      </linearGradient>
      <linearGradient id="aluSide" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#a4a8b0" />
        <stop offset="100%" stopColor="#5a5d62" />
      </linearGradient>

      {/* Wire gradients use userSpaceOnUse so strokes on horizontal lines
          (zero-height bbox) render correctly across browsers. */}
      <linearGradient
        id="wireCompute"
        gradientUnits="userSpaceOnUse"
        x1={A.termRight.x}
        y1={A.termRight.y}
        x2={A.serverLeft.x}
        y2={A.serverLeft.y}
      >
        <stop offset="0%" stopColor="#66ccff" />
        <stop offset="100%" stopColor="#b48cff" />
      </linearGradient>
      <linearGradient
        id="wireSettle"
        gradientUnits="userSpaceOnUse"
        x1={A.serverRight.x}
        y1={A.serverRight.y}
        x2={A.chainLeft.x}
        y2={A.chainLeft.y}
      >
        <stop offset="0%" stopColor="#b48cff" />
        <stop offset="100%" stopColor="#66ffaa" />
      </linearGradient>

      <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

/* ------------------------------------------------------------------ */
/* Flowing wire                                                        */
/* ------------------------------------------------------------------ */

function FlowingWire({
  d,
  stroke,
  width = 9,
  dash = "22 18",
  speed = 1.2,
  reverse = false,
}: {
  d: string;
  stroke: string;
  width?: number;
  dash?: string;
  speed?: number;
  reverse?: boolean;
}) {
  const [a, b] = dash.split(" ").map(Number);
  const period = a + b;
  const sign = reverse ? 1 : -1;
  return (
    <>
      <path
        d={d}
        stroke={stroke}
        strokeWidth={width + 8}
        strokeLinecap="round"
        fill="none"
        opacity="0.18"
        style={{ filter: "blur(5px)" }}
      />
      <motion.path
        d={d}
        stroke={stroke}
        strokeWidth={width}
        strokeDasharray={dash}
        strokeLinecap="round"
        fill="none"
        initial={{ strokeDashoffset: 0 }}
        animate={{ strokeDashoffset: sign * period }}
        transition={{ duration: speed, repeat: Infinity, ease: "linear" }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Traveling dot with label above (or below)                           */
/* ------------------------------------------------------------------ */

function TravelingDot({
  fromX,
  toX,
  y,
  startT,
  endT,
  color,
  label,
  labelBelow = false,
}: {
  fromX: number;
  toX: number;
  y: number;
  startT: number;
  endT: number;
  color: string;
  label: string;
  labelBelow?: boolean;
}) {
  const eps = 0.003;
  const sIn = Math.max(0, startT - eps);
  const sOut = Math.min(1, endT + eps);
  const xs = [fromX, fromX, fromX, toX, toX, toX];
  const opacities = [0, 0, 1, 1, 0, 0];
  const times = [0, sIn, startT, endT, sOut, 1];

  const labelOffset = labelBelow ? 44 : -44;
  const tickFromY = labelBelow ? 7 : -7;
  const tickToY = labelBelow ? 32 : -32;

  // Approximate label pill width from text length.
  const labelW = 24 + label.length * 6.4;
  const labelH = 22;
  const labelY = y + labelOffset;

  return (
    <motion.g
      initial={{ x: fromX, opacity: 0 }}
      animate={{ x: xs, opacity: opacities }}
      transition={{
        duration: T,
        times,
        repeat: Infinity,
        ease: "linear",
      }}
    >
      {/* Soft glow halo around dot */}
      <circle
        cx={0}
        cy={y}
        r="14"
        fill={color}
        opacity="0.35"
        style={{ filter: "blur(7px)" }}
      />
      {/* Inner halo */}
      <circle cx={0} cy={y} r="9" fill={color} opacity="0.25" />
      {/* The dot itself */}
      <circle cx={0} cy={y} r="6" fill={color} />
      <circle cx={0} cy={y} r="6" fill="none" stroke="#fff" strokeOpacity="0.6" strokeWidth="1" />

      {/* Connecting tick from dot up (or down) to label */}
      <line
        x1="0"
        y1={y + tickFromY}
        x2="0"
        y2={y + tickToY}
        stroke={color}
        strokeWidth="1"
        strokeOpacity="0.8"
        strokeDasharray="2 2"
      />

      {/* Label pill */}
      <rect
        x={-labelW / 2}
        y={labelY - labelH / 2}
        width={labelW}
        height={labelH}
        rx={labelH / 2}
        fill="#05050f"
        stroke={color}
        strokeWidth="1"
        opacity="0.95"
      />
      <text
        x={0}
        y={labelY + 4}
        textAnchor="middle"
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="11"
        fill={color}
        letterSpacing="0.6"
        fontWeight="500"
        style={{ textTransform: "uppercase" }}
      >
        {label}
      </text>
    </motion.g>
  );
}

/* ------------------------------------------------------------------ */
/* 90s PC illustration                                                 */
/* ------------------------------------------------------------------ */

function PCIllustration({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g transform={`translate(${cx - 100}, ${cy - 110})`}>
      <ellipse cx="100" cy="218" rx="80" ry="6" fill="#000" opacity="0.35" />

      <g>
        <polygon points="14,160 24,154 178,154 168,160" fill="#dccca0" />
        <rect x="14" y="160" width="154" height="18" rx="1" fill="url(#beige)" />
        <rect x="14" y="176" width="154" height="3" fill="url(#beigeDark)" opacity="0.6" />
        <g fill="#806c40" opacity="0.55">
          <rect x="22" y="164" width="138" height="1.6" />
          <rect x="22" y="168" width="138" height="1.6" />
          <rect x="22" y="172" width="138" height="1.6" />
          <rect x="60" y="176" width="62" height="1.6" />
        </g>
      </g>

      <rect x="76" y="142" width="48" height="10" fill="url(#beigeDark)" />
      <polygon points="76,142 86,138 134,138 124,142" fill="url(#beigeTop)" />
      <rect x="60" y="150" width="80" height="6" rx="1" fill="url(#beige)" />

      <polygon points="20,28 32,16 168,16 156,28" fill="url(#beigeTop)" />
      <polygon points="156,28 168,16 168,128 156,140" fill="url(#beigeDark)" />
      <rect x="20" y="28" width="136" height="112" fill="url(#beige)" />

      <rect x="28" y="36" width="120" height="84" rx="3" fill="#1a1208" />
      <rect x="30" y="38" width="116" height="80" rx="2" fill="url(#crtScreen)" />

      <ellipse cx="88" cy="78" rx="62" ry="42" fill="#66ff88" opacity="0.06" />
      <g fill="#66ff88" opacity="0.05">
        {Array.from({ length: 26 }).map((_, i) => (
          <rect key={i} x="30" y={38 + i * 3} width="116" height="0.6" />
        ))}
      </g>

      <g
        fontFamily="ui-monospace, 'SF Mono', monospace"
        fontSize="6.5"
        fill="#88ffaa"
        filter="url(#softGlow)"
      >
        <text x="36" y="48" opacity="0.95">FLDX BIOS v2.0</text>
        <text x="36" y="58" opacity="0.85">memcheck.... ok</text>
        <text x="36" y="68" opacity="0.85">net link..... up</text>
        <text x="36" y="78" opacity="0.95" fill="#aaffcc">[ READY ]</text>
        <motion.text
          x="36"
          y="92"
          opacity="0.9"
          animate={{ opacity: [0.9, 0.9, 0, 0, 0.9, 0.9] }}
          transition={{
            duration: 1.0,
            times: [0, 0.45, 0.5, 0.95, 1, 1],
            repeat: Infinity,
            ease: "linear",
          }}
        >
          _
        </motion.text>
      </g>

      <rect x="28" y="122" width="120" height="10" fill="url(#beigeDark)" />
      <text
        x="34"
        y="129"
        fontFamily="ui-monospace, monospace"
        fontSize="5.2"
        fill="#3a2e10"
        letterSpacing="1.4"
      >
        FLDX-2000
      </text>

      <circle cx="142" cy="127" r="2.2" fill="#88ff66" filter="url(#softGlow)">
        <animate attributeName="opacity" values="0.5;1;0.5" dur="2s" repeatCount="indefinite" />
      </circle>

      <g fill="#604c2c" opacity="0.55">
        {Array.from({ length: 7 }).map((_, i) => (
          <rect key={i} x={159} y={40 + i * 12} width="6" height="6" />
        ))}
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Server station — fades through 4 machine types                      */
/* ------------------------------------------------------------------ */

const MACHINES = ["rack", "tower", "gaming", "mac"] as const;
type MachineKind = (typeof MACHINES)[number];

// Each machine is fully visible during one entire agent loop.
// Cross-fades happen at the loop boundary (end of one loop / start of next).
// `fade` is the fade duration as a fraction of SCYC; SCYC = N * T, so a fade
// of `0.5/SCYC` ≈ 0.5 seconds.
const FADE = 0.5 / SCYC;

function fadeKeyframes(i: number, n: number) {
  const cs = i / n;
  const ce = (i + 1) / n;
  if (i === 0) {
    // Visible at t=0, fades out at end of its loop, fades back in at end of cycle.
    return {
      times: [0, ce - FADE, ce, 1 - FADE, 1] as number[],
      opacity: [1, 1, 0, 0, 1] as number[],
    };
  }
  if (i === n - 1) {
    // Last machine: hidden through middle, visible during its loop, fades out
    // exactly at cycle wrap (where machine 0 is fading back in).
    return {
      times: [0, cs - FADE, cs, 1 - FADE, 1] as number[],
      opacity: [0, 0, 1, 1, 0] as number[],
    };
  }
  return {
    times: [0, cs - FADE, cs, ce - FADE, ce, 1] as number[],
    opacity: [0, 0, 1, 1, 0, 0] as number[],
  };
}

function ServerStation({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      {/* Floor / pedestal shadow */}
      <ellipse cx={cx} cy={cy + 130} rx="80" ry="8" fill="#000" opacity="0.45" />

      {MACHINES.map((kind, i) => {
        const kf = fadeKeyframes(i, MACHINES.length);
        return (
          <motion.g
            key={kind}
            initial={{ opacity: i === 0 ? 1 : 0 }}
            animate={{ opacity: kf.opacity }}
            transition={{
              duration: SCYC,
              times: kf.times,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          >
            <MachineSVG kind={kind} cx={cx} cy={cy} />
          </motion.g>
        );
      })}
    </g>
  );
}

function MachineSVG({
  kind,
  cx,
  cy,
}: {
  kind: MachineKind;
  cx: number;
  cy: number;
}) {
  switch (kind) {
    case "rack":
      return <RackServerSVG cx={cx} cy={cy} />;
    case "tower":
      return <TowerServerSVG cx={cx} cy={cy} />;
    case "gaming":
      return <GamingPCSVG cx={cx} cy={cy} />;
    case "mac":
      return <MacMiniSVG cx={cx} cy={cy} />;
  }
}

/* ----- Rack server ----- */

function RackServerSVG({ cx, cy }: { cx: number; cy: number }) {
  const slots = 5;
  return (
    <g transform={`translate(${cx - 70}, ${cy - 130})`}>
      <polygon points="0,0 12,-10 140,-10 128,0" fill="url(#serverTop)" />
      <polygon points="128,0 140,-10 140,250 128,260" fill="url(#serverSide)" />
      <rect x="0" y="0" width="128" height="260" fill="url(#serverBody)" />
      <rect x="-4" y="258" width="136" height="6" rx="1" fill="#0a0c10" />
      <rect x="6" y="4" width="116" height="8" rx="1" fill="#0a0c10" />
      <text
        x="10"
        y="10.5"
        fontFamily="ui-monospace, monospace"
        fontSize="5"
        fill="#66ccff"
        letterSpacing="1"
      >
        FLDX // NODE
      </text>
      {Array.from({ length: slots }).map((_, i) => {
        const sy = 22 + i * 46;
        return <RackBlade key={i} y={sy} index={i} />;
      })}
    </g>
  );
}

function RackBlade({ y, index }: { y: number; index: number }) {
  return (
    <g transform={`translate(0, ${y})`}>
      <rect x="6" y="0" width="116" height="40" rx="1" fill="#08090d" />
      <rect
        x="6"
        y="0"
        width="116"
        height="40"
        rx="1"
        fill="none"
        stroke="#2a2e36"
        strokeWidth="0.6"
      />
      <circle
        cx="14"
        cy="9"
        r="2"
        fill={index % 2 === 0 ? "#66ffaa" : "#ffbb44"}
        className="animate-pulseSoft"
        style={{ animationDelay: `${index * 0.3}s` }}
      />
      <circle
        cx="22"
        cy="9"
        r="2"
        fill="#66ccff"
        className="animate-pulseSoft"
        style={{ animationDelay: `${index * 0.45 + 0.2}s` }}
      />
      <circle cx="30" cy="9" r="1.4" fill="#444" />
      <g fill="#000" opacity="0.55">
        {Array.from({ length: 9 }).map((_, j) => (
          <rect
            key={j}
            x={40 + j * 6}
            y={8}
            width="3.6"
            height="22"
            rx="0.3"
          />
        ))}
      </g>
      <rect x="100" y="14" width="14" height="3" rx="0.5" fill="#000" />
      <rect x="100" y="20" width="14" height="3" rx="0.5" fill="#000" />
      <circle
        cx="118"
        cy="32"
        r="1.2"
        fill="#66ffaa"
        className="animate-pulseSoft"
        style={{ animationDelay: `${index * 0.2 + 0.5}s` }}
      />
    </g>
  );
}

/* ----- Tower server ----- */

function TowerServerSVG({ cx, cy }: { cx: number; cy: number }) {
  // Slim vertical pillar.
  return (
    <g transform={`translate(${cx - 40}, ${cy - 130})`}>
      {/* Top + side faces */}
      <polygon points="0,0 10,-10 70,-10 60,0" fill="url(#serverTop)" />
      <polygon points="60,0 70,-10 70,250 60,260" fill="url(#towerSide)" />
      {/* Front */}
      <rect x="0" y="0" width="60" height="260" fill="url(#towerBody)" />
      {/* Foot */}
      <rect x="-6" y="258" width="72" height="6" rx="1" fill="#06080b" />

      {/* Power button + ring */}
      <circle cx="30" cy="20" r="7" fill="none" stroke="#3a4048" strokeWidth="1" />
      <circle
        cx="30"
        cy="20"
        r="3"
        fill="#66ffaa"
        className="animate-pulseSoft"
        filter="url(#softGlow)"
      />

      {/* Status LCD */}
      <rect x="8" y="36" width="44" height="12" rx="1" fill="#021008" />
      <text
        x="11"
        y="45"
        fontFamily="ui-monospace, monospace"
        fontSize="6"
        fill="#66ffaa"
        opacity="0.9"
      >
        ONLINE
      </text>

      {/* Drive bays — 4 stacked horizontal slits */}
      {Array.from({ length: 4 }).map((_, i) => {
        const sy = 60 + i * 18;
        return (
          <g key={i}>
            <rect
              x="8"
              y={sy}
              width="44"
              height="12"
              rx="1"
              fill="#08090d"
              stroke="#22262e"
              strokeWidth="0.5"
            />
            <circle
              cx="13"
              cy={sy + 6}
              r="1.4"
              fill={i % 2 === 0 ? "#66ccff" : "#66ffaa"}
              className="animate-pulseSoft"
              style={{ animationDelay: `${i * 0.4}s` }}
            />
            <g fill="#000" opacity="0.6">
              {Array.from({ length: 6 }).map((_, j) => (
                <rect key={j} x={20 + j * 5} y={sy + 3} width="2.4" height="6" />
              ))}
            </g>
          </g>
        );
      })}

      {/* Vent grille */}
      <g fill="#000" opacity="0.5">
        {Array.from({ length: 14 }).map((_, i) => (
          <rect key={i} x="8" y={140 + i * 8} width="44" height="2" rx="0.4" />
        ))}
      </g>

      {/* Brand strip */}
      <rect x="8" y="240" width="44" height="10" rx="1" fill="#06080b" />
      <text
        x="11"
        y="247"
        fontFamily="ui-monospace, monospace"
        fontSize="5.2"
        fill="#66ccff"
        letterSpacing="1"
        opacity="0.7"
      >
        FLDX-S1
      </text>
    </g>
  );
}

/* ----- Gaming PC ----- */

function GamingPCSVG({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g transform={`translate(${cx - 56}, ${cy - 130})`}>
      {/* Top + side */}
      <polygon points="0,0 12,-10 100,-10 88,0" fill="#1a1c24" />
      <polygon points="88,0 100,-10 100,250 88,260" fill="#0a0c12" />
      {/* Front */}
      <rect x="0" y="0" width="88" height="260" fill="url(#gpuBody)" />
      {/* Foot */}
      <rect x="-4" y="258" width="96" height="6" rx="1" fill="#04060a" />

      {/* RGB top strip */}
      <rect
        x="2"
        y="2"
        width="84"
        height="2"
        fill="#66ccff"
        filter="url(#softGlow)"
      >
        <animate
          attributeName="fill"
          values="#66ccff;#b48cff;#66ffaa;#66ccff"
          dur="6s"
          repeatCount="indefinite"
        />
      </rect>

      {/* Front 3 RGB fans (left strip) */}
      {[0, 1, 2].map((i) => {
        const fy = 30 + i * 60;
        return (
          <g key={i} transform={`translate(20, ${fy})`}>
            {/* Fan well */}
            <circle cx="0" cy="0" r="20" fill="#04060a" />
            {/* RGB ring */}
            <motion.circle
              cx="0"
              cy="0"
              r="18"
              fill="none"
              strokeWidth="2.5"
              stroke="#66ccff"
              animate={{
                stroke: ["#66ccff", "#b48cff", "#66ffaa", "#ffbb44", "#66ccff"],
              }}
              transition={{
                duration: 6,
                repeat: Infinity,
                ease: "linear",
                delay: i * 1.2,
              }}
              filter="url(#softGlow)"
              opacity="0.85"
            />
            {/* Fan blades (cross) */}
            <g stroke="#1a1c24" strokeWidth="2" fill="none" opacity="0.9">
              <motion.g
                animate={{ rotate: 360 }}
                transition={{
                  duration: 1.6,
                  repeat: Infinity,
                  ease: "linear",
                }}
                style={{ transformOrigin: "0px 0px" }}
              >
                <path d="M -14 0 L 14 0" />
                <path d="M 0 -14 L 0 14" />
                <path d="M -10 -10 L 10 10" />
                <path d="M -10 10 L 10 -10" />
              </motion.g>
            </g>
            {/* Center hub */}
            <circle cx="0" cy="0" r="4" fill="#16181d" stroke="#444" strokeWidth="0.6" />
          </g>
        );
      })}

      {/* Glass side panel cutout (right ~60% of front) */}
      <rect
        x="44"
        y="14"
        width="42"
        height="220"
        rx="2"
        fill="url(#gpuGlass)"
        stroke="#3a4048"
        strokeWidth="0.5"
      />
      {/* Internals visible through glass */}
      {/* GPU bar (lower) */}
      <rect x="46" y="160" width="38" height="40" rx="1" fill="#1a1c24" />
      <rect x="46" y="160" width="38" height="3" fill="#b48cff" filter="url(#softGlow)" opacity="0.8" />
      <text x="49" y="180" fontFamily="ui-monospace, monospace" fontSize="5" fill="#66ccff" opacity="0.7">RTX</text>
      {/* GPU fans */}
      <circle cx="60" cy="195" r="3" fill="none" stroke="#444" strokeWidth="0.6" />
      <circle cx="74" cy="195" r="3" fill="none" stroke="#444" strokeWidth="0.6" />

      {/* Motherboard hint */}
      <rect x="46" y="50" width="38" height="100" rx="1" fill="#0a1418" stroke="#1a3a4a" strokeWidth="0.4" />
      <g fill="#66ccff" opacity="0.5">
        <rect x="50" y="56" width="18" height="6" rx="0.5" />
        <rect x="50" y="66" width="14" height="4" rx="0.5" />
        <circle cx="76" cy="60" r="2" />
      </g>
      {/* RAM sticks */}
      <g fill="#1a1c24" stroke="#444" strokeWidth="0.4">
        <rect x="70" y="74" width="4" height="40" />
        <rect x="76" y="74" width="4" height="40" />
      </g>

      {/* Bottom RGB underglow */}
      <rect
        x="2"
        y="252"
        width="84"
        height="3"
        fill="#b48cff"
        filter="url(#softGlow)"
        opacity="0.7"
      />

      {/* Power button */}
      <circle cx="11" cy="14" r="3" fill="none" stroke="#444" strokeWidth="0.6" />
      <circle
        cx="11"
        cy="14"
        r="1.4"
        fill="#66ffaa"
        className="animate-pulseSoft"
        filter="url(#softGlow)"
      />
    </g>
  );
}

/* ----- Mac mini ----- */

function MacMiniSVG({ cx, cy }: { cx: number; cy: number }) {
  // Small flat aluminum box, sized to match the other machines' footprint.
  const W = 130;
  return (
    <g transform={`translate(${cx - W / 2}, ${cy - 28})`}>
      <ellipse cx={W / 2} cy="50" rx="62" ry="3" fill="#000" opacity="0.5" />

      {/* Top face */}
      <polygon
        points={`0,0 12,-8 ${W - 12},-8 ${W},0`}
        fill="url(#aluTop)"
      />
      {/* Right side */}
      <polygon
        points={`${W},0 ${W - 12},-8 ${W - 12},40 ${W},48`}
        fill="url(#aluSide)"
      />
      {/* Front */}
      <rect x="0" y="0" width={W} height="48" fill="url(#aluFront)" />
      {/* Body separator highlights */}
      <rect x="0" y="0" width={W} height="0.6" fill="#fff" opacity="0.3" />
      <rect x="0" y="47" width={W} height="0.6" fill="#000" opacity="0.4" />

      {/* Subtle round emboss on top */}
      <circle
        cx={W / 2}
        cy="-3"
        r="6"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.25"
        strokeWidth="0.6"
      />

      {/* Power LED */}
      <circle
        cx={W - 12}
        cy="42"
        r="1.4"
        fill="#88ff66"
        filter="url(#softGlow)"
      >
        <animate
          attributeName="opacity"
          values="0.5;1;0.5"
          dur="2.4s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Tiny ports on the side */}
      <g fill="#1a1d24">
        <rect x={W - 18} y="6" width="14" height="2" rx="0.4" />
        <rect x={W - 18} y="12" width="14" height="2" rx="0.4" />
        <rect x={W - 18} y="18" width="14" height="2" rx="0.4" />
      </g>

      {/* Brand stamp */}
      <text
        x={W / 2}
        y="28"
        textAnchor="middle"
        fontFamily="ui-monospace, monospace"
        fontSize="6"
        fill="#3a3d44"
        letterSpacing="1.6"
        opacity="0.6"
      >
        FLDX
      </text>
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* HTML overlays: terminal + chain                                     */
/* ------------------------------------------------------------------ */

function TerminalPanel() {
  return (
    <div
      className="absolute"
      style={{
        left: px(A.termLeft.x),
        top: py(A.termCenter.y - 90),
        width: px(TERM_WIDTH),
      }}
    >
      <div
        className="rounded-xl overflow-hidden border border-accent/25 backdrop-blur-sm"
        style={{
          background: "rgba(5,5,16,0.82)",
          boxShadow:
            "0 0 0 1px rgba(102,204,255,0.08), 0 12px 40px rgba(0,0,0,0.6)",
        }}
      >
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-fg/5 border-b border-accent/15">
          <span className="w-2 h-2 rounded-full bg-holo-red/80" />
          <span className="w-2 h-2 rounded-full bg-holo-amber/80" />
          <span className="w-2 h-2 rounded-full bg-holo-green/80" />
          <span className="ml-auto mono text-[8.5px] uppercase tracking-[0.25em] text-fg/40">
            ~ — openclaw
          </span>
        </div>
        <div className="p-3 mono text-[10.5px] leading-[1.55] text-fg/80 min-h-[150px]">
          {/* Boot lines */}
          <FadeLine at={M.termOpen}>
            <span className="text-fg/45">~ $ </span>
            <span className="text-holo-cyan">openclaw chat</span>
          </FadeLine>
          <FadeLine at={M.bootIn} className="text-fg/45">
            connecting to fldx network…
          </FadeLine>
          <FadeLine at={M.promptShow} className="text-holo-green">
            ✓ session ready · 0xc18e
          </FadeLine>

          {/* Active prompt with traveling cursor */}
          <div className="mt-1">
            <FadeInline at={M.promptShow} className="text-holo-violet">
              openclaw&gt;{" "}
            </FadeInline>
            <Typing
              text="summarize meeting_notes.md"
              startT={M.promptIn}
              endT={M.promptHeld}
              eraseAt={M.responseEnd + 0.06}
              className="text-fg/90"
            />
            <Cursor
              visibleStart={M.promptShow}
              visibleEnd={M.responseEnd + 0.06}
            />
          </div>

          {/* Response stream */}
          <FadeLine at={M.sendStart} className="text-fg/55 mt-1">
            → routing to host…
          </FadeLine>
          <FadeLine at={M.toolReqStart} className="text-fg/55">
            → tool call: read_file
          </FadeLine>
          <FadeLine at={M.responseStart} className="text-holo-green">
            ✓ done · 0.0042 USDC
          </FadeLine>
        </div>
      </div>
    </div>
  );
}

/* ----- Terminal helpers ----- */

function fadeTimes(at: number) {
  // Fade in at `at`, hold through end-of-cycle, snap-out at wrap.
  return {
    times: [0, Math.max(0, at - 0.005), at, 0.99, 1],
    opacity: [0, 0, 1, 1, 0],
  };
}

function FadeLine({
  children,
  at,
  className,
}: {
  children: React.ReactNode;
  at: number;
  className?: string;
}) {
  const k = fadeTimes(at);
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: k.opacity }}
      transition={{
        duration: T,
        times: k.times,
        repeat: Infinity,
        ease: "linear",
      }}
    >
      {children}
    </motion.div>
  );
}

function FadeInline({
  children,
  at,
  className,
}: {
  children: React.ReactNode;
  at: number;
  className?: string;
}) {
  const k = fadeTimes(at);
  return (
    <motion.span
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: k.opacity }}
      transition={{
        duration: T,
        times: k.times,
        repeat: Infinity,
        ease: "linear",
      }}
    >
      {children}
    </motion.span>
  );
}

function Typing({
  text,
  startT,
  endT,
  eraseAt,
  className,
}: {
  text: string;
  startT: number;
  endT: number;
  eraseAt: number;
  className?: string;
}) {
  // The container clips; the inner text grows in width (in `ch`).
  // Cursor sits in document flow after this span and follows its right edge.
  const len = text.length;
  return (
    <span
      className="inline-block overflow-hidden whitespace-pre align-baseline"
      style={{ verticalAlign: "baseline" }}
    >
      <motion.span
        className={`inline-block whitespace-pre ${className ?? ""}`}
        initial={{ width: "0ch" }}
        animate={{
          width: [
            "0ch",
            "0ch",
            `${len}ch`,
            `${len}ch`,
            "0ch",
            "0ch",
          ],
        }}
        transition={{
          duration: T,
          times: [
            0,
            Math.max(0, startT - 0.005),
            endT,
            Math.min(1, eraseAt),
            Math.min(1, eraseAt + 0.005),
            1,
          ],
          repeat: Infinity,
          ease: "linear",
        }}
      >
        {text}
      </motion.span>
    </span>
  );
}

function Cursor({
  visibleStart,
  visibleEnd,
}: {
  visibleStart: number;
  visibleEnd: number;
}) {
  // Block cursor that blinks at ~2Hz, but only visible during the typing window.
  return (
    <motion.span
      aria-hidden
      className="inline-block bg-holo-cyan/85 align-middle ml-px"
      style={{ width: "0.55ch", height: "1em", verticalAlign: "-2px" }}
      animate={{
        opacity: [0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      }}
      transition={{
        duration: T,
        times: [
          0,
          Math.max(0, visibleStart - 0.005),
          visibleStart,
          visibleStart + 0.06,
          visibleStart + 0.12,
          visibleStart + 0.18,
          visibleStart + 0.24,
          visibleStart + 0.30,
          visibleStart + 0.36,
          visibleStart + 0.42,
          visibleStart + 0.48,
          Math.min(1, visibleEnd),
          Math.min(1, visibleEnd + 0.005),
          1,
        ],
        repeat: Infinity,
        ease: "linear",
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Chain panel                                                         */
/* ------------------------------------------------------------------ */

function ChainPanel() {
  return (
    <div
      className="absolute"
      style={{
        left: px(A.chainLeft.x),
        top: py(A.chainCenter.y - 80),
        width: px(CHAIN_WIDTH),
      }}
    >
      <motion.div
        className="rounded-xl border border-holo-green/25 backdrop-blur-sm relative overflow-hidden"
        style={{ background: "rgba(5,5,16,0.82)" }}
        animate={{
          boxShadow: [
            "0 0 0 0 rgba(102,255,170,0)",
            "0 0 0 0 rgba(102,255,170,0)",
            "0 0 36px 6px rgba(102,255,170,0.45)",
            "0 0 0 0 rgba(102,255,170,0)",
            "0 0 0 0 rgba(102,255,170,0)",
          ],
        }}
        transition={{
          duration: T,
          times: [0, M.confirmStart - 0.01, M.confirmStart, M.confirmEnd, 1],
          repeat: Infinity,
          ease: "linear",
        }}
      >
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-fg/5 border-b border-holo-green/20">
          <span className="w-2 h-2 rounded-full bg-holo-green animate-pulseSoft" />
          <span className="mono text-[9px] uppercase tracking-[0.25em] text-fg/55">
            base sepolia
          </span>
          <span className="ml-auto mono text-[9px] uppercase tracking-[0.25em] text-fg/40">
            block
          </span>
        </div>
        <div className="p-3 mono text-[10.5px] leading-[1.55] text-fg/75 min-h-[110px] space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-fg/40">tx</span>
            <motion.span
              className="text-holo-green truncate"
              animate={{ opacity: [0.3, 0.3, 1, 1, 0.3] }}
              transition={{
                duration: T,
                times: [
                  0,
                  M.confirmStart - 0.01,
                  M.confirmStart,
                  M.confirmEnd,
                  1,
                ],
                repeat: Infinity,
                ease: "linear",
              }}
            >
              0xc18e…7b94 ✓
            </motion.span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-fg/40">paid</span>
            <span className="text-fg/85">0.0042 USDC</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-fg/40">to</span>
            <span className="text-fg/60 truncate">host</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-fg/40">channel</span>
            <span className="text-fg/60">open · 1 of ~1k</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
