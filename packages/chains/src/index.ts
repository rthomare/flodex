// Chain configuration shared between dashboard, CLI, and (later) any TS code
// that interacts with on-chain flodex state. Rust-side consumers (the node
// binary) read addresses from env vars instead — they don't import this.
//
// USDC addresses are Circle's canonical deployments. Verify against
// https://developers.circle.com/stablecoins/usdc-on-test-networks before
// trusting these in production.
//
// `registry` and `escrow` are populated AFTER deploying our own contracts to
// the target chain. Anvil entries get filled in by the local dev script;
// Base Sepolia / Base entries get filled in once `forge script Deploy` has
// been run on that network.

export type ChainName = "anvil" | "baseSepolia" | "base";

export interface ChainAddresses {
  /** ERC20 stake/payment token (real USDC on Base, MockUSDC on Anvil). */
  usdc: `0x${string}`;
  /** flodex NodeRegistry. `null` until contracts are deployed on this chain. */
  registry: `0x${string}` | null;
  /** flodex JobEscrow. `null` until contracts are deployed on this chain. */
  escrow: `0x${string}` | null;
}

export interface ChainConfig {
  chainId: number;
  name: ChainName;
  rpcUrl: string;
  blockExplorer: string;
  addresses: ChainAddresses;
}

export const chains: Record<number, ChainConfig> = {
  31337: {
    chainId: 31337,
    name: "anvil",
    rpcUrl: "http://127.0.0.1:8545",
    blockExplorer: "",
    addresses: {
      // Anvil's MockUSDC is deployed fresh on each `forge script Deploy` run;
      // the address below is Foundry's deterministic first-create address
      // when a fresh anvil instance is the deployer's first transaction.
      usdc: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      registry: null,
      escrow: null,
    },
  },
  84532: {
    chainId: 84532,
    name: "baseSepolia",
    rpcUrl: "https://sepolia.base.org",
    blockExplorer: "https://sepolia.basescan.org",
    addresses: {
      // Circle's official testnet USDC on Base Sepolia (faucet-fundable).
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      registry: "0xf52b8f75eed06E61801D5251022FD052aa97A51C",
      escrow: "0xEb577b58913Ad50C3203fFdD21a4EB28C46D4894",
    },
  },
  8453: {
    chainId: 8453,
    name: "base",
    rpcUrl: "https://mainnet.base.org",
    blockExplorer: "https://basescan.org",
    addresses: {
      // Native USDC on Base mainnet.
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      registry: null,
      escrow: null,
    },
  },
};

export function getChain(chainId: number): ChainConfig {
  const c = chains[chainId];
  if (!c) throw new Error(`unknown chainId: ${chainId}`);
  return c;
}

/**
 * Like `getChain`, but throws if our contracts haven't been deployed yet on
 * that network. Use at call sites that actually need to interact with the
 * registry or escrow — keeps null checks at the boundary instead of every
 * consumer.
 */
export function requireDeployed(chainId: number): ChainConfig & {
  addresses: {
    usdc: `0x${string}`;
    registry: `0x${string}`;
    escrow: `0x${string}`;
  };
} {
  const c = getChain(chainId);
  if (!c.addresses.registry || !c.addresses.escrow) {
    throw new Error(
      `flodex contracts not deployed on ${c.name} (chainId ${chainId}). ` +
        `See contracts/README.md for deployment.`,
    );
  }
  return c as ChainConfig & {
    addresses: {
      usdc: `0x${string}`;
      registry: `0x${string}`;
      escrow: `0x${string}`;
    };
  };
}
