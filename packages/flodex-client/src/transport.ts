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
  ClientAck,
  EncryptedRequest,
  EncryptedResponse,
  JobMatch,
  JobSpec,
  NodeInfo,
  NodeSignedReceipt,
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

export interface SendStepOptions {
  nodeUrl: string;
  backend: BackendType;
  nodePub: Uint8Array;
  sessionId: string;
  step: AgentStep;
  /** 0x-prefixed channelId, when this request is bound to a payment channel. */
  channelId?: `0x${string}`;
  /** Client's co-signature on the previous round trip's update — piggybacked. */
  prevAck?: ClientAck;
}

export interface SendStepResult {
  response: AgentResponse;
  /** Present iff the node returned a channel receipt (i.e. channelId was set). */
  receipt?: NodeSignedReceipt;
}

/**
 * Encrypt and send one AgentStep to the node, decrypt the response.
 * Uses a fresh ephemeral X25519 keypair per call; the derived symmetric key
 * is scoped to `sessionId` so the node can track conversation state across
 * tool-call round trips. When `channelId` is set, the node returns a
 * cumulative-state receipt the caller must co-sign and post back next.
 */
export async function sendStep(opts: SendStepOptions): Promise<SendStepResult>;
// Legacy positional-args overload — used by older callers that don't pass
// channel context. Will be removed once the dashboard fully migrates.
export async function sendStep(
  nodeUrl: string,
  backend: BackendType,
  nodePub: Uint8Array,
  sessionId: string,
  step: AgentStep,
): Promise<AgentResponse>;
export async function sendStep(
  optsOrUrl: SendStepOptions | string,
  backend?: BackendType,
  nodePub?: Uint8Array,
  sessionId?: string,
  step?: AgentStep,
): Promise<SendStepResult | AgentResponse> {
  const positional = typeof optsOrUrl === "string";
  const opts: SendStepOptions = positional
    ? {
        nodeUrl: optsOrUrl,
        backend: backend!,
        nodePub: nodePub!,
        sessionId: sessionId!,
        step: step!,
      }
    : optsOrUrl;

  const clientPriv = x25519.utils.randomPrivateKey();
  const clientPub = x25519.getPublicKey(clientPriv);
  const shared = x25519.getSharedSecret(clientPriv, opts.nodePub);
  const key = hkdf(sha256, shared, new TextEncoder().encode(opts.sessionId), HKDF_INFO, 32);

  const plaintext = new TextEncoder().encode(JSON.stringify(opts.step));
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);

  const req: EncryptedRequest = {
    sessionId: opts.sessionId,
    clientPublicKey: base64.encode(clientPub),
    nonce: base64.encode(nonce),
    ciphertext: base64.encode(ciphertext),
    backend: opts.backend,
    ...(opts.channelId ? { channelId: opts.channelId } : {}),
    ...(opts.prevAck ? { prevAck: opts.prevAck } : {}),
  };

  const res = await fetch(`${opts.nodeUrl}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`POST ${opts.nodeUrl}/execute failed: ${res.status} ${await res.text()}`);
  }

  const enc = (await res.json()) as EncryptedResponse;
  const respNonce = base64.decode(enc.nonce);
  const respCipher = base64.decode(enc.ciphertext);
  const respPlain = xchacha20poly1305(key, respNonce).decrypt(respCipher);
  const response = JSON.parse(new TextDecoder().decode(respPlain)) as AgentResponse;

  if (positional) return response;
  return { response, receipt: enc.receipt ?? undefined };
}

/**
 * Standalone client co-signature post for the *last* round trip of a channel
 * (which has no following request to piggyback on). The dashboard hits this
 * before submitting `cooperativeClose` so both parties have the latest
 * fully-signed state.
 */
export async function postAck(nodeUrl: string, ack: ClientAck): Promise<void> {
  const res = await fetch(`${nodeUrl}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ack),
  });
  if (!res.ok) {
    throw new Error(`POST ${nodeUrl}/ack failed: ${res.status} ${await res.text()}`);
  }
}
