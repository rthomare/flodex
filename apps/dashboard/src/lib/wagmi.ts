"use client";

// wagmi + RainbowKit config for the fldx dashboard. Base Sepolia is the
// only chain we connect to in v0 (the demo network); the user provides a
// WalletConnect projectId via env var.

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { baseSepolia } from "wagmi/chains";
import { http } from "wagmi";

const projectId =
  process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "00000000000000000000000000000000";

export const wagmiConfig = getDefaultConfig({
  appName: "fldx",
  projectId,
  chains: [baseSepolia],
  transports: {
    [baseSepolia.id]: http(),
  },
  ssr: true,
});

export const FLDX_CHAIN_ID = baseSepolia.id;
