/**
 * Sign-out "retire the key" (TC-3443), the half the SDK root carries: the
 * types, the hosts a session used, and what sign-out captures before
 * teardown. The node calls live in `session-retire`, loaded when a session
 * starts.
 */
import type { PersistedSessionProof } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "./delegation";

export interface SessionRetireSigner {
  /** `did:key:…#…` of the session key; becomes the UCAN `iss`. */
  verificationMethod: string;
  /** A compact JWT of `header` and `payload`, signed with the session key (Ed25519). */
  signJwt: (header: object, payload: object) => Promise<string>;
}

export interface NodeSignOutFailure {
  host: string;
  /**
   * - `unreachable`: no answer (network error or timeout) on every try.
   * - `refused`: 401; the host refused the request. Not retried, except once without a refused root (see `delegation`).
   * - `unsupported`: 404; the host has no `/session/retire`. Not retried.
   * - `failed`: any other answer, including 429 or 503 on every try (see `status`).
   */
  reason: "unreachable" | "refused" | "unsupported" | "failed";
  status?: number;
  /**
   * With `refused`: the index, among the roots sent for one key, of the root
   * the host would not admit; that request wrote nothing. The client then
   * sends the request once more without that root, so the host can still
   * record the retire for the key's other grants. The host stays here even
   * when that second request records: the refused root was not recorded
   * there. When the second request is refused too, this reports that refusal.
   */
  delegation?: number;
  /** The node's reply or the transport error, at most 200 characters. Diagnostics only. */
  message?: string;
}

/** Per host, what the last sign-out's node calls achieved. */
export interface NodeSignOutStatus {
  /** Hosts that recorded the retire: the session key is refused there. */
  confirmed: string[];
  /** Hosts that answered `recorded: false`: they held no grant for the key. Not confirmed. */
  nothingToRecord: string[];
  notConfirmed: NodeSignOutFailure[];
}

/**
 * The hosts a session's delegations went to, shared by TinyCloudNode and its
 * authorization layer. `onAdd` hears each new host so the owner can save it.
 */
export class SessionHosts {
  private readonly hosts = new Set<string>();
  onAdd?: () => void;

  add(host: string): void {
    if (this.hosts.has(host)) return;
    this.hosts.add(host);
    this.onAdd?.();
  }

  /** Replace the contents without notifying: a restore or a session's end. */
  reset(hosts: Iterable<string> = []): void {
    this.hosts.clear();
    for (const host of hosts) this.hosts.add(host);
  }

  list(): string[] {
    return [...this.hosts];
  }
}

export interface RetireSessionKeyInput {
  signer: SessionRetireSigner;
  hosts: readonly string[];
  /**
   * Every root delegation the client holds for the session key, as the
   * `Authorization` value `/delegate` takes. Sent to every host, so a host
   * that never saw a root still covers it. Each must name the session key as
   * its delegatee: one that does not makes the host refuse the request.
   */
  delegations?: readonly string[];
  /** Node DIDs already known for some hosts (sign-in `/info`, registry). Others are fetched from `/info`. */
  knownNodeIds?: ReadonlyMap<string, string>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A wallet-signed root delegation, with what validation needs to bind it to a session key. */
export type SessionRootProof = Omit<PersistedSessionProof, "jwk" | "spaces" | "verificationMethod">;

/**
 * What sign-out captures from the leaving session before teardown, so the
 * retire can run once the `session-retire` module is loaded.
 */
export interface LeavingSession {
  /** The session key first, then each bootstrap key; a key may repeat. */
  keys: { verificationMethod: string; jwk: object }[];
  hosts: string[];
  knownNodeIds: Map<string, string>;
  /** The wallet-signed roots the client holds that may be one of the keys': the session's own, each bootstrap key's, and each runtime-grant root signed but never posted. */
  roots: SessionRootProof[];
  /** Each installed runtime grant; one with a wallet signature is a root too. */
  grants: PortableDelegation[];
  canonicalizeAddress: (address: string) => string;
  /** Throws unless `proof` is a root of `proof.jwk`'s key. Without it no roots are sent. */
  validate?: (proof: PersistedSessionProof) => unknown;
  /** `bytes` signed with `jwk` (Ed25519). */
  signBytes: (bytes: Uint8Array, jwk: object) => Promise<Uint8Array>;
}

