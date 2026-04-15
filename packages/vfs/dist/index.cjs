"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  TinyCloudVfsProvider: () => TinyCloudVfsProvider,
  createTinyCloudDelegatedVfs: () => createTinyCloudDelegatedVfs,
  createTinyCloudVfs: () => createTinyCloudVfs,
  createTinyCloudVfsFromNode: () => createTinyCloudVfsFromNode
});
module.exports = __toCommonJS(index_exports);

// src/TinyCloudVfsProvider.ts
var import_node_buffer = require("buffer");
var import_vfs = require("@platformatic/vfs");

// src/bridge.ts
var import_node_worker_threads = require("worker_threads");
var import_node_path = require("path");

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
function createEISDIR(syscall, path) {
  return createNodeError("EISDIR", `illegal operation on a directory, ${syscall} '${path}'`, syscall, path);
}
function createEROFS(syscall, path) {
  return createNodeError("EROFS", `read-only file system, ${syscall} '${path}'`, syscall, path);
}
function createEIO(syscall, path, message) {
  return createNodeError("EIO", `${message}, ${syscall} '${path}'`, syscall, path);
}
function fromWorkerError(error) {
  return createNodeError(
    error.code,
    error.message,
    error.syscall ?? "vfs",
    error.path
  );
}

// src/bridge.ts
var import_meta = {};
var WAIT_SLICE_MS = 1e3;
function createWaitSignal() {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  return {
    buffer,
    view: new Int32Array(buffer)
  };
}
function resolveWorkerSpecifier() {
  if (typeof __dirname !== "undefined") {
    return (0, import_node_path.join)(__dirname, "worker.cjs");
  }
  return new URL("./worker.js", import_meta.url);
}
var TinyCloudVfsBridge = class {
  worker;
  constructor(init) {
    const specifier = resolveWorkerSpecifier();
    this.worker = typeof specifier === "string" ? new import_node_worker_threads.Worker(specifier) : new import_node_worker_threads.Worker(specifier);
    const response = this.requestSync({ type: "init", init });
    if (!response.ok) {
      this.worker.terminate();
      throw createEIO("init", "/", response.error.message);
    }
  }
  close() {
    void this.worker.terminate();
  }
  requestSync(request) {
    const { port1, port2 } = new import_node_worker_threads.MessageChannel();
    const { buffer, view } = createWaitSignal();
    this.worker.postMessage(
      {
        request,
        replyPort: port1,
        waitBuffer: buffer
      },
      [port1]
    );
    while (Atomics.load(view, 0) === 0) {
      Atomics.wait(view, 0, 0, WAIT_SLICE_MS);
    }
    const response = (0, import_node_worker_threads.receiveMessageOnPort)(port2)?.message;
    port2.close();
    if (!response) {
      throw createEIO("bridge", "/", "worker did not return a response");
    }
    return response;
  }
  async requestAsync(request) {
    return this.requestSync(request);
  }
};

// src/pathing.ts
var import_node_path2 = require("path");
function normalizeVfsPath(inputPath) {
  const normalized = import_node_path2.posix.normalize(inputPath.replace(/\\/g, "/"));
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return absolute;
}

// src/metadata.ts
function normalizeMode(kind, mode) {
  if (typeof mode === "number" && Number.isFinite(mode)) {
    return mode;
  }
  return kind === "directory" ? 493 : 420;
}

