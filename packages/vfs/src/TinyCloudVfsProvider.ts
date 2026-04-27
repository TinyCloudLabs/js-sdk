import { Buffer } from "node:buffer";
import { VirtualProvider, create } from "@platformatic/vfs";
import type { VirtualFileSystem } from "@platformatic/vfs";
import { TinyCloudVfsBridge } from "./bridge";
import {
  createEISDIR,
  createEROFS,
  fromWorkerError,
} from "./errors";
import { wrapVfsWithFsWritePatches } from "./fsPatch";
import { normalizeMode } from "./metadata";
import { normalizeVfsPath } from "./pathing";
import type {
  CreateTinyCloudDelegatedVfsOptions,
  CreateTinyCloudNodeVfsOptions,
  TinyCloudVfsDirent,
  TinyCloudVfsMetadata,
  TinyCloudVfsOptions,
  TinyCloudVfsProviderOptions,
  TinyCloudVfsSource,
  TinyCloudVfsHandleState,
  TinyCloudNodeLike,
  WorkerResponse,
} from "./types";

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const DEFAULT_BLOCK_SIZE = 4096;

function createStats(metadata: TinyCloudVfsMetadata) {
  const mode = metadata.kind === "directory"
    ? (metadata.mode | S_IFDIR)
    : (metadata.mode | S_IFREG);

  return {
    dev: 0,
    mode,
    nlink: 1,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    rdev: 0,
    blksize: DEFAULT_BLOCK_SIZE,
    ino: 0,
    size: metadata.kind === "directory" ? DEFAULT_BLOCK_SIZE : metadata.size,
    blocks: metadata.kind === "directory" ? 8 : Math.ceil(metadata.size / 512),
    atimeMs: metadata.mtimeMs,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    birthtimeMs: metadata.birthtimeMs,
    atime: new Date(metadata.mtimeMs),
    mtime: new Date(metadata.mtimeMs),
    ctime: new Date(metadata.ctimeMs),
    birthtime: new Date(metadata.birthtimeMs),
    isFile: () => metadata.kind === "file",
    isDirectory: () => metadata.kind === "directory",
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function createDirent(entry: TinyCloudVfsDirent) {
  return {
    name: entry.name,
    parentPath: entry.parentPath,
    path: entry.parentPath,
    isFile: () => entry.kind === "file",
    isDirectory: () => entry.kind === "directory",
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function expectStatResult(response: WorkerResponse): TinyCloudVfsMetadata {
  if (!response.ok) {
    throw fromWorkerError(response.error);
  }
  if (!response.result || !("metadata" in response.result)) {
    throw new Error("worker returned an unexpected stat payload");
  }
  return response.result.metadata;
}

function expectReadFileResult(response: WorkerResponse): { metadata: TinyCloudVfsMetadata; content: Uint8Array } {
  if (!response.ok) {
    throw fromWorkerError(response.error);
  }
  if (!response.result || !("metadata" in response.result) || !("content" in response.result)) {
    throw new Error("worker returned an unexpected readFile payload");
  }
  return response.result;
}

function expectReaddirResult(response: WorkerResponse): TinyCloudVfsDirent[] {
  if (!response.ok) {
    throw fromWorkerError(response.error);
  }
  if (!response.result || !("entries" in response.result)) {
    throw new Error("worker returned an unexpected readdir payload");
  }
  return response.result.entries;
}

function isWriteFlag(flags = "r"): boolean {
  return /[wa+]/.test(flags);
}

function isAppendFlag(flags = "r"): boolean {
  return flags.startsWith("a");
}

function isTruncateFlag(flags = "r"): boolean {
  return flags.startsWith("w");
}

class TinyCloudVfsFileHandle {
  private readonly bridge: TinyCloudVfsBridge;
  private readonly state: TinyCloudVfsHandleState;
  private closed = false;
  private dirty = false;
  private position = 0;

  constructor(bridge: TinyCloudVfsBridge, state: TinyCloudVfsHandleState) {
    this.bridge = bridge;
    this.state = state;

    if (isAppendFlag(state.flags)) {
      this.position = state.content.length;
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("file handle is closed");
    }
  }

  private commit(): void {
    if (!this.dirty) {
      return;
    }

    const response = this.bridge.requestSync({
      type: "writeFile",
      path: this.state.path,
      content: this.state.content,
      mode: this.state.mode,
    });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
    this.dirty = false;
  }

  readSync(buffer: Buffer, offset: number, length: number, position: number | null): number {
    this.ensureOpen();
    const readFrom = position ?? this.position;
    const available = Math.max(0, this.state.content.length - readFrom);
    const bytesToRead = Math.min(length, available);
    if (bytesToRead === 0) {
      return 0;
    }

    this.state.content.copy(buffer, offset, readFrom, readFrom + bytesToRead);
    if (position === null || position === undefined) {
      this.position = readFrom + bytesToRead;
    }
    return bytesToRead;
  }

  writeSync(buffer: Buffer, offset: number, length: number, position: number | null): number {
    this.ensureOpen();
    const writeFrom = position ?? this.position;
    const data = buffer.subarray(offset, offset + length);
    const requiredLength = writeFrom + data.length;

    if (requiredLength > this.state.content.length) {
      const next = Buffer.alloc(requiredLength);
      this.state.content.copy(next, 0, 0, this.state.content.length);
      this.state.content = next;
    }

    data.copy(this.state.content, writeFrom);
    this.state.metadata = {
      ...this.state.metadata,
      size: this.state.content.length,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
    };
    this.dirty = true;

    if (position === null || position === undefined) {
      this.position = writeFrom + data.length;
    }

    return data.length;
  }

  readFileSync(options?: BufferEncoding | { encoding?: BufferEncoding | null } | null): Buffer | string {
    this.ensureOpen();
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (encoding) {
      return this.state.content.toString(encoding);
    }
    return Buffer.from(this.state.content);
  }

  writeFileSync(data: string | Buffer, options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number }): void {
    this.ensureOpen();
    const encoding = typeof options === "string" ? options : options?.encoding;
    const buffer = typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data);

    if (isAppendFlag(this.state.flags)) {
      this.state.content = Buffer.concat([this.state.content, buffer]);
    } else {
      this.state.content = Buffer.from(buffer);
    }

    this.state.metadata = {
      ...this.state.metadata,
      size: this.state.content.length,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      mode: normalizeMode("file", typeof options === "object" ? options?.mode : this.state.mode),
    };
    this.dirty = true;
    this.position = this.state.content.length;
  }

  statSync() {
    this.ensureOpen();
    return createStats({
      ...this.state.metadata,
      size: this.state.content.length,
    });
  }

  closeSync(): void {
    this.ensureOpen();
    this.commit();
    this.closed = true;
  }
}

export class TinyCloudVfsProvider extends VirtualProvider {
  private readonly bridge: TinyCloudVfsBridge;
  private readonly forceReadOnly: boolean;

  constructor(options: TinyCloudVfsProviderOptions) {
    super();
    this.forceReadOnly = options.readOnly === true;
    this.bridge = new TinyCloudVfsBridge({
      source: options.source,
      mountPrefix: options.mountPrefix ?? "",
    });
  }

  get readonly(): boolean {
    return this.forceReadOnly;
  }

  close(): void {
    this.bridge.close();
  }

  private ensureWritable(path: string, syscall: string): void {
    if (this.forceReadOnly) {
      throw createEROFS(syscall, path);
    }
  }

  private normalize(path: string): string {
    return normalizeVfsPath(path);
  }

  openSync(path: string, flags = "r", mode?: number) {
    const normalized = this.normalize(path);
    const writable = isWriteFlag(flags);

    if (writable) {
      this.ensureWritable(normalized, "open");
    }

    let metadata: TinyCloudVfsMetadata;
    let content = Buffer.alloc(0);

    try {
      const response = expectReadFileResult(this.bridge.requestSync({ type: "readFile", path: normalized }));
      metadata = response.metadata;
      content = Buffer.from(response.content);
      if (isTruncateFlag(flags)) {
        content = Buffer.alloc(0);
        metadata = {
          ...metadata,
          size: 0,
          mode: normalizeMode("file", mode ?? metadata.mode),
        };
      }
    } catch (error) {
      const typed = error as NodeJS.ErrnoException;
      if (typed.code !== "ENOENT" || !writable) {
        throw error;
      }

      metadata = {
        kind: "file",
        size: 0,
        mode: normalizeMode("file", mode),
        ctimeMs: Date.now(),
        mtimeMs: Date.now(),
        birthtimeMs: Date.now(),
      };
    }

    if (metadata.kind !== "file") {
      throw createEISDIR("open", normalized);
    }

    return new TinyCloudVfsFileHandle(this.bridge, {
      path: normalized,
      flags,
      mode: normalizeMode("file", mode ?? metadata.mode),
      content,
      metadata,
    });
  }

  async open(path: string, flags = "r", mode?: number) {
    return this.openSync(path, flags, mode);
  }

  statSync(path: string) {
    const normalized = this.normalize(path);
    return createStats(expectStatResult(this.bridge.requestSync({ type: "stat", path: normalized })));
  }

  async stat(path: string) {
    return this.statSync(path);
  }

  lstatSync(path: string) {
    return this.statSync(path);
  }

  async lstat(path: string) {
    return this.lstatSync(path);
  }

  readdirSync(path: string, options?: { withFileTypes?: boolean }) {
    const normalized = this.normalize(path);
    const entries = expectReaddirResult(this.bridge.requestSync({ type: "readdir", path: normalized }));

    if (options?.withFileTypes) {
      return entries.map(createDirent);
    }

    return entries.map((entry: TinyCloudVfsDirent) => entry.name);
  }

  async readdir(path: string, options?: { withFileTypes?: boolean }) {
    return this.readdirSync(path, options);
  }

  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }) {
    const normalized = this.normalize(path);
    this.ensureWritable(normalized, "mkdir");
    const response = this.bridge.requestSync({
      type: "mkdir",
      path: normalized,
      recursive: options?.recursive === true,
      mode: options?.mode,
    });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
    return options?.recursive ? normalized : undefined;
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }) {
    return this.mkdirSync(path, options);
  }

  rmdirSync(path: string) {
    const normalized = this.normalize(path);
    this.ensureWritable(normalized, "rmdir");
    const response = this.bridge.requestSync({ type: "rmdir", path: normalized });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
  }

  async rmdir(path: string) {
    this.rmdirSync(path);
  }

  unlinkSync(path: string) {
    const normalized = this.normalize(path);
    this.ensureWritable(normalized, "unlink");
    const response = this.bridge.requestSync({ type: "unlink", path: normalized });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
  }

  async unlink(path: string) {
    this.unlinkSync(path);
  }

  renameSync(oldPath: string, newPath: string) {
    const normalizedOld = this.normalize(oldPath);
    const normalizedNew = this.normalize(newPath);
    this.ensureWritable(normalizedOld, "rename");
    const response = this.bridge.requestSync({
      type: "rename",
      oldPath: normalizedOld,
      newPath: normalizedNew,
    });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
  }

  async rename(oldPath: string, newPath: string) {
    this.renameSync(oldPath, newPath);
  }
}

