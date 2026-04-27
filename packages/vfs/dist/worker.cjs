"use strict";

// src/worker.ts
var import_node_worker_threads = require("worker_threads");
var import_node_sdk = require("@tinycloud/node-sdk");

// src/errors.ts
var ERRNO = {
  EPERM: -1,
  ENOENT: -2,
  EIO: -5,
  EBADF: -9,
  EACCES: -13,
  EBUSY: -16,
  EEXIST: -17,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  ENOTEMPTY: -39,
  EROFS: -30
};
function createNodeError(code, message, syscall, path) {
  const error = new Error(message);
  error.code = code;
  error.errno = ERRNO[code] ?? -1;
  error.syscall = syscall;
  if (path) {
    error.path = path;
  }
  return error;
}
function createENOENT(syscall, path) {
  return createNodeError("ENOENT", `no such file or directory, ${syscall} '${path}'`, syscall, path);
}
function createEISDIR(syscall, path) {
  return createNodeError("EISDIR", `illegal operation on a directory, ${syscall} '${path}'`, syscall, path);
}
function createENOTDIR(syscall, path) {
  return createNodeError("ENOTDIR", `not a directory, ${syscall} '${path}'`, syscall, path);
}
function createENOTEMPTY(syscall, path) {
  return createNodeError("ENOTEMPTY", `directory not empty, ${syscall} '${path}'`, syscall, path);
}
function createEEXIST(syscall, path) {
  return createNodeError("EEXIST", `file already exists, ${syscall} '${path}'`, syscall, path);
}
function createEACCES(syscall, path, message = "permission denied") {
  return createNodeError("EACCES", `${message}, ${syscall} '${path}'`, syscall, path);
}
function createEIO(syscall, path, message) {
  return createNodeError("EIO", `${message}, ${syscall} '${path}'`, syscall, path);
}
function createEBUSY(syscall, path, message = "resource busy or locked") {
  return createNodeError("EBUSY", `${message}, ${syscall} '${path}'`, syscall, path);
}
function createEINVAL(syscall, path, message = "invalid argument") {
  return createNodeError("EINVAL", `${message}, ${syscall} '${path}'`, syscall, path);
}

// src/pathing.ts
var import_node_path = require("path");
var INTERNAL_META_PREFIX = ".tcvfs-meta";
function normalizeVfsPath(inputPath) {
  const normalized = import_node_path.posix.normalize(inputPath.replace(/\\/g, "/"));
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return absolute;
}
function toLogicalPath(inputPath) {
  const normalized = normalizeVfsPath(inputPath);
  if (normalized.includes("\0")) {
    throw new Error("invalid path");
  }
  if (normalized === "/") {
    return "";
  }
  const logical = normalized.slice(1);
  if (logical === INTERNAL_META_PREFIX || logical.startsWith(`${INTERNAL_META_PREFIX}/`) || logical.split("/").includes("..")) {
    throw new Error("path escapes virtual root");
  }
  return logical;
}
function normalizeStoragePrefix(prefix) {
  if (!prefix) {
    return "";
  }
  return prefix.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}
function joinStoragePath(...parts) {
  const cleaned = parts.filter((part) => Boolean(part)).map((part) => normalizeStoragePrefix(part));
  return cleaned.filter(Boolean).join("/");
}
function dirnameOf(logicalPath) {
  if (!logicalPath) {
    return "";
  }
  const dir = import_node_path.posix.dirname(`/${logicalPath}`);
  return dir === "/" ? "" : dir.slice(1);
}

