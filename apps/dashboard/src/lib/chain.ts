import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { getChain, type ChainConfig } from "@fldx/chains";

export const DEFAULT_CHAIN_ID = 84532;

const NATIVE_CURRENCY = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

function viemChainOf(cfg: ChainConfig) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: NATIVE_CURRENCY,
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: cfg.blockExplorer
      ? { default: { name: cfg.name, url: cfg.blockExplorer } }
      : undefined,
  });
}

const clientCache = new Map<number, PublicClient>();

export function publicClient(chainId: number = DEFAULT_CHAIN_ID): PublicClient {
  const hit = clientCache.get(chainId);
  if (hit) return hit;
  const cfg = getChain(chainId);
  const client = createPublicClient({
    chain: viemChainOf(cfg),
    transport: http(cfg.rpcUrl),
  });
  clientCache.set(chainId, client);
  return client;
}

/// Minimal ABI for the views we need from NodeRegistry today.
/// Source of truth is contracts/src/NodeRegistry.sol — keep these signatures
/// in sync when adding new on-chain views.
export const NODE_REGISTRY_ABI = [
  {
    inputs: [],
    name: "nodeCount",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "minStake",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