function toSessionSource(node: TinyCloudNodeLike, host?: string): TinyCloudVfsSource {
  if (!node.session) {
    throw new Error("TinyCloudNode has no active session; call signIn() or restoreSession() first.");
  }

  const resolvedHost = host ?? node.config?.host ?? "https://node.tinycloud.xyz";

  return {
    kind: "session",
    host: resolvedHost,
    session: node.session,
  };
}

export function createTinyCloudVfs(options: TinyCloudVfsProviderOptions & TinyCloudVfsOptions): { provider: TinyCloudVfsProvider; vfs: VirtualFileSystem } {
  const provider = new TinyCloudVfsProvider(options);
  const vfs = wrapVfsWithFsWritePatches(create(provider, {
    moduleHooks: options.moduleHooks,
    overlay: options.overlay,
    virtualCwd: options.virtualCwd,
  }));

  if (options.mountPoint) {
    vfs.mount(options.mountPoint);
  }

  return { provider, vfs };
}

export function createTinyCloudVfsFromNode(node: TinyCloudNodeLike, options: CreateTinyCloudNodeVfsOptions = {}) {
  return createTinyCloudVfs({
    ...options,
    source: toSessionSource(node, options.host),
  });
}

export async function createTinyCloudDelegatedVfs(options: CreateTinyCloudDelegatedVfsOptions) {
  if (!options.node.session) {
    throw new Error("TinyCloudNode has no active session; call signIn() or restoreSession() first.");
  }
  if (typeof options.node.useDelegation !== "function") {
    throw new Error("TinyCloudNode does not expose useDelegation().");
  }

  const access = await options.node.useDelegation(options.delegation);
  if (!access?.session) {
    throw new Error("Delegated access does not expose a resolved session snapshot.");
  }

  return createTinyCloudVfs({
    ...options,
    source: {
      kind: "resolved-delegation",
      host: options.host ?? options.delegation.host ?? "https://node.tinycloud.xyz",
      session: access.session,
      kvPrefix: access.kv?.config?.prefix ?? "",
    },
  });
}
