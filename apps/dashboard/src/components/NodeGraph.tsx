"use client";
import { useEffect, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { BackendType, NodeRegistration } from "@flodex/protocol";
import type { SessionRecord } from "@/lib/events";

/**
 * A ball that should be drawn on an edge. `kind` selects the direction:
 *   - "request"   : client → node (the user's prompt / tool result)
 *   - "tool-call" : node → client (the node asking for a client-side tool)
 * The `label` is a short string rendered in screen-coords next to the dot.
 */
export type ActiveRequestKind = "request" | "tool-call";
export interface ActiveRequest {
  nodeUrl: string;
  sessionId: string;
  backend: BackendType;
  startedAt: number;
  endedAt: number | null;
  status: SessionRecord["status"];
  lastToolName?: string;
  source: SessionRecord["source"];
  kind: ActiveRequestKind;
  label: string;
}

interface GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: "client" | "worker";
  reg?: NodeRegistration;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  active: boolean;
}

const CLIENT_ID = "__client";
const PROGRESS_TAU_MS = 5000;
const COMPLETION_FADE_MS = 1500;

const MIN_SCALE = 0.3;
const MAX_SCALE = 4;
const WHEEL_ZOOM_FACTOR = 1.003;
const DRAG_CLICK_THRESHOLD_PX = 4;
const ZOOM_INDICATOR_HOLD_MS = 600;
const ZOOM_INDICATOR_FADE_MS = 400;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function requestProgress(req: ActiveRequest, now: number): { p: number; alpha: number } {
  const elapsed = Math.max(0, now - req.startedAt);
  const base = 1 - Math.exp(-elapsed / PROGRESS_TAU_MS);
  if (req.endedAt === null) {
    return { p: base, alpha: 1 };
  }
  const sinceEnd = now - req.endedAt;
  const snap = Math.min(1, sinceEnd / 500);
  const p = base + (1 - base) * snap;
  const fadeStart = 500;
  const fade =
    sinceEnd <= fadeStart
      ? 1
      : Math.max(0, 1 - (sinceEnd - fadeStart) / (COMPLETION_FADE_MS - fadeStart));
  return { p, alpha: fade };
}

function statusLabel(status: ActiveRequest["status"]): string {
  switch (status) {
    case "waiting-tool":
      return "waiting on tool";
    case "running":
      return "running";
    case "final":
      return "done";
    case "error":
      return "error";
    case "matching":
      return "matching";
    case "pending":
      return "pending";
    default:
      return status;
  }
}

function humanElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

type Theme = "dark" | "light";

interface CanvasTheme {
  edgeRgb: string; // "r, g, b" — alpha appended at use site
  edgeIdleAlpha: number;
  edgeActiveAlpha: number;
  nodeFillWorker: string;
  nodeFillClient: string;
  nodeFillActive: string;
  nodeStrokeWorker: string;
  nodeStrokeClient: string;
  nodeStrokeActive: string;
  nodeStrokeSelected: string;
  nodeText: string;
  nodeSubText: string;
  glowClientRgb: string;
  glowActiveRgb: string;
  glowWorkerRgb: string;
  panelBg: string;
  panelBorder: string;
  panelText: string;
  indicatorPanel: string;
  indicatorBorder: string;
  /** Color for tool-call balls (node → client direction). */
  toolCallColor: string;
  toolCallGlowRgb: string;
  /** Translucent pill behind each floating ball label. */
  labelBg: string;
  labelBorder: string;
}

