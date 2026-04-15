export interface PortableDelegationLike {
  cid: string;
  delegationHeader: { Authorization: string };
  spaceId: string;
  path: string;
  actions: string[];
  expiry: Date;
  delegateDID: string;
  ownerAddress: string;
  chainId: number;
  host?: string;
  disableSubDelegation?: boolean;
  publicDelegation?: PortableDelegationLike;
}

export interface TinyCloudVfsSessionData {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  jwk: object;
  verificationMethod: string;
  address?: string;
  chainId?: number;
}

export type TinyCloudVfsSource =
  | {
      kind: "session";
      host: string;
      session: TinyCloudVfsSessionData;
    }
  | {
      kind: "resolved-delegation";
      host: string;
      session: TinyCloudVfsSessionData;
      kvPrefix: string;
    };

export interface TinyCloudVfsOptions {
  mountPoint?: string;
  mountPrefix?: string;
  readOnly?: boolean;
  moduleHooks?: boolean;
  overlay?: boolean;
  virtualCwd?: boolean;
}

export interface TinyCloudVfsProviderOptions {
  source: TinyCloudVfsSource;
  mountPrefix?: string;
  readOnly?: boolean;
}

export interface TinyCloudVfsWorkerInit {
  source: TinyCloudVfsSource;
  mountPrefix: string;
}

export interface TinyCloudVfsMetadata {
  kind: "file" | "directory";
  size: number;
  mode: number;
  ctimeMs: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface TinyCloudVfsFileEnvelope {
  version: 1;
  encoding: "base64";
  data: string;
}

export interface TinyCloudVfsDirent {
  name: string;
  kind: "file" | "directory";
  parentPath: string;
}

export type WorkerRequest =
  | { type: "init"; init: TinyCloudVfsWorkerInit }
  | { type: "stat"; path: string }
  | { type: "readFile"; path: string }
  | { type: "writeFile"; path: string; content: Uint8Array; mode?: number }
  | { type: "readdir"; path: string }
  | { type: "mkdir"; path: string; recursive?: boolean; mode?: number }
  | { type: "rmdir"; path: string }
  | { type: "unlink"; path: string }
  | { type: "rename"; oldPath: string; newPath: string };

export type WorkerResponse =
  | { ok: true; result: null }
  | { ok: true; result: { metadata: TinyCloudVfsMetadata } }
  | { ok: true; result: { content: Uint8Array; metadata: TinyCloudVfsMetadata } }
  | { ok: true; result: { entries: TinyCloudVfsDirent[] } }
  | { ok: false; error: WorkerErrorPayload };

export interface WorkerErrorPayload {
  code: string;
  message: string;
  syscall?: string;
  path?: string;
}

export interface TinyCloudVfsHandleState {
  path: string;
  flags: string;
  mode: number;
  content: Buffer;
  metadata: TinyCloudVfsMetadata;
}

export interface CreateTinyCloudDelegatedVfsOptions extends Omit<TinyCloudVfsOptions, "mountPrefix"> {
  node: TinyCloudNodeLike;
  delegation: PortableDelegationLike;
  mountPrefix?: string;
  host?: string;
}

export interface CreateTinyCloudNodeVfsOptions extends Omit<TinyCloudVfsOptions, "mountPrefix"> {
  mountPrefix?: string;
  host?: string;
}

export interface TinyCloudNodeLike {
  session?: TinyCloudVfsSessionData;
  config?: {
    host?: string;
  };
  useDelegation?: (delegation: PortableDelegationLike) => Promise<{
    session?: TinyCloudVfsSessionData;
    kv: {
      config?: { prefix?: string };
    };
  }>;
}