// src/metadata.ts
function dataKey(storageRoot, logicalPath) {
  return joinStoragePath(storageRoot, logicalPath);
}
function metadataKey(storageRoot, logicalPath) {
  return joinStoragePath(storageRoot, INTERNAL_META_PREFIX, logicalPath);
}
function metadataPrefix(storageRoot, logicalPath = "") {
  return joinStoragePath(storageRoot, INTERNAL_META_PREFIX, logicalPath);
}
function encodeEnvelope(content) {
  return {
    version: 1,
    encoding: "base64",
    data: content.toString("base64")
  };
}
function isEnvelopeShape(value) {
  return Boolean(
    value && typeof value === "object" && value.version === 1 && value.encoding === "base64" && typeof value.data === "string"
  );
}
function encodeFileValue(content) {
  const utf8 = content.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(content)) {
    return utf8;
  }
  return encodeEnvelope(content);
}
function decodeEnvelope(value) {
  if (isEnvelopeShape(value)) {
    return Buffer.from(value.data, "base64");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (isEnvelopeShape(parsed)) {
        return Buffer.from(parsed.data, "base64");
      }
    } catch {
    }
    return Buffer.from(value, "utf8");
  }
  throw new Error("unsupported file payload");
}
function isMetadataShape(value) {
  return Boolean(
    value && typeof value === "object" && (value.kind === "file" || value.kind === "directory") && typeof value.size === "number" && typeof value.mode === "number" && typeof value.ctimeMs === "number" && typeof value.mtimeMs === "number" && typeof value.birthtimeMs === "number"
  );
}
function decodeMetadata(value) {
  if (isMetadataShape(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    if (isMetadataShape(parsed)) {
      return parsed;
    }
  }
  throw new Error("unsupported metadata payload");
}
function nowMetadata(kind, size, mode, existing) {
  const now = Date.now();
  return {
    kind,
    size,
    mode,
    ctimeMs: now,
    mtimeMs: now,
    birthtimeMs: existing?.birthtimeMs ?? now
  };
}
function normalizeMode(kind, mode) {
  if (typeof mode === "number" && Number.isFinite(mode)) {
    return mode;
  }
  return kind === "directory" ? 493 : 420;
}
function stripStoragePrefix(fullKey, prefix) {
  const normalizedPrefix = normalizeStoragePrefix(prefix);
  if (!normalizedPrefix) {
    return fullKey.replace(/^\/+/, "");
  }
  const withSlash = `${normalizedPrefix}/`;
  if (fullKey === normalizedPrefix) {
    return "";
  }
  if (fullKey.startsWith(withSlash)) {
    return fullKey.slice(withSlash.length);
  }
  return fullKey;
}

// src/worker.ts
var state = {
  kv: null,
  kvPrefix: "",
  storageRoot: ""
};
function toWorkerError(error) {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const typed = error;
    return {
      ok: false,
      error: {
        code: typed.code ?? "EIO",
        message: typed.message,
        syscall: typed.syscall,
        path: typed.path
      }
    };
  }
  return {
    ok: false,
    error: {
      code: "EIO",
      message: error instanceof Error ? error.message : String(error),
      syscall: "vfs"
    }
  };
}
function ensureKv() {
  if (!state.kv) {
    throw createEIO("init", "/", "worker is not initialized");
  }
  return state.kv;
}
function ensureMountedLogicalPath(inputPath) {
  try {
    return toLogicalPath(inputPath);
  } catch {
    throw createENOENT("resolve", inputPath);
  }
}
function effectiveStorageRoot() {
  return joinStoragePath(state.kvPrefix, state.storageRoot);
}
function effectiveStoragePath(logicalPath = "") {
  return joinStoragePath(effectiveStorageRoot(), logicalPath);
}
function scopedDataKey(logicalPath) {
  return dataKey(effectiveStorageRoot(), logicalPath);
}
function scopedMetaKey(logicalPath) {
  return metadataKey(effectiveStorageRoot(), logicalPath);
}
function scopedMetaPrefix(logicalPath = "") {
  return metadataPrefix(effectiveStorageRoot(), logicalPath);
}
function effectiveListPrefix(logicalPath = "", options) {
  const prefix = effectiveStoragePath(logicalPath);
  if (!options?.trailingSlash || !prefix) {
    return prefix;
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
async function kvGet(key) {
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
async function kvPut(key, value) {
  const kv = ensureKv();
  const result = await kv.put(key, value);
  if (!result.ok) {
    if (result.error?.code === "AUTH_UNAUTHORIZED") {
      throw createEACCES("put", key, result.error.message);
    }
    throw createEIO("put", key, result.error?.message ?? "kv put failed");
  }
}
async function kvDelete(key) {
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
async function kvList(prefix) {
  const kv = ensureKv();
  const listOptions = prefix ? { prefix, removePrefix: false } : { removePrefix: false };
  const result = await kv.list(listOptions);
  if (!result.ok) {
    if (result.error?.code === "AUTH_UNAUTHORIZED") {
      throw createEACCES("scandir", prefix, result.error.message);
    }
    throw createEIO("scandir", prefix, result.error?.message ?? "kv list failed");
  }
  return result.data.keys ?? [];
}
async function tryMetadata(logicalPath) {
  try {
    return decodeMetadata(await kvGet(scopedMetaKey(logicalPath)));
  } catch (error) {
    const typed = error;
    if (typed.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function tryRawFile(logicalPath) {
  try {
    const content = decodeEnvelope(await kvGet(scopedDataKey(logicalPath)));
    const metadata = nowMetadata(
      "file",
      content.length,
      normalizeMode("file")
    );
    return { content, metadata };
  } catch (error) {
    const typed = error;
    if (typed.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function listDescendantKeys(logicalPath) {
  const dataPrefixValue = effectiveListPrefix(logicalPath, { trailingSlash: true });
  const metaPrefixValue = effectiveListPrefix(
    joinStoragePath(".tcvfs-meta", logicalPath),
    { trailingSlash: true }
  );
  const [dataKeys, metaKeys] = await Promise.all([
    kvList(dataPrefixValue),
    kvList(metaPrefixValue)
  ]);
  return { dataKeys, metaKeys };
}
async function tryInferredDirectory(logicalPath) {
  const { dataKeys, metaKeys } = await listDescendantKeys(logicalPath);
  if (dataKeys.length === 0 && metaKeys.length === 0) {
    return null;
  }
  return nowMetadata(
    "directory",
    4096,
    normalizeMode("directory")
  );
}
async function ensureDirectory(logicalPath) {
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
async function readFileEntry(logicalPath) {
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
async function statPath(logicalPath) {
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
async function ensureParentDirectory(logicalPath) {
  const parent = dirnameOf(logicalPath);
  if (!parent) {
    return;
  }
  await ensureDirectory(parent);
}
async function collectDirChildren(logicalPath) {
  await ensureDirectory(logicalPath);
  const { dataKeys, metaKeys } = await listDescendantKeys(logicalPath);
  const names = /* @__PURE__ */ new Set();
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
    [...names].filter((name) => name !== INTERNAL_META_PREFIX).sort().map(async (name) => {
      const childPath = joinStoragePath(logicalPath, name);
      const metadata = await statPath(childPath);
      return {
        name,
        kind: metadata.kind,
        parentPath: logicalPath ? `/${logicalPath}` : "/"
      };
    })
  );
  return entries;
}
async function writeFileEntry(logicalPath, content, mode) {
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
    existing ?? void 0
  );
  await kvPut(scopedDataKey(logicalPath), encodeFileValue(buffer));
  await kvPut(scopedMetaKey(logicalPath), metadata);
  return metadata;
}
async function mkdirEntry(logicalPath, recursive = false, mode) {
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
  const targets = recursive ? segments.map((_, index) => segments.slice(0, index + 1).join("/")) : [logicalPath];
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
async function rmdirEntry(logicalPath) {
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
async function unlinkEntry(logicalPath) {
  const metadata = await statPath(logicalPath);
  if (metadata.kind !== "file") {
    throw createEISDIR("unlink", `/${logicalPath}`);
  }
  await kvDelete(scopedDataKey(logicalPath));
  try {
    await kvDelete(scopedMetaKey(logicalPath));
  } catch (error) {
    const typed = error;
    if (typed.code !== "ENOENT") {
      throw error;
    }
  }
}
async function renameEntry(oldLogicalPath, newLogicalPath) {
  const source = await statPath(oldLogicalPath);
  if (source.kind !== "file") {
    throw createEINVAL("rename", `/${oldLogicalPath}`, "directory rename is not supported in v1");
  }
  const content = decodeEnvelope(await kvGet(scopedDataKey(oldLogicalPath)));
  await writeFileEntry(newLogicalPath, content, source.mode);
  await unlinkEntry(oldLogicalPath);
}
async function initialize(init) {
  const node = new import_node_sdk.TinyCloudNode({ host: init.source.host });
  await node.restoreSession(init.source.session);
  const kv = node.kv;
  const servicePrefix = init.source.kind === "resolved-delegation" ? normalizeStoragePrefix(init.source.kvPrefix) : normalizeStoragePrefix(kv.config?.prefix);
  const mountPrefix = normalizeStoragePrefix(init.mountPrefix);
  state.kv = kv;
  state.kvPrefix = servicePrefix;
  state.storageRoot = mountPrefix;
}
async function handleRequest(request) {
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
import_node_worker_threads.parentPort?.on("message", async (message) => {
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
//# sourceMappingURL=worker.cjs.map