const CANVAS_THEMES: Record<Theme, CanvasTheme> = {
  dark: {
    edgeRgb: "102, 204, 255",
    edgeIdleAlpha: 0.12,
    edgeActiveAlpha: 0.7,
    nodeFillWorker: "#0b1428",
    nodeFillClient: "#1a1030",
    nodeFillActive: "#0f2a22",
    nodeStrokeWorker: "#66ccff",
    nodeStrokeClient: "#b48cff",
    nodeStrokeActive: "#66ffaa",
    nodeStrokeSelected: "#ffbb44",
    nodeText: "#e7ecf3",
    nodeSubText: "rgba(231, 236, 243, 0.45)",
    glowClientRgb: "180, 140, 255",
    glowActiveRgb: "102, 255, 170",
    glowWorkerRgb: "102, 204, 255",
    panelBg: "rgba(5, 10, 24, 0.92)",
    panelBorder: "rgba(102, 204, 255, 0.45)",
    panelText: "#e7ecf3",
    indicatorPanel: "rgba(5, 10, 24, 0.85)",
    indicatorBorder: "rgba(102, 204, 255, 0.5)",
    toolCallColor: "#b48cff",
    toolCallGlowRgb: "180, 140, 255",
    labelBg: "rgba(5, 10, 24, 0.78)",
    labelBorder: "rgba(102, 204, 255, 0.28)",
  },
  light: {
    edgeRgb: "20, 80, 140",
    edgeIdleAlpha: 0.18,
    edgeActiveAlpha: 0.75,
    nodeFillWorker: "#eaf2fb",
    nodeFillClient: "#f3edfb",
    nodeFillActive: "#e3f3eb",
    nodeStrokeWorker: "#1a73e8",
    nodeStrokeClient: "#7c4dff",
    nodeStrokeActive: "#10a37f",
    nodeStrokeSelected: "#d97706",
    nodeText: "#0a1224",
    nodeSubText: "rgba(10, 18, 36, 0.5)",
    glowClientRgb: "124, 77, 255",
    glowActiveRgb: "16, 163, 127",
    glowWorkerRgb: "26, 115, 232",
    panelBg: "rgba(255, 255, 255, 0.95)",
    panelBorder: "rgba(20, 80, 140, 0.45)",
    panelText: "#0a1224",
    indicatorPanel: "rgba(255, 255, 255, 0.92)",
    indicatorBorder: "rgba(20, 80, 140, 0.5)",
    toolCallColor: "#7c4dff",
    toolCallGlowRgb: "124, 77, 255",
    labelBg: "rgba(255, 255, 255, 0.92)",
    labelBorder: "rgba(20, 80, 140, 0.3)",
  },
};

interface View {
  scale: number;
  tx: number;
  ty: number;
}

type DragState =
  | { type: "node"; node: GraphNode; movedPx: number }
  | {
      type: "pan";
      startClientX: number;
      startClientY: number;
      startTx: number;
      startTy: number;
      movedPx: number;
    }
  | null;

