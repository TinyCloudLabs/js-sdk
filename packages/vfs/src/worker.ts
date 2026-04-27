import { parentPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { createEACCES, createEEXIST, createEIO, createEISDIR, createENOTDIR, createENOTEMPTY, createENOENT, createEINVAL, createEBUSY } from "./errors";
import { dirnameOf, INTERNAL_META_PREFIX, joinStoragePath, normalizeStoragePrefix, toLogicalPath } from "./pathing";
import { dataKey, decodeEnvelope, decodeMetadata, encodeFileValue, metadataKey, metadataPrefix, normalizeMode, nowMetadata, stripStoragePrefix } from "./metadata";
import type {
  TinyCloudVfsDirent,
  TinyCloudVfsMetadata,
  TinyCloudVfsSource,
  TinyCloudVfsWorkerInit,
  WorkerRequest,
  WorkerResponse,
} from "./types";

type KvLike = {
  config?: { prefix?: string };
  get: (key: string, options?: Record<string, unknown>) => Promise<any>;
  put: (key: string, value: unknown, options?: Record<string, unknown>) => Promise<any>;
  list: (options?: Record<string, unknown>) => Promise<any>;
  delete: (key: string, options?: Record<string, unknown>) => Promise<any>;
};

interface WorkerState {
  kv: KvLike | null;
  kvPrefix: string;
  storageRoot: string;
}

const state: WorkerState = {
  kv: null,
  kvPrefix: "",
  storageRoot: "",
};

function toWorkerError(error: unknown): WorkerResponse {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const typed = error as NodeJS.ErrnoException;
    return {
      ok: false,
      error: {
        code: typed.code ?? "EIO",
        message: typed.message,
        syscall: typed.syscall,
        path: typed.path,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "EIO",
      message: error instanceof Error ? error.message : String(error),
      syscall: "vfs",
    },
  };
}

function ensureKv(): KvLike {
  if (!state.kv) {
    throw createEIO("init", "/", "worker is not initialized");
  }
  return state.kv;
}

function ensureMountedLogicalPath(inputPath: string): string {
  try {
    return toLogicalPath(inputPath);
  } catch {
    throw createENOENT("resolve", inputPath);
  }
}

function effectiveStorageRoot(): string {
  return joinStoragePath(state.kvPrefix, state.storageRoot);
}

function effectiveStoragePath(logicalPath = ""): string {
  return joinStoragePath(effectiveStorageRoot(), logicalPath);
}

function scopedDataKey(logicalPath: string): string {
  return dataKey(effectiveStorageRoot(), logicalPath);
}

function scopedMetaKey(logicalPath: string): string {
  return metadataKey(effectiveStorageRoot(), logicalPath);
}

function scopedMetaPrefix(logicalPath = ""): string {
  return metadataPrefix(effectiveStorageRoot(), logicalPath);
}

function effectiveListPrefix(logicalPath = "", options?: { trailingSlash?: boolean }): string {
  const prefix = effectiveStoragePath(logicalPath);
  if (!options?.trailingSlash || !prefix) {
    return prefix;
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

async function kvGet(key: string): Promise<unknown> {
  const kv = ensureKv();
  const result = await kv.get(key);
  if (!result.ok) {
    if (result.error?.code === "KV_NOT_FOUND") {
      throw createENOENT("get", key);
    }
    if (result.error?.code === "AUTH_UNAUTHORIZED") {
      throw createEACCES("get", key, result.error.message);
    }
    throw createEIO("get", key, result.error?.message ?? "kv get failed");
  }

  return result.data.data;
}

async function kvPut(key: string, value: unknown): Promise<void> {
  const kv = ensureKv();
  const result = await kv.put(key, value);
  if (!result.ok) {
    if (result.error?.code === "AUTH_UNAUTHORIZED") {
      throw createEACCES("put", key, result.error.message);
    }
    throw createEIO("put", key, result.error?.message ?? "kv put failed");
  }
}

async function kvDelete(key: string): Promise<void> {
  const kv = ensureKv();
  const result = await kv.delete(key);
  if (!result.ok) {
    if (result.error?.code === "KV_NOT_FOUND") {
      throw createENOENT("unlink", key);
    }
    if (result.error?.code === "AUTH_UNAUTHORIZED") {
      throw createEACCES("unlink", key, result.error.message);
    }
    throw createEIO("unlink", key, result.error?.message ?? "kv delete failed");
  }
}

async function kvList(prefix: string): Promise<string[]> {
  const kv = ensureKv();
  const listOptions = prefix
    ? { prefix, removePrefix: false }
    : { removePrefix: false };
  const result = await kv.list(listOptions);
  if (!result.ok) {
    if (result.error?.code === "AUTH_UNAUTHORIZED") {
      throw createEACCES("scandir", prefix, result.error.message);
    }
    throw createEIO("scandir", prefix, result.error?.message ?? "kv list failed");
  }
  return result.data.keys ?? [];
}

async function tryMetadata(logicalPath: string): Promise<TinyCloudVfsMetadata | null> {
  try {
    return decodeMetadata(await kvGet(scopedMetaKey(logicalPath)));
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function tryRawFile(logicalPath: string): Promise<{ content: Buffer; metadata: TinyCloudVfsMetadata } | null> {
  try {
    const content = decodeEnvelope(await kvGet(scopedDataKey(logicalPath)));
    const metadata = nowMetadata(
      "file",
      content.length,
      normalizeMode("file"),
    );
    return { content, metadata };
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listDescendantKeys(logicalPath: string): Promise<{ dataKeys: string[]; metaKeys: string[] }> {
  const dataPrefixValue = effectiveListPrefix(logicalPath, { trailingSlash: true });
  const metaPrefixValue = effectiveListPrefix(
    joinStoragePath(".tcvfs-meta", logicalPath),
    { trailingSlash: true },
  );

  const [dataKeys, metaKeys] = await Promise.all([
    kvList(dataPrefixValue),
    kvList(metaPrefixValue),
  ]);

  return { dataKeys, metaKeys };
}

async function tryInferredDirectory(logicalPath: string): Promise<TinyCloudVfsMetadata | null> {
  const { dataKeys, metaKeys } = await listDescendantKeys(logicalPath);
  if (dataKeys.length === 0 && metaKeys.length === 0) {
    return null;
  }

  return nowMetadata(
    "directory",
    4096,
    normalizeMode("directory"),
  );
}

async function ensureDirectory(logicalPath: string): Promise<TinyCloudVfsMetadata> {
  if (!logicalPath) {
    return nowMetadata("directory", 4096, normalizeMode("directory"));
  }

  const metadata = await tryMetadata(logicalPath);
  if (metadata) {
    if (metadata.kind !== "directory") {
      throw createENOTDIR("stat", `/${logicalPath}`);
    }
    return metadata;
  }

  const inferred = await tryInferredDirectory(logicalPath);
  if (!inferred) {
    throw createENOENT("stat", `/${logicalPath}`);
  }
  return inferred;
}

async function readFileEntry(logicalPath: string): Promise<{ content: Buffer; metadata: TinyCloudVfsMetadata }> {
  const metadata = await tryMetadata(logicalPath);
  if (metadata) {
    if (metadata.kind !== "file") {
      throw createEISDIR("open", `/${logicalPath}`);
    }

    const content = decodeEnvelope(await kvGet(scopedDataKey(logicalPath)));
    return { content, metadata };
  }

  const rawFile = await tryRawFile(logicalPath);
  if (rawFile) {
    return rawFile;
  }

  if (await tryInferredDirectory(logicalPath)) {
    throw createEISDIR("open", `/${logicalPath}`);
  }

  throw createENOENT("open", `/${logicalPath}`);
}

async function statPath(logicalPath: string): Promise<TinyCloudVfsMetadata> {
  if (!logicalPath) {
    return nowMetadata("directory", 4096, normalizeMode("directory"));
  }

  const metadata = await tryMetadata(logicalPath);
  if (metadata) {
    return metadata;
  }

  const rawFile = await tryRawFile(logicalPath);
  if (rawFile) {
    return rawFile.metadata;
  }

  const inferredDirectory = await tryInferredDirectory(logicalPath);
  if (inferredDirectory) {
    return inferredDirectory;
  }

  throw createENOENT("stat", `/${logicalPath}`);
}

async function ensureParentDirectory(logicalPath: string): Promise<void> {
  const parent = dirnameOf(logicalPath);
  if (!parent) {
    return;
  }
  await ensureDirectory(parent);
}

async function collectDirChildren(logicalPath: string): Promise<TinyCloudVfsDirent[]> {
  await ensureDirectory(logicalPath);

  const { dataKeys, metaKeys } = await listDescendantKeys(logicalPath);

  const names = new Set<string>();
  const relativePrefix = effectiveStoragePath(logicalPath);
  const relativeMetaPrefix = scopedMetaPrefix(logicalPath);

  for (const fullKey of dataKeys) {
    const relative = stripStoragePrefix(fullKey, relativePrefix);
    const first = relative.split("/").filter(Boolean)[0];
    if (first) {
      names.add(first);
    }
  }

  for (const fullKey of metaKeys) {
    const relative = stripStoragePrefix(fullKey, relativeMetaPrefix);
    const first = relative.split("/").filter(Boolean)[0];
    if (first) {
      names.add(first);
    }
  }

  const entries = await Promise.all(
    [...names]
      .filter((name) => name !== INTERNAL_META_PREFIX)
      .sort()
      .map(async (name): Promise<TinyCloudVfsDirent> => {
        const childPath = joinStoragePath(logicalPath, name);
        const metadata = await statPath(childPath);
        return {
          name,
          kind: metadata.kind,
          parentPath: logicalPath ? `/${logicalPath}` : "/",
        };
      }),
  );

  return entries;
}

async function writeFileEntry(logicalPath: string, content: Uint8Array, mode?: number): Promise<TinyCloudVfsMetadata> {
  await ensureParentDirectory(logicalPath);
  const existing = await tryMetadata(logicalPath);
  if (existing) {
    if (existing.kind !== "file") {
      throw createEISDIR("writeFile", `/${logicalPath}`);
    }
  } else if (await tryInferredDirectory(logicalPath)) {
    throw createEISDIR("writeFile", `/${logicalPath}`);
  }

  const buffer = Buffer.from(content);
  const metadata = nowMetadata(
    "file",
    buffer.length,
    normalizeMode("file", mode ?? existing?.mode),
    existing ?? undefined,
  );

  await kvPut(scopedDataKey(logicalPath), encodeFileValue(buffer));
  await kvPut(scopedMetaKey(logicalPath), metadata);
  return metadata;
}

async function mkdirEntry(logicalPath: string, recursive = false, mode?: number): Promise<void> {
  if (!logicalPath) {
    return;
  }

  const existing = await tryMetadata(logicalPath);
  if (existing) {
    if (existing.kind === "directory") {
      return;
    }
    throw createEEXIST("mkdir", `/${logicalPath}`);
  }

  if (await tryRawFile(logicalPath)) {
    throw createEEXIST("mkdir", `/${logicalPath}`);
  }

  if (await tryInferredDirectory(logicalPath)) {
    return;
  }

  const segments = logicalPath.split("/").filter(Boolean);
  const targets = recursive
    ? segments.map((_, index) => segments.slice(0, index + 1).join("/"))
    : [logicalPath];

  for (const target of targets) {
    const current = await tryMetadata(target);
    if (current) {
      if (current.kind !== "directory") {
        throw createENOTDIR("mkdir", `/${target}`);
      }
      continue;
    }

    await ensureParentDirectory(target);
    const metadata = nowMetadata("directory", 4096, normalizeMode("directory", mode));
    await kvPut(scopedMetaKey(target), metadata);
  }
}

async function rmdirEntry(logicalPath: string): Promise<void> {
  if (!logicalPath) {
    throw createEBUSY("rmdir", "/");
  }

  const metadata = await ensureDirectory(logicalPath);
  const children = await collectDirChildren(logicalPath);
  if (children.length > 0) {
    throw createENOTEMPTY("rmdir", `/${logicalPath}`);
  }

  await kvDelete(scopedMetaKey(logicalPath));
}

async function unlinkEntry(logicalPath: string): Promise<void> {
  const metadata = await statPath(logicalPath);
  if (metadata.kind !== "file") {
    throw createEISDIR("unlink", `/${logicalPath}`);
  }

  await kvDelete(scopedDataKey(logicalPath));
  try {
    await kvDelete(scopedMetaKey(logicalPath));
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code !== "ENOENT") {
      throw error;
    }
  }
}

async function renameEntry(oldLogicalPath: string, newLogicalPath: string): Promise<void> {
  const source = await statPath(oldLogicalPath);
  if (source.kind !== "file") {
    throw createEINVAL("rename", `/${oldLogicalPath}`, "directory rename is not supported in v1");
  }

  const content = decodeEnvelope(await kvGet(scopedDataKey(oldLogicalPath)));
  await writeFileEntry(newLogicalPath, content, source.mode);
  await unlinkEntry(oldLogicalPath);
}

async function initialize(init: TinyCloudVfsWorkerInit): Promise<void> {
  const node = new TinyCloudNode({ host: init.source.host });
  await node.restoreSession(init.source.session);

  const kv = node.kv as unknown as KvLike;
  const servicePrefix = init.source.kind === "resolved-delegation"
    ? normalizeStoragePrefix(init.source.kvPrefix)
    : normalizeStoragePrefix(kv.config?.prefix);
  const mountPrefix = normalizeStoragePrefix(init.mountPrefix);

  state.kv = kv;
  state.kvPrefix = servicePrefix;
  state.storageRoot = mountPrefix;
}

async function handleRequest(request: WorkerRequest): Promise<WorkerResponse> {
  switch (request.type) {
    case "init":
      await initialize(request.init);
      return { ok: true, result: null };
    case "stat": {
      const logicalPath = ensureMountedLogicalPath(request.path);
      const metadata = await statPath(logicalPath);
      return { ok: true, result: { metadata } };
    }
    case "readFile": {
      const logicalPath = ensureMountedLogicalPath(request.path);
      const { content, metadata } = await readFileEntry(logicalPath);
      return { ok: true, result: { content, metadata } };
    }
    case "writeFile": {
      const logicalPath = ensureMountedLogicalPath(request.path);
      await writeFileEntry(logicalPath, request.content, request.mode);
      return { ok: true, result: null };
    }
    case "readdir": {
      const logicalPath = ensureMountedLogicalPath(request.path);
      const entries = await collectDirChildren(logicalPath);
      return { ok: true, result: { entries } };
    }
    case "mkdir": {
      const logicalPath = ensureMountedLogicalPath(request.path);
      await mkdirEntry(logicalPath, request.recursive, request.mode);
      return { ok: true, result: null };
    }
    case "rmdir": {
      const logicalPath = ensureMountedLogicalPath(request.path);
      await rmdirEntry(logicalPath);
      return { ok: true, result: null };
    }
    case "unlink": {
      const logicalPath = ensureMountedLogicalPath(request.path);
      await unlinkEntry(logicalPath);
      return { ok: true, result: null };
    }
    case "rename": {
      const oldLogicalPath = ensureMountedLogicalPath(request.oldPath);
      const newLogicalPath = ensureMountedLogicalPath(request.newPath);
      await renameEntry(oldLogicalPath, newLogicalPath);
      return { ok: true, result: null };
    }
    default:
      throw createEINVAL("vfs", "/");
  }
}

parentPort?.on("message", async (message: { request: WorkerRequest; replyPort: MessagePort; waitBuffer: SharedArrayBuffer }) => {
  const view = new Int32Array(message.waitBuffer);

  try {
    const response = await handleRequest(message.request);
    message.replyPort.postMessage(response);
  } catch (error) {
    message.replyPort.postMessage(toWorkerError(error));
  } finally {
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0, 1);
    message.replyPort.close();
  }
});
