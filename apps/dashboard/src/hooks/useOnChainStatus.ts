import { useEffect, useState } from "react";
import { requireDeployed } from "@fldx/chains";
import { NODE_REGISTRY_ABI, publicClient } from "@/lib/chain";

export interface OnChainStatus {
  loading: boolean;
  error: string | null;
  /** Number of nodes currently registered on the on-chain registry. */
  nodeCount: bigint | null;
  /** Minimum stake required by the registry, in raw USDC units (6 decimals). */
  minStake: bigint | null;
}

/**
 * Polls the deployed NodeRegistry on the configured chain and returns the
 * basic-counter views (nodeCount, minStake). Used as a connectivity smoke
 * test today; richer reads (per-node enumeration, escrow state) come when we
 * actually start opening sessions.
 */
export function useOnChainStatus(chainId: number, intervalMs = 15_000): OnChainStatus {
  const [state, setState] = useState<OnChainStatus>({
    loading: true,
    error: null,
    nodeCount: null,
    minStake: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const cfg = requireDeployed(chainId);
        const client = publicClient(chainId);
        const [nodeCount, minStake] = await Promise.all([
          client.readContract({
            address: cfg.addresses.registry,
            abi: NODE_REGISTRY_ABI,
            functionName: "nodeCount",
          }),
          client.readContract({
            address: cfg.addresses.registry,
            abi: NODE_REGISTRY_ABI,
            functionName: "minStake",
          }),
        ]);
        if (!cancelled) {
          setState({ loading: false, error: null, nodeCount, minStake });
        }
      } catch (e) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          }));
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [chainId, intervalMs]);

  return state;
}
