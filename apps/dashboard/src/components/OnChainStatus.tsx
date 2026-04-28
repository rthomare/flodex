"use client";
import { getChain } from "@flodex/chains";
import { useOnChainStatus } from "@/hooks/useOnChainStatus";

function shortAddr(addr: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsdc(raw: bigint | null): string {
  if (raw === null) return "—";
  const dollars = Number(raw) / 1_000_000;
  return `${dollars.toFixed(0)} USDC`;
}

export default function OnChainStatus({ chainId }: { chainId: number }) {
  const cfg = getChain(chainId);
  const { loading, error, nodeCount, minStake } = useOnChainStatus(chainId);

  const explorer = cfg.blockExplorer
    ? `${cfg.blockExplorer}/address/${cfg.addresses.registry ?? ""}`
    : null;

  return (
    <div className="glass rounded-xl p-4 text-xs">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="uppercase tracking-widest text-holo-cyan">on-chain</span>
        <span className="text-[10px] text-fg/50">{cfg.name}</span>
      </div>
      <div className="space-y-0.5">
        <Row label="registry" value={shortAddr(cfg.addresses.registry)} href={explorer} />
        <Row label="channel" value={shortAddr(cfg.addresses.channel)} />
        <Row label="usdc" value={shortAddr(cfg.addresses.usdc)} />
        <Row
          label="registered"
          value={loading ? "…" : nodeCount === null ? "—" : nodeCount.toString()}
        />
        <Row label="min stake" value={formatUsdc(minStake)} />
      </div>
      {error && (
        <div className="mt-2 truncate text-[10px] text-holo-red" title={error}>
          {error}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string | null;
}) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-fg/50">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-fg/80 hover:text-holo-cyan"
        >
          {value}
        </a>
      ) : (
        <span className="text-fg/80">{value}</span>
      )}
    </div>
  );
}
