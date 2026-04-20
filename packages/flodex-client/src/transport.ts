import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import { base64 } from "@scure/base";
import type {
  AgentResponse,
  AgentStep,
  BackendType,
  EncryptedRequest,
  EncryptedResponse,
  JobMatch,
  JobSpec,
  NodeInfo,
} from "@flodex/protocol";

const HKDF_INFO = new TextEncoder().encode("flodex-v0-session-key");

export async function fetchNodeInfo(nodeUrl: string): Promise<NodeInfo> {
  const res = await fetch(`${nodeUrl}/info`);
  if (!res.ok) {
    throw new Error(`GET ${nodeUrl}/info failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as NodeInfo;
}

export async function matchJob(
  coordinatorUrl: string,
  spec: JobSpec,
): Promise<JobMatch> {
  const res = await fetch(`${coordinatorUrl}/jobs/match`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
  if (!res.ok) {
    throw new Error(
      `POST ${coordinatorUrl}/jobs/match failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as JobMatch;
}

/**
 * Encrypt and send one AgentStep to the node, decrypt the response.
 * Uses a fresh ephemeral X25519 keypair per call; the derived symmetric key
 * is scoped to `sessionId` so the node can track conversation state across
 * tool-call round trips.
 */
export async function sendStep(
  nodeUrl: string,
  backend: BackendType,
  nodePub: Uint8Array,
  sessionId: string,
  step: AgentStep,
): Promise<AgentResponse> {
  const clientPriv = x25519.utils.randomPrivateKey();
  const clientPub = x25519.getPublicKey(clientPriv);
  const shared = x25519.getSharedSecret(clientPriv, nodePub);
  const key = hkdf(sha256, shared, new TextEncoder().encode(sessionId), HKDF_INFO, 32);

  const plaintext = new TextEncoder().encode(JSON.stringify(step));
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);

  const req: EncryptedRequest = {
    sessionId,
    clientPublicKey: base64.encode(clientPub),
    nonce: base64.encode(nonce),
    ciphertext: base64.encode(ciphertext),
    backend,
  };

  const res = await fetch(`${nodeUrl}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`POST ${nodeUrl}/execute failed: ${res.status} ${await res.text()}`);
  }

  const enc = (await res.json()) as EncryptedResponse;
  const respNonce = base64.decode(enc.nonce);
  const respCipher = base64.decode(enc.ciphertext);
  const respPlain = xchacha20poly1305(key, respNonce).decrypt(respCipher);
  return JSON.parse(new TextDecoder().decode(respPlain)) as AgentResponse;
}
