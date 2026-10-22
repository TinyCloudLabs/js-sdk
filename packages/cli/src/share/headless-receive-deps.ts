import { createPrivateKey, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { storedSecret, type FileEmailProofPendingStore } from "@tinycloud/node-sdk/credential-pending-store";
import {
  completeEmailProof,
  createEd25519HolderSigner,
  EmailProofError,
  requestEmailProofCode,
  type EmailProofErrorCode,
  type HolderSigner,
} from "@tinycloud/node-sdk/credentials";
import { didKeyFromEd25519PublicKey, type ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import type { SharePolicyChallenge, SharePresentationMaterial } from "@tinycloud/share-sdk";
import {
  EmailProofGateError,
  HeadlessReceiveError,
  type EmailProofGate,
  type EmailProofGateErrorCode,
  type EmailProofMaterial,
  type JsonValue,
  type ReceivedContent,
} from "./headless-receive.js";

/**
 * Builds the share presentation for one policy challenge. Owned by node-sdk; the CLI only
 * receives it and never signs a presentation itself.
 */
export type BuildSharePresentation = (input: {
  readonly holderSigner: HolderSigner;
  readonly envelope: ShareEnvelopeV3;
  readonly challenge: SharePolicyChallenge;
  readonly policy: Record<string, unknown>;
}) => Promise<SharePresentationMaterial>;

/** Opens the addressed share: answers the policy challenge with `buildPresentation`, then reads the content. */
export type OpenAddressedShare = (input: {
  readonly envelope: ShareEnvelopeV3;
  readonly material: EmailProofMaterial;
  readonly buildPresentation: BuildSharePresentation;
}) => Promise<ReceivedContent>;

/** Default builder until the node-sdk export exists. Fails closed; never produces a presentation. */
export const unavailablePresentationBuilder: BuildSharePresentation = async () => {
  throw new HeadlessReceiveError("UNAVAILABLE", "presentation builder unavailable");
};

/**
 * Default opener until share-sdk exposes a v3 addressed open. The current recipient client only
 * authorizes v2 envelopes; this fails closed instead of calling it with a v3 envelope.
 */
export const unavailableOpenAddressedShare: OpenAddressedShare = async () => {
  throw new HeadlessReceiveError("UNAVAILABLE", "share open unavailable");
};

interface HolderKey {
  /** PKCS#8 DER private key. Secret: persisted only through the 0600 pending store. */
  readonly secret: Uint8Array;
  readonly did: string;
}

function newHolderKey(): HolderKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return {
    secret: new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" })),
    did: didKeyFromEd25519PublicKey(raw),
  };
}

function holderSignerFor(secret: Uint8Array, did: string): HolderSigner {
  const key = createPrivateKey({ key: Buffer.from(secret), format: "der", type: "pkcs8" });
  return createEd25519HolderSigner(did, async (bytes) => new Uint8Array(signEd25519(null, bytes, key)));
}

export function gateCodeFor(code: EmailProofErrorCode): EmailProofGateErrorCode {
  switch (code) {
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "CODE_REJECTED":
    case "CODE_INVALID":
      return "CODE_REJECTED";
    case "SESSION_EXPIRED":
    case "SESSION_INVALID":
    case "CODE_ATTEMPTS_EXHAUSTED":
      return "REQUEST_EXPIRED";
    case "NETWORK":
    case "ISSUER_UNAVAILABLE":
    case "PROFILE_UNAVAILABLE":
    case "ADDRESS_INVALID":
    case "HOLDER_INVALID":
    case "SIGNATURE_REJECTED":
    case "CREDENTIAL_INVALID":
    case "CANCELED":
    case "FAILED":
      return "UNAVAILABLE";
  }
}

/** Maps node-sdk errors to gate errors. Only the code and retry hint cross; no secret-bearing text. */
async function mapNodeErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EmailProofError) {
      throw new EmailProofGateError(gateCodeFor(error.code), `email proof step failed: ${error.code}`, error.retryAfterMs);
    }
    throw new EmailProofGateError("UNAVAILABLE", "email proof step failed");
  }
}

export function requestIdFrom(state: JsonValue): string {
  if (typeof state === "object" && state !== null && !Array.isArray(state) && typeof state["requestId"] === "string") {
    return state["requestId"];
  }
  throw new EmailProofGateError("UNAVAILABLE", "pending email proof request is unreadable");
}

export interface NodeEmailProofGateOptions {
  /** Node-sdk pending store under the CLI's owner-only config directory. Holds the holder secret. */
  readonly store: FileEmailProofPendingStore;
  /** Transport override; the CLI uses the global fetch when omitted. Tests inject a fake witness here. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * Email-code gate over node-sdk. The holder key lives only in the node-sdk pending store (0600).
 * The gate state carries the request id and nothing secret.
 */
export function createNodeEmailProofGate(options: NodeEmailProofGateOptions): EmailProofGate {
  const now = options.now ?? (() => new Date());
  return {
    async requestCode({ recipient, signal }) {
      const holder = newHolderKey();
      const pending = await mapNodeErrors(() =>
        requestEmailProofCode({
          address: recipient,
          holder: holderSignerFor(holder.secret, holder.did),
          now,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      await options.store.put(pending, { secret: holder.secret });
      return { state: { requestId: pending.requestId }, expiresAt: pending.expiresAt };
    },
    async completeEmailProof({ state, code, signal }) {
      const requestId = requestIdFrom(state);
      const pending = await options.store.get(requestId, now());
      if (pending === undefined) throw new EmailProofGateError("REQUEST_EXPIRED", "the code request expired; start again with --request-code");
      const secret = storedSecret(pending);
      if (secret === undefined) throw new EmailProofGateError("UNAVAILABLE", "pending email proof request is unreadable");
      const holderSigner = holderSignerFor(secret, pending.holderDid);
      try {
        const credential = await mapNodeErrors(() =>
          completeEmailProof({
            pending,
            code,
            holder: holderSigner,
            now,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(signal === undefined ? {} : { signal }),
          }),
        );
        return { holderDid: pending.holderDid, holderSigner, credential };
      } finally {
        // Single use: removed on every outcome after load, matching the CLI pending file.
        await options.store.delete(requestId);
      }
    },
  };
}

export interface ShareAccessPortOptions {
  readonly buildPresentation: BuildSharePresentation;
  readonly open: OpenAddressedShare;
}

/** Share access port: the presentation builder and the opener are both injected; neither has a production implementation yet. */
export function createShareAccessPort(options: ShareAccessPortOptions): {
  receive(envelope: ShareEnvelopeV3, material: EmailProofMaterial): Promise<ReceivedContent>;
} {
  return {
    receive: (envelope, material) => options.open({ envelope, material, buildPresentation: options.buildPresentation }),
  };
}
