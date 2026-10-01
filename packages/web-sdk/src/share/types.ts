import type { ClientSession, IKVService } from "@tinycloud/sdk-core";
import type { ShareMetadata } from "@tinycloud/share-sdk";
import type { CredentialsService } from "../credentials";

export type ShareReceiverIdentity =
  | { readonly kind: "account"; readonly holderDid: string }
  | { readonly kind: "receiver"; readonly holderDid: string; readonly custody: "session"; readonly origin: string };

export type ShareReceiveProgress =
  | { readonly state: "identity-selection"; readonly status: "started" | "completed"; readonly identity?: ShareReceiverIdentity }
  | { readonly state: "credential-acquisition"; readonly status: "started" | "completed"; readonly mailbox?: string }
  | { readonly state: "policy-admission"; readonly status: "started" | "completed" }
  | { readonly state: "delegation-import"; readonly status: "started" | "completed" }
  | { readonly state: "invocation"; readonly status: "started" | "completed" }
  | { readonly state: "decryption"; readonly status: "started" | "completed" }
  | { readonly state: "ready"; readonly status: "completed" }
  | { readonly state: "import"; readonly status: "started" | "completed" };

export interface ShareReceiveOptions {
  readonly identity: "auto" | "account" | "receiver";
  readonly interaction: { readonly kind: "inline"; readonly mountTarget: Element | string };
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ShareReceiveProgress) => void;
  /**
   * Open through access another recipient delegated to this identity's key,
   * instead of proving a credential.
   */
  readonly delegation?: ShareDelegation;
}

/** One signed link of a share's delegation chain. The owner's Node holds it too. */
export interface ShareDelegationLink {
  readonly authorization: string;
  readonly cid: string;
}

/**
 * A share's access re-delegated to another key: the admitted session first,
 * then each re-delegation in order. It holds no secret; only the key it names
 * can use it.
 */
export interface ShareDelegation {
  readonly shareId: string;
  readonly delegateDid: string;
  readonly expiresAt: string;
  readonly chain: readonly ShareDelegationLink[];
}

export interface ShareDelegateOptions {
  /** DID of the key that should hold this share's access, such as an account session key. */
  readonly to: string;
  /** Defaults to the longest the current access allows. */
  readonly expiresAt?: Date;
  readonly signal?: AbortSignal;
}

export interface ShareReceivedContent {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
  readonly senderDid: string;
  readonly shareId: string;
  readonly byteDigest: string;
  readonly receivedAt: string;
}

export interface ShareImportOptions {
  readonly namespace: "files-for-you";
  readonly filename?: string;
  readonly signal?: AbortSignal;
}

export interface ShareImportResult {
  readonly status: "imported" | "existing";
  readonly path: string;
  readonly byteDigest: string;
}

export interface ShareImportAccountClient {
  session(): ClientSession | undefined;
  ensureOwnedSpaceHosted(name: string): Promise<string>;
  kvForSpace(spaceId: string): IKVService;
}

/**
 * The recipient an invitation is addressed to. It comes from the signed,
 * sealed invitation and is checked against the policy's credential
 * requirement commitment before `receive` returns, so a host may display it.
 */
export type ShareReceiverRecipient =
  | { readonly kind: "exactEmail"; readonly email: string }
  /** Anyone who proves a mailbox whose issuer-derived domain equals `domain` exactly. */
  | { readonly kind: "emailDomain"; readonly domain: string };

export interface ReceivedShare {
  readonly identity: ShareReceiverIdentity;
  readonly recipient: ShareReceiverRecipient;
  readonly metadata: ShareMetadata;
  readonly shareId: string;
  get(): Promise<ShareReceivedContent>;
  importInto(accountClient: ShareImportAccountClient, options: ShareImportOptions): Promise<ShareImportResult>;
  /**
   * Re-delegate this share's access, including decryption, to another key.
   * Proves the credential first if this share has not been opened yet. The
   * delegate opens it with `receive(url, { delegation })`.
   */
  delegate(options: ShareDelegateOptions): Promise<ShareDelegation>;
}

export interface ShareReceiverClient extends ShareImportAccountClient {
  readonly credentialHolderDid: string;
  readonly credentialHolderKid: string;
  readonly credentials: CredentialsService;
  restoreSession(): Promise<{ readonly status: string; readonly session?: ClientSession }>;
  signSessionBytes(bytes: Uint8Array): Promise<Uint8Array>;
}
