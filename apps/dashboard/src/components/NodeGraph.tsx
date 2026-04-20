"use client";
import { useEffect, useRef } from "react";
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
import type { NodeRegistration } from "@flodex/protocol";

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

export default function NodeGraph({
  nodes,
  activeNodeUrls,
  selectedPubKey,
  onSelect,
}: {
  nodes: NodeRegistration[];
  activeNodeUrls: Set<string>;
  selectedPubKey: string | null;
  onSelect: (pubkey: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const stateRef = useRef<{
    graphNodes: GraphNode[];
    links: GraphLink[];
    activeNodeUrls: Set<string>;
    selectedPubKey: string | null;
    width: number;
    height: number;
  }>({
    graphNodes: [],
    links: [],
    activeNodeUrls,
    selectedPubKey,
    width: 0,
    height: 0,
  });

  // Rebuild graph when the node list changes
  useEffect(() => {
    const client: GraphNode = {
      id: CLIENT_ID,
      label: "client",
      kind: "client",
      fx: 0,
      fy: 0,
    };
    const workers: GraphNode[] = nodes.map((n) => ({
      id: n.publicKey,
      label: n.backends.join(","),
      kind: "worker",
      reg: n,
    }));
    const graphNodes = [client, ...workers];
    const links: GraphLink[] = workers.map((w) => ({
      source: CLIENT_ID,
      target: w.id,
      active: false,
    }));

    stateRef.current.graphNodes = graphNodes;
    stateRef.current.links = links;

    simRef.current?.stop();
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
  }, [nodes]);

  useEffect(() => {
    stateRef.current.activeNodeUrls = activeNodeUrls;
  }, [activeNodeUrls]);
  useEffect(() => {
    stateRef.current.selectedPubKey = selectedPubKey;
  }, [selectedPubKey]);

  // Canvas draw loop + resize handling
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

    function draw() {
      const s = stateRef.current;
      const { width, height } = s;
      ctx!.clearRect(0, 0, width, height);
      ctx!.save();
      ctx!.translate(width / 2, height / 2);

      // edges
      for (const link of s.links) {
        const src = link.source as GraphNode;
        const tgt = link.target as GraphNode;
        if (src.x == null || src.y == null || tgt.x == null || tgt.y == null) continue;
        const active = tgt.reg ? s.activeNodeUrls.has(tgt.reg.url) : false;
        ctx!.beginPath();
        ctx!.moveTo(src.x, src.y);
        ctx!.lineTo(tgt.x, tgt.y);
        ctx!.strokeStyle = active
          ? "rgba(102, 204, 255, 0.9)"
          : "rgba(102, 204, 255, 0.12)";
        ctx!.lineWidth = active ? 2 : 1;
        ctx!.stroke();

        if (active) {
          const t = (performance.now() / 900) % 1;
          const px = src.x + (tgt.x - src.x) * t;
          const py = src.y + (tgt.y - src.y) * t;
          ctx!.beginPath();
          ctx!.arc(px, py, 4, 0, Math.PI * 2);
          ctx!.fillStyle = "#66ffaa";
          ctx!.shadowColor = "#66ffaa";
          ctx!.shadowBlur = 12;
          ctx!.fill();
          ctx!.shadowBlur = 0;
        }
      }

      // nodes
      for (const n of s.graphNodes) {
        if (n.x == null || n.y == null) continue;
        const isClient = n.kind === "client";
        const isActive = n.reg ? s.activeNodeUrls.has(n.reg.url) : false;
        const isSelected = s.selectedPubKey !== null && n.id === s.selectedPubKey;
        const radius = isClient ? 22 : 28;

        // glow
        const glowAlpha = isActive ? 0.6 : isSelected ? 0.45 : 0.22;
        const glow = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, radius * 2.4);
        const glowColor = isClient
          ? "rgba(180, 140, 255,"
          : isActive
          ? "rgba(102, 255, 170,"
          : "rgba(102, 204, 255,";
        glow.addColorStop(0, `${glowColor} ${glowAlpha})`);
        glow.addColorStop(1, `${glowColor} 0)`);
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, radius * 2.4, 0, Math.PI * 2);
        ctx!.fill();

        // body
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, radius, 0, Math.PI * 2);
        ctx!.fillStyle = isClient
          ? "#1a1030"
          : isActive
          ? "#0f2a22"
          : "#0b1428";
        ctx!.fill();
        ctx!.strokeStyle = isClient
          ? "#b48cff"
          : isActive
          ? "#66ffaa"
          : isSelected
          ? "#ffbb44"
          : "#66ccff";
        ctx!.lineWidth = isSelected ? 2.5 : 1.5;
        ctx!.stroke();

        // label
        ctx!.fillStyle = "#e7ecf3";
        ctx!.font = "11px SF Mono, Geist Mono, ui-monospace, monospace";
        ctx!.textAlign = "center";
        ctx!.fillText(n.label, n.x, n.y + radius + 16);

        // sublabel for workers (truncated pubkey)
        if (n.reg) {
          ctx!.fillStyle = "rgba(231, 236, 243, 0.45)";
          ctx!.font = "9px SF Mono, Geist Mono, ui-monospace, monospace";
          ctx!.fillText(
            `${n.reg.publicKey.slice(0, 8)}…`,
            n.x,
            n.y + radius + 30,
          );
        }
      }

      ctx!.restore();
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    // click selection
    function onClick(ev: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      const x = ev.clientX - rect.left - rect.width / 2;
      const y = ev.clientY - rect.top - rect.height / 2;
      const s = stateRef.current;
      let hit: GraphNode | null = null;
      for (const n of s.graphNodes) {
        if (n.x == null || n.y == null) continue;
        const dx = n.x - x;
        const dy = n.y - y;
        const r = n.kind === "client" ? 22 : 28;
        if (dx * dx + dy * dy < r * r) {
          hit = n;
          break;
        }
      }
      if (!hit || hit.kind === "client") onSelect(null);
      else onSelect(hit.id);
    }
    canvas.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("click", onClick);
    };
  }, [onSelect]);

  return (
    <div className="hex-grid relative h-full w-full overflow-hidden rounded-xl">
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
