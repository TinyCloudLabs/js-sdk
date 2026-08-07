import type { ClientSession, IKVService } from "@tinycloud/sdk-core";
import type { CredentialsService } from "../credentials";

export type ShareReceiverIdentity =
  | { readonly kind: "account"; readonly holderDid: string }
  | { readonly kind: "receiver"; readonly holderDid: string; readonly custody: "session"; readonly origin: string };

export type ShareReceiveProgress =
  | { readonly state: "identity-selection"; readonly status: "started" | "completed"; readonly identity?: ShareReceiverIdentity }
  | { readonly state: "credential-acquisition"; readonly status: "started" | "completed" }
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

export interface ReceivedShare {
  readonly identity: ShareReceiverIdentity;
  readonly shareId: string;
  get(): Promise<ShareReceivedContent>;
  importInto(accountClient: ShareImportAccountClient, options: ShareImportOptions): Promise<ShareImportResult>;
}

export interface ShareReceiverClient extends ShareImportAccountClient {
  readonly credentialHolderDid: string;
  readonly credentialHolderKid: string;
  readonly credentials: CredentialsService;
  restorePersistedSession(): Promise<{ readonly status: string; readonly session?: ClientSession }>;
  restoreSession(): Promise<{ readonly status: string; readonly session?: ClientSession }>;
  signSessionBytes(bytes: Uint8Array): Promise<Uint8Array>;
}
