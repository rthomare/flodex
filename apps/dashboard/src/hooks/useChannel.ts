"use client";

// Channel lifecycle hook: opens a payment channel against a target node,
// signs cumulative-state acks via the connected wallet, and submits the
// final cooperativeClose. Latest state lives in localStorage so a page
// reload doesn't lose track of the most recently signed ack.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, type Hex } from "viem";
import type { ClientAck, NodeSignedReceipt } from "@fldx/protocol";
import { getChain } from "@fldx/chains";
import { erc20Abi, jobChannelAbi } from "@/lib/abis";
import { channelIdOf, channelUpdateCanonical, keccak } from "@/lib/eth";

export interface ChannelState {
  channelId: `0x${string}`;
  client: `0x${string}`;
  nodeAddress: `0x${string}`;
  /** Most recent receipt the node sent us (node-signed). */
  lastReceipt?: NodeSignedReceipt;
  /** Most recent ack we signed back. Submit this in cooperativeClose. */
  lastAck?: ClientAck;
}

const STORAGE_KEY = "fldx-channel-state-v1";

function readStorage(): Record<string, ChannelState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ChannelState>) : {};
  } catch {
    return {};
  }
}

function writeStorage(map: Record<string, ChannelState>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

function storageKey(client: string, node: string): string {
  return `${client.toLowerCase()}::${node.toLowerCase()}`;
}

export interface UseChannelArgs {
  /** Target node's Ethereum address (derived from identity_pubkey). */
  nodeAddress: `0x${string}` | null;
  chainId: number;
}

export interface UseChannelResult {
  state: ChannelState | null;
  /** True when wallet is connected and channel contract is deployed. */
  ready: boolean;
  /** From-chain channel record; null until first read. */
  onchain: OnchainChannel | null;
  refreshOnchain: () => Promise<void>;
  openChannel: (depositUnits: bigint) => Promise<void>;
  cooperativeClose: () => Promise<void>;
  /** Sign a node-supplied receipt via the wallet, store the ack. */
  signReceipt: (receipt: NodeSignedReceipt) => Promise<ClientAck>;
}

export interface OnchainChannel {
  status: number; // 0=None, 1=Open, 2=Challenged, 3=Closed
  deposit: bigint;
  latestNonce: bigint;
  latestCumOwed: bigint;
}

const CHANNEL_NONCE = 0n; // v0: one channel at a time per (client, node).

export function useChannel(args: UseChannelArgs): UseChannelResult {
  const { nodeAddress, chainId } = args;
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });

  const chainCfg = useMemo(() => getChain(chainId), [chainId]);
  const channelContract = chainCfg.addresses.channel;
  const usdc = chainCfg.addresses.usdc;
  const ready = Boolean(address && nodeAddress && channelContract && walletClient);

  const channelId = useMemo<`0x${string}` | null>(() => {
    if (!address || !nodeAddress) return null;
    return channelIdOf(address, nodeAddress, CHANNEL_NONCE);
  }, [address, nodeAddress]);

  const [state, setState] = useState<ChannelState | null>(null);
  const [onchain, setOnchain] = useState<OnchainChannel | null>(null);

  // Hydrate from storage when (client, node) pair resolves.
  useEffect(() => {
    if (!address || !nodeAddress || !channelId) return;
    const map = readStorage();
    const existing = map[storageKey(address, nodeAddress)] ?? null;
    setState(existing);
  }, [address, nodeAddress, channelId]);

  const persist = useCallback(
    (next: ChannelState) => {
      if (!address || !nodeAddress) return;
      const map = readStorage();
      map[storageKey(address, nodeAddress)] = next;
      writeStorage(map);
      setState(next);
    },
    [address, nodeAddress],
  );

  const refreshOnchain = useCallback(async () => {
    if (!publicClient || !channelContract || !channelId) return;
    try {
      const result = (await publicClient.readContract({
        address: channelContract,
        abi: jobChannelAbi,
        functionName: "channels",
        args: [channelId],
      })) as {
        client: `0x${string}`;
        node: `0x${string}`;
        deposit: bigint;
        latestCumOwed: bigint;
        latestNonce: bigint;
        challengeDeadline: bigint;
        openedAt: bigint;
        status: number;
      };
      setOnchain({
        status: result.status,
        deposit: result.deposit,
        latestNonce: result.latestNonce,
        latestCumOwed: result.latestCumOwed,
      });
    } catch (e) {
      console.warn("refreshOnchain failed", e);
    }
  }, [publicClient, channelContract, channelId]);

  useEffect(() => {
    void refreshOnchain();
  }, [refreshOnchain]);

  const openChannel = useCallback(
    async (depositUnits: bigint) => {
      if (!walletClient || !publicClient || !address || !nodeAddress || !channelContract || !usdc) {
        throw new Error("wallet / chain not ready");
      }
      // 1) Approve USDC if needed.
      const allowance = (await publicClient.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, channelContract],
      })) as bigint;
      if (allowance < depositUnits) {
        const approveData = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          // Approve max so future top-ups don't require re-approval.
          args: [channelContract, 2n ** 256n - 1n],
        });
        const approveHash = await walletClient.sendTransaction({
          to: usdc,
          data: approveData,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      // 2) openChannel
      const openData = encodeFunctionData({
        abi: jobChannelAbi,
        functionName: "openChannel",
        args: [nodeAddress, CHANNEL_NONCE, depositUnits],
      });
      const openHash = await walletClient.sendTransaction({
        to: channelContract,
        data: openData,
      });
      await publicClient.waitForTransactionReceipt({ hash: openHash });

      const id = channelIdOf(address, nodeAddress, CHANNEL_NONCE);
      persist({ channelId: id, client: address, nodeAddress });
      await refreshOnchain();
    },
    [walletClient, publicClient, address, nodeAddress, channelContract, usdc, persist, refreshOnchain],
  );

  const signReceipt = useCallback(
    async (receipt: NodeSignedReceipt): Promise<ClientAck> => {
      if (!walletClient || !channelContract || !address || !nodeAddress) {
        throw new Error("wallet not ready for signing");
      }
      const canonical = channelUpdateCanonical(
        BigInt(chainId),
        channelContract,
        receipt.update.channelId as `0x${string}`,
        BigInt(receipt.update.nonce),
        BigInt(receipt.update.cumOwed),
      );
      // The contract verifies `MessageHashUtils.toEthSignedMessageHash(keccak256(canonical))`,
      // i.e. EIP-191(`\n32` + keccak256(canonical)). signMessage with raw
      // bytes uses the byte length in the prefix, so we *must* hash first
      // and sign the resulting 32-byte digest — otherwise the prefix says
      // "\n192" and on-chain recovery yields the wrong address.
      const innerHash = keccak(canonical);
      const sig = (await walletClient.signMessage({
        message: { raw: innerHash as unknown as Hex },
      })) as `0x${string}`;
      const ack: ClientAck = {
        update: receipt.update,
        clientSig: sig,
      };
      if (state) persist({ ...state, lastReceipt: receipt, lastAck: ack });
      return ack;
    },
    [walletClient, channelContract, address, nodeAddress, chainId, state, persist],
  );

  const cooperativeClose = useCallback(async () => {
    if (!walletClient || !publicClient || !channelContract || !state?.lastAck || !state.lastReceipt) {
      throw new Error("nothing to close — no signed state yet");
    }
    const { update } = state.lastAck;
    const data = encodeFunctionData({
      abi: jobChannelAbi,
      functionName: "cooperativeClose",
      args: [
        update.channelId as `0x${string}`,
        BigInt(update.nonce),
        BigInt(update.cumOwed),
        state.lastAck.clientSig as `0x${string}`,
        state.lastReceipt.nodeSig as `0x${string}`,
      ],
    });
    const hash = await walletClient.sendTransaction({
      to: channelContract,
      data,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await refreshOnchain();
  }, [walletClient, publicClient, channelContract, state, refreshOnchain]);

  return {
    state,
    ready,
    onchain,
    refreshOnchain,
    openChannel,
    cooperativeClose,
    signReceipt,
  };
}