// src/TinyCloudVfsProvider.ts
var S_IFREG = 32768;
var S_IFDIR = 16384;
var DEFAULT_BLOCK_SIZE = 4096;
function createStats(metadata) {
  const mode = metadata.kind === "directory" ? metadata.mode | S_IFDIR : metadata.mode | S_IFREG;
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
    isSocket: () => false
  };
}
function createDirent(entry) {
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
    isSocket: () => false
  };
}
function expectStatResult(response) {
  if (!response.ok) {
    throw fromWorkerError(response.error);
  }
  if (!response.result || !("metadata" in response.result)) {
    throw new Error("worker returned an unexpected stat payload");
  }
  return response.result.metadata;
}
function expectReadFileResult(response) {
  if (!response.ok) {
    throw fromWorkerError(response.error);
  }
  if (!response.result || !("metadata" in response.result) || !("content" in response.result)) {
    throw new Error("worker returned an unexpected readFile payload");
  }
  return response.result;
}
function expectReaddirResult(response) {
  if (!response.ok) {
    throw fromWorkerError(response.error);
  }
  if (!response.result || !("entries" in response.result)) {
    throw new Error("worker returned an unexpected readdir payload");
  }
  return response.result.entries;
}
function isWriteFlag(flags = "r") {
  return /[wa+]/.test(flags);
}
function isAppendFlag(flags = "r") {
  return flags.startsWith("a");
}
function isTruncateFlag(flags = "r") {
  return flags.startsWith("w");
}
var TinyCloudVfsFileHandle = class {
  bridge;
  state;
  closed = false;
  dirty = false;
  position = 0;
  constructor(bridge, state) {
    this.bridge = bridge;
    this.state = state;
    if (isAppendFlag(state.flags)) {
      this.position = state.content.length;
    }
  }
  ensureOpen() {
    if (this.closed) {
      throw new Error("file handle is closed");
    }
  }
  commit() {
    if (!this.dirty) {
      return;
    }
    const response = this.bridge.requestSync({
      type: "writeFile",
      path: this.state.path,
      content: this.state.content,
      mode: this.state.mode
    });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
    this.dirty = false;
  }
  readSync(buffer, offset, length, position) {
    this.ensureOpen();
    const readFrom = position ?? this.position;
    const available = Math.max(0, this.state.content.length - readFrom);
    const bytesToRead = Math.min(length, available);
    if (bytesToRead === 0) {
      return 0;
    }
    this.state.content.copy(buffer, offset, readFrom, readFrom + bytesToRead);
    if (position === null || position === void 0) {
      this.position = readFrom + bytesToRead;
    }
    return bytesToRead;
  }
  writeSync(buffer, offset, length, position) {
    this.ensureOpen();
    const writeFrom = position ?? this.position;
    const data = buffer.subarray(offset, offset + length);
    const requiredLength = writeFrom + data.length;
    if (requiredLength > this.state.content.length) {
      const next = import_node_buffer.Buffer.alloc(requiredLength);
      this.state.content.copy(next, 0, 0, this.state.content.length);
      this.state.content = next;
    }
    data.copy(this.state.content, writeFrom);
    this.state.metadata = {
      ...this.state.metadata,
      size: this.state.content.length,
      mtimeMs: Date.now(),
      ctimeMs: Date.now()
    };
    this.dirty = true;
    if (position === null || position === void 0) {
      this.position = writeFrom + data.length;
    }
    return data.length;
  }
  readFileSync(options) {
    this.ensureOpen();
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (encoding) {
      return this.state.content.toString(encoding);
    }
    return import_node_buffer.Buffer.from(this.state.content);
  }
  writeFileSync(data, options) {
    this.ensureOpen();
    const encoding = typeof options === "string" ? options : options?.encoding;
    const buffer = typeof data === "string" ? import_node_buffer.Buffer.from(data, encoding) : import_node_buffer.Buffer.from(data);
    if (isAppendFlag(this.state.flags)) {
      this.state.content = import_node_buffer.Buffer.concat([this.state.content, buffer]);
    } else {
      this.state.content = import_node_buffer.Buffer.from(buffer);
    }
    this.state.metadata = {
      ...this.state.metadata,
      size: this.state.content.length,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      mode: normalizeMode("file", typeof options === "object" ? options?.mode : this.state.mode)
    };
    this.dirty = true;
    this.position = this.state.content.length;
  }
  statSync() {
    this.ensureOpen();
    return createStats({
      ...this.state.metadata,
      size: this.state.content.length
    });
  }
  closeSync() {
    this.ensureOpen();
    this.commit();
    this.closed = true;
  }
};
var TinyCloudVfsProvider = class extends import_vfs.VirtualProvider {
  bridge;
  forceReadOnly;
  constructor(options) {
    super();
    this.forceReadOnly = options.readOnly === true;
    this.bridge = new TinyCloudVfsBridge({
      source: options.source,
      mountPrefix: options.mountPrefix ?? ""
    });
  }
  get readonly() {
    return this.forceReadOnly;
  }
  close() {
    this.bridge.close();
  }
  ensureWritable(path, syscall) {
    if (this.forceReadOnly) {
      throw createEROFS(syscall, path);
    }
  }
  normalize(path) {
    return normalizeVfsPath(path);
  }
  openSync(path, flags = "r", mode) {
    const normalized = this.normalize(path);
    const writable = isWriteFlag(flags);
    if (writable) {
      this.ensureWritable(normalized, "open");
    }
    let metadata;
    let content = import_node_buffer.Buffer.alloc(0);
    try {
      const response = expectReadFileResult(this.bridge.requestSync({ type: "readFile", path: normalized }));
      metadata = response.metadata;
      content = import_node_buffer.Buffer.from(response.content);
      if (isTruncateFlag(flags)) {
        content = import_node_buffer.Buffer.alloc(0);
        metadata = {
          ...metadata,
          size: 0,
          mode: normalizeMode("file", mode ?? metadata.mode)
        };
      }
    } catch (error) {
      const typed = error;
      if (typed.code !== "ENOENT" || !writable) {
        throw error;
      }
      metadata = {
        kind: "file",
        size: 0,
        mode: normalizeMode("file", mode),
        ctimeMs: Date.now(),
        mtimeMs: Date.now(),
        birthtimeMs: Date.now()
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
      metadata
    });
  }
  async open(path, flags = "r", mode) {
    return this.openSync(path, flags, mode);
  }
  statSync(path) {
    const normalized = this.normalize(path);
    return createStats(expectStatResult(this.bridge.requestSync({ type: "stat", path: normalized })));
  }
  async stat(path) {
    return this.statSync(path);
  }
  lstatSync(path) {
    return this.statSync(path);
  }
  async lstat(path) {
    return this.lstatSync(path);
  }
  readdirSync(path, options) {
    const normalized = this.normalize(path);
    const entries = expectReaddirResult(this.bridge.requestSync({ type: "readdir", path: normalized }));
    if (options?.withFileTypes) {
      return entries.map(createDirent);
    }
    return entries.map((entry) => entry.name);
  }
  async readdir(path, options) {
    return this.readdirSync(path, options);
  }
  mkdirSync(path, options) {
    const normalized = this.normalize(path);
    this.ensureWritable(normalized, "mkdir");
    const response = this.bridge.requestSync({
      type: "mkdir",
      path: normalized,
      recursive: options?.recursive === true,
      mode: options?.mode
    });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
    return options?.recursive ? normalized : void 0;
  }
  async mkdir(path, options) {
    return this.mkdirSync(path, options);
  }
  rmdirSync(path) {
    const normalized = this.normalize(path);
    this.ensureWritable(normalized, "rmdir");
    const response = this.bridge.requestSync({ type: "rmdir", path: normalized });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
  }
  async rmdir(path) {
    this.rmdirSync(path);
  }
  unlinkSync(path) {
    const normalized = this.normalize(path);
    this.ensureWritable(normalized, "unlink");
    const response = this.bridge.requestSync({ type: "unlink", path: normalized });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
  }
  async unlink(path) {
    this.unlinkSync(path);
  }
  renameSync(oldPath, newPath) {
    const normalizedOld = this.normalize(oldPath);
    const normalizedNew = this.normalize(newPath);
    this.ensureWritable(normalizedOld, "rename");
    const response = this.bridge.requestSync({
      type: "rename",
      oldPath: normalizedOld,
      newPath: normalizedNew
    });
    if (!response.ok) {
      throw fromWorkerError(response.error);
    }
  }
  async rename(oldPath, newPath) {
    this.renameSync(oldPath, newPath);
  }
};
function toSessionSource(node, host) {
  if (!node.session) {
    throw new Error("TinyCloudNode has no active session; call signIn() or restoreSession() first.");
  }
  return {
    kind: "session",
    host: host ?? "https://node.tinycloud.xyz",
    session: node.session
  };
}
function createTinyCloudVfs(options) {
  const provider = new TinyCloudVfsProvider(options);
  const vfs = (0, import_vfs.create)(provider, {
    moduleHooks: options.moduleHooks,
    overlay: options.overlay,
    virtualCwd: options.virtualCwd
  });
  if (options.mountPoint) {
    vfs.mount(options.mountPoint);
  }
  return { provider, vfs };
}
function createTinyCloudVfsFromNode(node, options = {}) {
  return createTinyCloudVfs({
    ...options,
    source: toSessionSource(node, options.host)
  });
}
function createTinyCloudDelegatedVfs(options) {
  if (!options.node.session) {
    throw new Error("TinyCloudNode has no active session; call signIn() or restoreSession() first.");
  }
  return createTinyCloudVfs({
    ...options,
    source: {
      kind: "delegation",
      host: options.host ?? options.delegation.host ?? "https://node.tinycloud.xyz",
      session: options.node.session,
      delegation: options.delegation
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TinyCloudVfsProvider,
  createTinyCloudDelegatedVfs,
  createTinyCloudVfs,
  createTinyCloudVfsFromNode
});
//# sourceMappingURL=index.cjs.map