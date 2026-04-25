"use client";
import { useState } from "react";
import type { BackendType, NodeRegistration } from "@flodex/protocol";

export default function RequestForm({
  nodes,
  onSend,
  disabled,
}: {
  nodes: NodeRegistration[];
  disabled: boolean;
  onSend: (args: {
    backend: BackendType;
    prompt: string;
    estimatedTokens: number;
    maxPricePer1k: number;
  }) => void;
}) {
  const availableBackends = Array.from(
    new Set(nodes.flatMap((n) => n.backends)),
  );
  const backendOptions: BackendType[] = (
    availableBackends.length > 0 ? availableBackends : ["mock-tee"]
  ) as BackendType[];

  // `chosenBackend` tracks the user's explicit selection. Until they pick (or
  // if their pick is no longer offered by any registered node), we fall back
  // to the first available option. Without this, the form would silently send
  // a stale default that the controlled <select> can't visually represent.
  const [chosenBackend, setChosenBackend] = useState<BackendType | null>(null);
  const backend: BackendType =
    chosenBackend && backendOptions.includes(chosenBackend)
      ? chosenBackend
      : backendOptions[0];

  const [prompt, setPrompt] = useState("What time is it?");
  const [estimatedTokens, setEstimatedTokens] = useState(4000);
  const [maxPricePer1k, setMaxPricePer1k] = useState(1.0);

  return (
    <div className="glass rounded-xl p-4 text-sm">
      <div className="mb-3 text-xs uppercase tracking-widest text-holo-cyan">
        new request
      </div>
      <div className="mb-3 flex items-center gap-3">
        <label className="w-24 text-xs text-fg/60">backend</label>
        <select
          value={backend}
          onChange={(e) => setChosenBackend(e.target.value as BackendType)}
          disabled={disabled}
          className="flex-1 rounded px-2 py-1 text-xs"
        >
          {backendOptions.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-3">
        <label className="mb-1 block text-xs text-fg/60">prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={disabled}
          rows={3}
          className="w-full rounded px-2 py-1 text-xs"
        />
      </div>
      <div className="mb-3 flex items-center gap-3">
        <label className="w-24 text-xs text-fg/60">est. tokens</label>
        <input
          type="number"
          min={100}
          step={100}
          value={estimatedTokens}
          onChange={(e) => setEstimatedTokens(Number.parseInt(e.target.value, 10))}
          disabled={disabled}
          className="w-32 rounded px-2 py-1 text-xs"
        />
      </div>
      <div className="mb-4 flex items-center gap-3">
        <label className="w-24 text-xs text-fg/60">max $/1K</label>
        <input
          type="number"
          step={0.001}
          min={0}
          value={maxPricePer1k}
          onChange={(e) => setMaxPricePer1k(Number.parseFloat(e.target.value))}
          disabled={disabled}
          className="w-32 rounded px-2 py-1 text-xs"
        />
      </div>
      <button
        type="button"
        onClick={() =>
          onSend({ backend, prompt, estimatedTokens, maxPricePer1k })
        }
        disabled={disabled || prompt.trim().length === 0}
        className="w-full rounded border border-holo-cyan/50 bg-holo-cyan/10 py-2 text-xs font-semibold uppercase tracking-widest text-holo-cyan transition hover:bg-holo-cyan/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {disabled ? "running…" : "send →"}
      </button>
      <p className="mt-2 text-[10px] leading-snug text-fg/40">
        client-side tools (e.g. <code>read_local_file</code>) run via the CLI only —
        the dashboard returns "unsupported" to the node if one is requested.
      </p>
    </div>
  );
}
