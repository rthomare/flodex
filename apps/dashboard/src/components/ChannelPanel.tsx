"use client";
import { useMemo, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import type { NodeRegistration, NodeSignedReceipt } from "@flodex/protocol";
import { ethAddressFromCompressed } from "@/lib/eth";
import type { UseChannelResult } from "@/hooks/useChannel";

const CHANNEL_STATUS_LABELS = ["none", "open", "challenged", "closed"] as const;

function formatUsdc(units: bigint): string {
  const dollars = Number(units) / 1_000_000;
  return `${dollars.toFixed(4)} USDC`;
}

export default function ChannelPanel({
  node,
  channel,
  latestReceipt,
}: {
  node: NodeRegistration | null;
  channel: UseChannelResult;
  latestReceipt: NodeSignedReceipt | null;
}) {
  const { isConnected } = useAccount();
  const nodeAddress = useMemo(
    () => (node ? ethAddressFromCompressed(node.identityPubkey) : null),
    [node],
  );
  const [depositInput, setDepositInput] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = channel.onchain?.status ?? 0;
  const statusLabel = CHANNEL_STATUS_LABELS[status] ?? "unknown";

  async function onOpen() {
    if (!nodeAddress) return;
    const dollars = parseFloat(depositInput);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError("invalid deposit");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const units = BigInt(Math.round(dollars * 1_000_000));
      await channel.openChannel(units);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSignLatest() {
    if (!latestReceipt) {
      setError("no receipt to sign");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await channel.signReceipt(latestReceipt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onClose() {
    setError(null);
    setBusy(true);
    try {
      await channel.cooperativeClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass rounded-xl p-4 text-xs">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="uppercase tracking-widest text-holo-cyan">channel</span>
        <span className="text-[10px] text-fg/50">base sepolia</span>
      </div>

      <div className="mb-3">
        <ConnectButton showBalance={false} chainStatus="icon" />
      </div>

      {!node && <div className="text-fg/50">select a node to open a channel</div>}

      {node && nodeAddress && (
        <>
          <Row label="node addr" value={shortAddr(nodeAddress)} />
          <Row label="status" value={statusLabel} />
          {channel.onchain && (
            <>
              <Row label="deposit" value={formatUsdc(channel.onchain.deposit)} />
              <Row label="latest nonce" value={channel.onchain.latestNonce.toString()} />
              <Row label="cum owed" value={formatUsdc(channel.onchain.latestCumOwed)} />
            </>
          )}
          {channel.state?.lastAck && (
            <Row
              label="last ack"
              value={`#${channel.state.lastAck.update.nonce} / ${channel.state.lastAck.update.cumOwed}`}
            />
          )}

          {isConnected && (
            <div className="mt-3 space-y-2">
              {status === 0 && (
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={depositInput}
                    onChange={(e) => setDepositInput(e.target.value)}
                    className="w-20 rounded bg-fg/5 px-2 py-1 text-fg/90"
                    aria-label="deposit USDC"
                  />
                  <button
                    onClick={onOpen}
                    disabled={busy}
                    className="rounded bg-holo-cyan/20 px-2 py-1 text-holo-cyan hover:bg-holo-cyan/30 disabled:opacity-50"
                  >
                    open ({depositInput} USDC)
                  </button>
                </div>
              )}
              {status === 1 && (
                <>
                  <button
                    onClick={onSignLatest}
                    disabled={busy || !latestReceipt}
                    className="w-full rounded bg-fg/5 px-2 py-1 text-fg/80 hover:bg-fg/10 disabled:opacity-50"
                  >
                    sign latest receipt
                  </button>
                  <button
                    onClick={onClose}
                    disabled={busy || !channel.state?.lastAck}
                    className="w-full rounded bg-holo-cyan/20 px-2 py-1 text-holo-cyan hover:bg-holo-cyan/30 disabled:opacity-50"
                  >
                    cooperative close
                  </button>
                </>
              )}
            </div>
          )}

          {error && (
            <div className="mt-2 break-all text-[10px] text-holo-red" title={error}>
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-fg/50">{label}</span>
      <span className="text-fg/80">{value}</span>
    </div>
  );
}