export default function NodeGraph({
  nodes,
  activeRequests,
  selectedPubKey,
  onSelect,
  theme,
}: {
  nodes: NodeRegistration[];
  activeRequests: ActiveRequest[];
  selectedPubKey: string | null;
  onSelect: (pubkey: string | null) => void;
  theme: Theme;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const resetRef = useRef<() => void>(() => {});
  // True while the canvas zoom indicator is on screen — drives the reset
  // button's mutually-exclusive fade. Cleared on a timer matching the
  // indicator's hold + fade duration.
  const [zoomActive, setZoomActive] = useState(false);
  const zoomHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stateRef = useRef<{
    graphNodes: GraphNode[];
    links: GraphLink[];
    activeRequests: ActiveRequest[];
    selectedPubKey: string | null;
    theme: Theme;
    width: number;
    height: number;
    view: View;
    drag: DragState;
    /** Ball hit-test rects in world coords; alpha tracks the in-flight fade. */
    ballRects: Array<{
      x: number;
      y: number;
      r: number;
      req: ActiveRequest;
      alpha: number;
    }>;
    hoveredBall: { req: ActiveRequest; x: number; y: number } | null;
    /** Wall-clock of the last scale change; drives the zoom indicator fade. */
    lastZoomAt: number;
  }>({
    graphNodes: [],
    links: [],
    activeRequests,
    selectedPubKey,
    theme,
    width: 0,
    height: 0,
    view: { scale: 1, tx: 0, ty: 0 },
    drag: null,
    ballRects: [],
    hoveredBall: null,
    lastZoomAt: 0,
  });

  // Reconcile graph when the node list changes; preserve x/y across polls.
  useEffect(() => {
    const prevById = new Map<string, GraphNode>();
    for (const n of stateRef.current.graphNodes) prevById.set(n.id, n);

    const client: GraphNode =
      prevById.get(CLIENT_ID) ?? {
        id: CLIENT_ID,
        label: "client",
        kind: "client",
        fx: 0,
        fy: 0,
      };

    const workers: GraphNode[] = nodes.map((n) => {
      const existing = prevById.get(n.publicKey);
      if (existing) {
        existing.reg = n;
        existing.label = n.backends.join(",");
        return existing;
      }
      return {
        id: n.publicKey,
        label: n.backends.join(","),
        kind: "worker",
        reg: n,
      };
    });

    const graphNodes: GraphNode[] = [client, ...workers];
    const links: GraphLink[] = workers.map((w) => ({
      source: CLIENT_ID,
      target: w.id,
      active: false,
    }));

    const topologyChanged =
      graphNodes.length !== stateRef.current.graphNodes.length ||
      graphNodes.some((n) => !prevById.has(n.id));

    stateRef.current.graphNodes = graphNodes;
    stateRef.current.links = links;

    if (!simRef.current) {
      const sim = forceSimulation(graphNodes)
        .force(
          "link",
          forceLink<GraphNode, GraphLink>(links)
            .id((d) => d.id)
            .distance(180)
            .strength(0.25),
        )
        .force("charge", forceManyBody<GraphNode>().strength(-400))
        .force("collide", forceCollide<GraphNode>().radius(44))
        .force("center", forceCenter(0, 0).strength(0.05))
        .alpha(1)
        .alphaDecay(0.02);
      simRef.current = sim;
      return;
    }

    simRef.current.nodes(graphNodes);
    const linkForce = simRef.current.force("link") as
      | ReturnType<typeof forceLink<GraphNode, GraphLink>>
      | null;
    linkForce?.links(links);
    if (topologyChanged) {
      simRef.current.alpha(0.3).restart();
    }
  }, [nodes]);

  useEffect(() => {
    stateRef.current.activeRequests = activeRequests;
  }, [activeRequests]);
  useEffect(() => {
    stateRef.current.selectedPubKey = selectedPubKey;
  }, [selectedPubKey]);
  useEffect(() => {
    stateRef.current.theme = theme;
  }, [theme]);

  // Canvas setup + draw loop + interaction
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;

    function resize() {
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      stateRef.current.width = w;
      stateRef.current.height = h;
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    /** Convert canvas-local coords (0..w, 0..h) to world coords. */
    function canvasToWorld(mx: number, my: number) {
      const s = stateRef.current;
      return {
        x: (mx - s.width / 2 - s.view.tx) / s.view.scale,
        y: (my - s.height / 2 - s.view.ty) / s.view.scale,
      };
    }

    /** Get mouse pos relative to canvas. */
    function localPos(ev: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function nodeAtWorld(wx: number, wy: number): GraphNode | null {
      const s = stateRef.current;
      // Iterate top-down so the most recently drawn (visually on top) wins.
      for (let i = s.graphNodes.length - 1; i >= 0; i--) {
        const n = s.graphNodes[i];
        if (n.x == null || n.y == null) continue;
        const r = n.kind === "client" ? 22 : 28;
        const dx = n.x - wx;
        const dy = n.y - wy;
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    }

    function ballAtWorld(wx: number, wy: number) {
      const s = stateRef.current;
      // Hit radius is in world coords; scale grows it with zoom-in (good UX).
      for (const b of s.ballRects) {
        const dx = b.x - wx;
        const dy = b.y - wy;
        if (dx * dx + dy * dy <= (b.r + 2) * (b.r + 2)) return b;
      }
      return null;
    }

    function setCursorForHover() {
      const s = stateRef.current;
      if (s.drag?.type === "pan") canvas!.style.cursor = "grabbing";
      else if (s.drag?.type === "node") canvas!.style.cursor = "grabbing";
      else if (s.hoveredBall) canvas!.style.cursor = "pointer";
      else canvas!.style.cursor = "default";
    }

    function draw() {
      const s = stateRef.current;
      const { width, height, view } = s;
      const t = CANVAS_THEMES[s.theme];
      const drawNow = Date.now();
      ctx!.clearRect(0, 0, width, height);

      // World transform: center on canvas, then pan, then zoom.
      ctx!.save();
      ctx!.translate(width / 2 + view.tx, height / 2 + view.ty);
      ctx!.scale(view.scale, view.scale);

      const activeUrlSet = new Set<string>(s.activeRequests.map((r) => r.nodeUrl));
      const nodeByUrl = new Map<string, GraphNode>();
      for (const n of s.graphNodes) {
        if (n.kind === "worker" && n.reg) nodeByUrl.set(n.reg.url, n);
      }
      const clientNode = s.graphNodes.find((n) => n.kind === "client");

      // Edges
      for (const link of s.links) {
        const src = link.source as GraphNode;
        const tgt = link.target as GraphNode;
        if (src.x == null || src.y == null || tgt.x == null || tgt.y == null)
          continue;
        const active = tgt.reg ? activeUrlSet.has(tgt.reg.url) : false;
        ctx!.beginPath();
        ctx!.moveTo(src.x, src.y);
        ctx!.lineTo(tgt.x, tgt.y);
        ctx!.strokeStyle = active
          ? `rgba(${t.edgeRgb}, ${t.edgeActiveAlpha})`
          : `rgba(${t.edgeRgb}, ${t.edgeIdleAlpha})`;
        ctx!.lineWidth = (active ? 1.6 : 1) / view.scale;
        ctx!.stroke();
      }

      // Balls — one per active request, position = progress easing.
      // Direction is selected by `kind`: a "request" travels client → node,
      // a "tool-call" travels node → client.
      s.ballRects = [];
      if (clientNode && clientNode.x != null && clientNode.y != null) {
        for (const req of s.activeRequests) {
          const tgt = nodeByUrl.get(req.nodeUrl);
          if (!tgt || tgt.x == null || tgt.y == null) continue;
          const { p, alpha } = requestProgress(req, drawNow);
          if (alpha <= 0) continue;

          const fromX = req.kind === "request" ? clientNode.x : tgt.x;
          const fromY = req.kind === "request" ? clientNode.y : tgt.y;
          const toX = req.kind === "request" ? tgt.x : clientNode.x;
          const toY = req.kind === "request" ? tgt.y : clientNode.y;
          const px = fromX + (toX - fromX) * p;
          const py = fromY + (toY - fromY) * p;

          const color =
            req.kind === "tool-call"
              ? t.toolCallColor
              : req.status === "error"
              ? "#ff5566"
              : req.status === "waiting-tool"
              ? "#ffbb44"
              : req.status === "final"
              ? "#66ffaa"
              : "#66ccff";

          ctx!.globalAlpha = alpha * 0.5;
          const glow = ctx!.createRadialGradient(px, py, 0, px, py, 16);
          glow.addColorStop(0, color);
          glow.addColorStop(1, "rgba(0,0,0,0)");
          ctx!.fillStyle = glow;
          ctx!.beginPath();
          ctx!.arc(px, py, 16, 0, Math.PI * 2);
          ctx!.fill();

          ctx!.globalAlpha = alpha;
          ctx!.beginPath();
          ctx!.arc(px, py, 5, 0, Math.PI * 2);
          ctx!.fillStyle = color;
          ctx!.fill();
          ctx!.globalAlpha = 1;

          s.ballRects.push({ x: px, y: py, r: 10, req, alpha });
        }
      }

      // Nodes
      for (const n of s.graphNodes) {
        if (n.x == null || n.y == null) continue;
        const isClient = n.kind === "client";
        const isActive = n.reg ? activeUrlSet.has(n.reg.url) : false;
        const isSelected =
          s.selectedPubKey !== null && n.id === s.selectedPubKey;
        const radius = isClient ? 22 : 28;

        const glowAlpha = isActive ? 0.6 : isSelected ? 0.45 : 0.22;
        const glow = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, radius * 2.4);
        const glowRgb = isClient
          ? t.glowClientRgb
          : isActive
          ? t.glowActiveRgb
          : t.glowWorkerRgb;
        glow.addColorStop(0, `rgba(${glowRgb}, ${glowAlpha})`);
        glow.addColorStop(1, `rgba(${glowRgb}, 0)`);
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, radius * 2.4, 0, Math.PI * 2);
        ctx!.fill();

        ctx!.beginPath();
        ctx!.arc(n.x, n.y, radius, 0, Math.PI * 2);
        ctx!.fillStyle = isClient
          ? t.nodeFillClient
          : isActive
          ? t.nodeFillActive
          : t.nodeFillWorker;
        ctx!.fill();
        ctx!.strokeStyle = isClient
          ? t.nodeStrokeClient
          : isActive
          ? t.nodeStrokeActive
          : isSelected
          ? t.nodeStrokeSelected
          : t.nodeStrokeWorker;
        ctx!.lineWidth = (isSelected ? 2.5 : 1.5) / view.scale;
        ctx!.stroke();

        ctx!.fillStyle = t.nodeText;
        ctx!.font = "11px SF Mono, Geist Mono, ui-monospace, monospace";
        ctx!.textAlign = "center";
        ctx!.fillText(n.label, n.x, n.y + radius + 16);

        if (n.reg) {
          ctx!.fillStyle = t.nodeSubText;
          ctx!.font = "9px SF Mono, Geist Mono, ui-monospace, monospace";
          ctx!.fillText(`${n.reg.publicKey.slice(0, 8)}…`, n.x, n.y + radius + 30);
        }
      }

      ctx!.restore();

      // Floating ball labels — drawn in screen coords so they stay at a
      // constant size regardless of zoom. Skip the ball that's currently
      // hovered (the tooltip below covers it with more detail).
      const hoveredBall = s.hoveredBall;
      ctx!.font = "10px SF Mono, Geist Mono, ui-monospace, monospace";
      for (const ball of s.ballRects) {
        if (
          hoveredBall &&
          hoveredBall.req.sessionId === ball.req.sessionId &&
          hoveredBall.req.kind === ball.req.kind
        ) {
          continue;
        }
        const sx = width / 2 + view.tx + ball.x * view.scale;
        const sy = height / 2 + view.ty + ball.y * view.scale;
        const text = ball.req.label;
        const padX = 5;
        const labelH = 16;
        const tw = ctx!.measureText(text).width;
        const labelW = tw + padX * 2;
        const offsetX = 10;
        let lx = sx + offsetX;
        let ly = sy - labelH / 2;
        // Flip to the left side of the dot if the label would clip the canvas.
        if (lx + labelW > width - 4) lx = sx - offsetX - labelW;
        if (ly < 4) ly = 4;
        if (ly + labelH > height - 4) ly = height - 4 - labelH;

        ctx!.globalAlpha = ball.alpha;
        ctx!.fillStyle = t.labelBg;
        ctx!.strokeStyle = t.labelBorder;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.rect(lx, ly, labelW, labelH);
        ctx!.fill();
        ctx!.stroke();

        ctx!.fillStyle = t.panelText;
        ctx!.textAlign = "left";
        ctx!.textBaseline = "middle";
        ctx!.fillText(text, lx + padX, ly + labelH / 2);
        ctx!.globalAlpha = 1;
      }
      ctx!.textBaseline = "alphabetic";

      // Hover tooltip — drawn in screen coords so it stays at constant size.
      if (s.hoveredBall) {
        const { req, x: wx, y: wy } = s.hoveredBall;
        const sx = width / 2 + view.tx + wx * view.scale;
        const sy = height / 2 + view.ty + wy * view.scale;
        const elapsed = (req.endedAt ?? drawNow) - req.startedAt;
        const lines = [
          `${req.sessionId.slice(0, 8)}…`,
          `${req.source} · ${req.backend}`,
          `${statusLabel(req.status)} · ${humanElapsed(elapsed)}`,
          req.lastToolName ? `tool: ${req.lastToolName}` : null,
        ].filter(Boolean) as string[];

        const pad = 6;
        const lineH = 14;
        ctx!.font = "10px SF Mono, Geist Mono, ui-monospace, monospace";
        const w = Math.max(...lines.map((l) => ctx!.measureText(l).width)) + pad * 2;
        const h = lineH * lines.length + pad * 2 - 4;
        let tx = sx + 12;
        let ty = sy - h - 10;
        if (tx + w > width - 6) tx = sx - w - 12;
        if (ty < 6) ty = sy + 16;

        ctx!.fillStyle = t.panelBg;
        ctx!.strokeStyle = t.panelBorder;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.rect(tx, ty, w, h);
        ctx!.fill();
        ctx!.stroke();

        ctx!.fillStyle = t.panelText;
        ctx!.textAlign = "left";
        for (let i = 0; i < lines.length; i++) {
          ctx!.fillText(lines[i], tx + pad, ty + pad + lineH * (i + 1) - 4);
        }
      }

      // Zoom indicator — drawn in screen coords, fades out after recent zoom.
      const sinceZoom = drawNow - s.lastZoomAt;
      const total = ZOOM_INDICATOR_HOLD_MS + ZOOM_INDICATOR_FADE_MS;
      if (s.lastZoomAt > 0 && sinceZoom < total) {
        const alpha =
          sinceZoom < ZOOM_INDICATOR_HOLD_MS
            ? 1
            : Math.max(
                0,
                1 - (sinceZoom - ZOOM_INDICATOR_HOLD_MS) / ZOOM_INDICATOR_FADE_MS,
              );
        const text = `${view.scale.toFixed(2)}×`;
        ctx!.font = "12px SF Mono, Geist Mono, ui-monospace, monospace";
        const tw = ctx!.measureText(text).width;
        const padX = 12;
        const boxW = tw + padX * 2;
        const boxH = 26;
        const boxX = (width - boxW) / 2;
        const boxY = 12;
        ctx!.globalAlpha = alpha;
        ctx!.fillStyle = t.indicatorPanel;
        ctx!.strokeStyle = t.indicatorBorder;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.rect(boxX, boxY, boxW, boxH);
        ctx!.fill();
        ctx!.stroke();
        ctx!.fillStyle = t.panelText;
        ctx!.textAlign = "center";
        ctx!.textBaseline = "middle";
        ctx!.fillText(text, boxX + boxW / 2, boxY + boxH / 2);
        ctx!.textBaseline = "alphabetic";
        ctx!.globalAlpha = 1;
      }

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    function onMouseDown(ev: MouseEvent) {
      if (ev.button !== 0) return;
      const s = stateRef.current;
      const { x: cx, y: cy } = localPos(ev);
      const { x: wx, y: wy } = canvasToWorld(cx, cy);
      const node = nodeAtWorld(wx, wy);
      if (node && node.kind === "worker") {
        node.fx = wx;
        node.fy = wy;
        s.drag = { type: "node", node, movedPx: 0 };
        simRef.current?.alphaTarget(0.3).restart();
      } else {
        s.drag = {
          type: "pan",
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          startTx: s.view.tx,
          startTy: s.view.ty,
          movedPx: 0,
        };
      }
      setCursorForHover();
    }

    function onMouseMove(ev: MouseEvent) {
      const s = stateRef.current;
      const { x: cx, y: cy } = localPos(ev);

      if (s.drag?.type === "node") {
        const { x: wx, y: wy } = canvasToWorld(cx, cy);
        s.drag.node.fx = wx;
        s.drag.node.fy = wy;
        s.drag.movedPx += Math.abs(ev.movementX) + Math.abs(ev.movementY);
        return;
      }
      if (s.drag?.type === "pan") {
        const dx = ev.clientX - s.drag.startClientX;
        const dy = ev.clientY - s.drag.startClientY;
        s.view.tx = s.drag.startTx + dx;
        s.view.ty = s.drag.startTy + dy;
        s.drag.movedPx = Math.abs(dx) + Math.abs(dy);
        return;
      }

      const world = canvasToWorld(cx, cy);
      const hit = ballAtWorld(world.x, world.y);
      s.hoveredBall = hit ? { req: hit.req, x: hit.x, y: hit.y } : null;
      setCursorForHover();
    }

    function onMouseUp(ev: MouseEvent) {
      const s = stateRef.current;
      const drag = s.drag;
      s.drag = null;
      if (drag?.type === "node") {
        // Pin retained on release so the user can position a node like in
        // a canvas tool. Reset clears all pins.
        simRef.current?.alphaTarget(0);
        if (drag.movedPx <= DRAG_CLICK_THRESHOLD_PX) {
          // Treat as click on the node.
          if (drag.node.kind === "worker") onSelect(drag.node.id);
        }
      } else if (drag?.type === "pan") {
        if (drag.movedPx <= DRAG_CLICK_THRESHOLD_PX) {
          // Treat as background click — clear selection.
          const { x: cx, y: cy } = localPos(ev);
          const w = canvasToWorld(cx, cy);
          const ball = ballAtWorld(w.x, w.y);
          // If they clicked a ball, do nothing (hover already shows detail).
          if (!ball) onSelect(null);
        }
      }
      setCursorForHover();
    }

    function onMouseLeave() {
      // Only clear hover state — drag continues via window-level listeners.
      stateRef.current.hoveredBall = null;
      if (!stateRef.current.drag) canvas!.style.cursor = "default";
    }

    function onWheel(ev: WheelEvent) {
      ev.preventDefault();
      const s = stateRef.current;
      const { x: cx, y: cy } = localPos(ev);
      // Anchor zoom on the world point under the cursor.
      const wx = (cx - s.width / 2 - s.view.tx) / s.view.scale;
      const wy = (cy - s.height / 2 - s.view.ty) / s.view.scale;
      const factor = Math.pow(WHEEL_ZOOM_FACTOR, -ev.deltaY);
      const newScale = clamp(s.view.scale * factor, MIN_SCALE, MAX_SCALE);
      if (newScale !== s.view.scale) {
        s.lastZoomAt = Date.now();
        markZoomActive();
      }
      s.view.scale = newScale;
      s.view.tx = cx - s.width / 2 - wx * newScale;
      s.view.ty = cy - s.height / 2 - wy * newScale;
    }

    function markZoomActive() {
      setZoomActive(true);
      if (zoomHideTimerRef.current) clearTimeout(zoomHideTimerRef.current);
      zoomHideTimerRef.current = setTimeout(() => {
        setZoomActive(false);
        zoomHideTimerRef.current = null;
      }, ZOOM_INDICATOR_HOLD_MS + ZOOM_INDICATOR_FADE_MS);
    }

    resetRef.current = () => {
      const s = stateRef.current;
      s.view = { scale: 1, tx: 0, ty: 0 };
      s.lastZoomAt = Date.now();
      markZoomActive();
      for (const n of s.graphNodes) {
        if (n.kind === "worker") {
          n.fx = null;
          n.fy = null;
        }
      }
      simRef.current?.alpha(0.6).restart();
    };

    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      canvas.removeEventListener("wheel", onWheel);
      if (zoomHideTimerRef.current) clearTimeout(zoomHideTimerRef.current);
    };
  }, [onSelect]);

  return (
    <div className="hex-grid relative h-full w-full overflow-hidden rounded-xl">
      <canvas ref={canvasRef} className="absolute inset-0" />
      <button
        type="button"
        onClick={() => resetRef.current()}
        // Mutually exclusive with the canvas zoom indicator: fade + scale
        // out when zooming, slide back in once the indicator finishes.
        // Pointer-events disabled while hidden so it can't be hit blind.
        className={`absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded border border-holo-cyan/40 bg-track px-2 py-1 text-[10px] uppercase tracking-widest text-holo-cyan transition-[opacity,transform] duration-300 ease-out hover:bg-holo-cyan/10 ${
          zoomActive
            ? "pointer-events-none -translate-y-2 opacity-0"
            : "translate-y-0 opacity-100"
        }`}
        title="reset view + node positions"
      >
        reset
      </button>
    </div>
  );
}
