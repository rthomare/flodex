// Helpers for deriving Ethereum identity from flodex node identity_pubkey
// (33-byte secp256k1 compressed) without round-tripping through the node.

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

export function ethAddressFromCompressed(
  compressedHex: string,
): `0x${string}` {
  const stripped = compressedHex.startsWith("0x")
    ? compressedHex.slice(2)
    : compressedHex;
  const point = secp256k1.ProjectivePoint.fromHex(stripped);
  const uncompressed = point.toRawBytes(false); // 65 bytes: 0x04 || X || Y
  const hash = keccak_256(uncompressed.slice(1));
  const addr = hash.slice(12);
  let hex = "";
  for (const b of addr) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Derive the deterministic channel id used by `JobChannel.channelIdOf` —
 * `keccak256(abi.encode(client, node, channelNonce))`. We hand-roll the
 * abi.encode here instead of pulling viem's encoder for one call: 3 fixed
 * 32-byte slots concatenated.
 */
export function channelIdOf(
  client: `0x${string}`,
  node: `0x${string}`,
  channelNonce: bigint,
): `0x${string}` {
  const buf = new Uint8Array(96);
  // address: 12 zero bytes + 20-byte addr
  buf.set(hexToBytes(client.slice(2)), 12);
  buf.set(hexToBytes(node.slice(2)), 32 + 12);
  // uint64 in last 8 bytes of slot 3
  const nonceBytes = u64BeBytes(channelNonce);
  buf.set(nonceBytes, 64 + 24);
  const hash = keccak_256(buf);
  let hex = "";
  for (const b of hash) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}` as `0x${string}`;
}

/**
 * EIP-191 digest for a channel update — what wagmi's `useSignMessage` would
 * sign if given the canonical bytes. We compute it here to verify a node's
 * receipt sig against the expected node address before storing it.
 */
export function channelUpdateCanonical(
  chainId: bigint,
  channelContract: `0x${string}`,
  channelId: `0x${string}`,
  nonce: bigint,
  cumOwed: bigint,
): Uint8Array {
  const out = new Uint8Array(192);
  // Slot 1: keccak256("flodex-v0-channel-update")
  const domain = keccak_256(new TextEncoder().encode("flodex-v0-channel-update"));
  out.set(domain, 0);
  // Slot 2: chainId (uint256)
  out.set(u256BeBytes(chainId), 32);
  // Slot 3: contract address (left-padded to 32)
  out.set(hexToBytes(channelContract.slice(2)), 64 + 12);
  // Slot 4: channelId (bytes32)
  out.set(hexToBytes(channelId.slice(2)), 96);
  // Slot 5: nonce (uint256)
  out.set(u256BeBytes(nonce), 128);
  // Slot 6: cumOwed (uint256)
  out.set(u256BeBytes(cumOwed), 160);
  return out;
}

/** keccak256(message) — handy when verifying receipts. */
export function keccak(message: Uint8Array): Uint8Array {
  return keccak_256(message);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("hex must be even-length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function u64BeBytes(n: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let v = n;
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function u256BeBytes(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}
