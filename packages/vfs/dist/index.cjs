"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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
var import_node_buffer2 = require("buffer");
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

// src/fsPatch.ts
var import_node_buffer = require("buffer");
var import_node_fs = __toESM(require("fs"), 1);
var import_promises = __toESM(require("fs/promises"), 1);
var import_node_module = require("module");
var import_node_url = require("url");
var activeVfs = /* @__PURE__ */ new Set();
var mutableFs = import_node_fs.default;
var mutableFsPromises = import_promises.default;
var originalFsMethods = {
  writeFileSync: mutableFs.writeFileSync.bind(mutableFs),
  appendFileSync: mutableFs.appendFileSync.bind(mutableFs),
  mkdirSync: mutableFs.mkdirSync.bind(mutableFs),
  renameSync: mutableFs.renameSync.bind(mutableFs),
  unlinkSync: mutableFs.unlinkSync.bind(mutableFs),
  rmdirSync: mutableFs.rmdirSync.bind(mutableFs),
  writeFile: mutableFs.writeFile.bind(mutableFs),
  appendFile: mutableFs.appendFile.bind(mutableFs),
  mkdir: mutableFs.mkdir.bind(mutableFs),
  rename: mutableFs.rename.bind(mutableFs),
  unlink: mutableFs.unlink.bind(mutableFs),
  rmdir: mutableFs.rmdir.bind(mutableFs)
};
var originalPromiseMethods = {
  writeFile: mutableFsPromises.writeFile.bind(mutableFsPromises),
  appendFile: mutableFsPromises.appendFile.bind(mutableFsPromises),
  mkdir: mutableFsPromises.mkdir.bind(mutableFsPromises),
  rename: mutableFsPromises.rename.bind(mutableFsPromises),
  unlink: mutableFsPromises.unlink.bind(mutableFsPromises),
  rmdir: mutableFsPromises.rmdir.bind(mutableFsPromises)
};
var installed = false;
function toPathString(path) {
  if (typeof path === "string") {
    return path;
  }
  if (import_node_buffer.Buffer.isBuffer(path)) {
    return path.toString();
  }
  if (path instanceof URL) {
    return (0, import_node_url.fileURLToPath)(path);
  }
  return null;
}
function activeVfsBySpecificity() {
  return [...activeVfs].sort((left, right) => {
    return (right.mountPoint?.length ?? 0) - (left.mountPoint?.length ?? 0);
  });
}
function findMountedVfs(path) {
  const normalizedPath = toPathString(path);
  if (!normalizedPath) {
    return null;
  }
  for (const vfs of activeVfsBySpecificity()) {
    if (vfs.mounted && vfs.shouldHandle(normalizedPath)) {
      return { vfs, path: normalizedPath };
    }
  }
  return null;
}
function findMountedVfsForPaths(paths, syscall) {
  let selected = null;
  const normalizedPaths = [];
  for (const path of paths) {
    const normalizedPath = toPathString(path);
    if (!normalizedPath) {
      normalizedPaths.push(String(path));
      continue;
    }
    normalizedPaths.push(normalizedPath);
    const match = findMountedVfs(normalizedPath);
    if (!match) {
      continue;
    }
    if (selected && selected !== match.vfs) {
      throw createNodeError(
        "EXDEV",
        `cross-device link not permitted, ${syscall} '${normalizedPaths.join("' -> '")}'`,
        syscall,
        normalizedPath
      );
    }
    selected = match.vfs;
  }
  if (!selected) {
    return null;
  }
  return { vfs: selected, paths: normalizedPaths };
}
function withCallback(promise, callback) {
  promise.then(
    (result) => process.nextTick(callback, null, result),
    (error) => process.nextTick(callback, error)
  );
}
function installFsWritePatches() {
  if (installed) {
    return;
  }
  mutableFs.writeFileSync = ((file, data, options) => {
    const match = findMountedVfs(file);
    if (!match) {
      return originalFsMethods.writeFileSync(file, data, options);
    }
    return match.vfs.writeFileSync(match.path, data, options);
  });
  mutableFs.appendFileSync = ((file, data, options) => {
    const match = findMountedVfs(file);
    if (!match) {
      return originalFsMethods.appendFileSync(file, data, options);
    }
    return match.vfs.appendFileSync(match.path, data, options);
  });
  mutableFs.mkdirSync = ((path, options) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.mkdirSync(path, options);
    }
    return match.vfs.mkdirSync(match.path, options);
  });
  mutableFs.renameSync = ((oldPath, newPath) => {
    const match = findMountedVfsForPaths([oldPath, newPath], "rename");
    if (!match) {
      return originalFsMethods.renameSync(oldPath, newPath);
    }
    const [normalizedOld, normalizedNew] = match.paths;
    return match.vfs.renameSync(normalizedOld, normalizedNew);
  });
  mutableFs.unlinkSync = ((path) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.unlinkSync(path);
    }
    return match.vfs.unlinkSync(match.path);
  });
  mutableFs.rmdirSync = ((path, options) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.rmdirSync(path, options);
    }
    return match.vfs.rmdirSync(match.path, options);
  });
  mutableFs.writeFile = ((file, data, options, callback) => {
    const match = findMountedVfs(file);
    if (!match) {
      return originalFsMethods.writeFile(file, data, options, callback);
    }
    const resolvedOptions = typeof options === "function" ? void 0 : options;
    const resolvedCallback = typeof options === "function" ? options : callback;
    if (typeof resolvedCallback !== "function") {
      return originalFsMethods.writeFile(file, data, options, callback);
    }
    withCallback(match.vfs.promises.writeFile(match.path, data, resolvedOptions), resolvedCallback);
  });
  mutableFs.appendFile = ((file, data, options, callback) => {
    const match = findMountedVfs(file);
    if (!match) {
      return originalFsMethods.appendFile(file, data, options, callback);
    }
    const resolvedOptions = typeof options === "function" ? void 0 : options;
    const resolvedCallback = typeof options === "function" ? options : callback;
    if (typeof resolvedCallback !== "function") {
      return originalFsMethods.appendFile(file, data, options, callback);
    }
    withCallback(match.vfs.promises.appendFile(match.path, data, resolvedOptions), resolvedCallback);
  });
  mutableFs.mkdir = ((path, options, callback) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.mkdir(path, options, callback);
    }
    const resolvedOptions = typeof options === "function" ? void 0 : options;
    const resolvedCallback = typeof options === "function" ? options : callback;
    if (typeof resolvedCallback !== "function") {
      return originalFsMethods.mkdir(path, options, callback);
    }
    withCallback(match.vfs.promises.mkdir(match.path, resolvedOptions), resolvedCallback);
  });
  mutableFs.rename = ((oldPath, newPath, callback) => {
    const match = findMountedVfsForPaths([oldPath, newPath], "rename");
    if (!match) {
      return originalFsMethods.rename(oldPath, newPath, callback);
    }
    if (typeof callback !== "function") {
      return originalFsMethods.rename(oldPath, newPath, callback);
    }
    const [normalizedOld, normalizedNew] = match.paths;
    withCallback(match.vfs.promises.rename(normalizedOld, normalizedNew), callback);
  });
  mutableFs.unlink = ((path, callback) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.unlink(path, callback);
    }
    if (typeof callback !== "function") {
      return originalFsMethods.unlink(path, callback);
    }
    withCallback(match.vfs.promises.unlink(match.path), callback);
  });
  mutableFs.rmdir = ((path, options, callback) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.rmdir(path, options, callback);
    }
    const resolvedCallback = typeof options === "function" ? options : callback;
    if (typeof resolvedCallback !== "function") {
      return originalFsMethods.rmdir(path, options, callback);
    }
    withCallback(match.vfs.promises.rmdir(match.path, typeof options === "function" ? void 0 : options), resolvedCallback);
  });
  const promisePatches = {
    async writeFile(file, data, options) {
      const match = findMountedVfs(file);
      if (!match) {
        return originalPromiseMethods.writeFile(file, data, options);
      }
      return match.vfs.promises.writeFile(match.path, data, options);
    },
    async appendFile(file, data, options) {
      const match = findMountedVfs(file);
      if (!match) {
        return originalPromiseMethods.appendFile(file, data, options);
      }
      return match.vfs.promises.appendFile(match.path, data, options);
    },
    async mkdir(path, options) {
      const match = findMountedVfs(path);
      if (!match) {
        return originalPromiseMethods.mkdir(path, options);
      }
      return match.vfs.promises.mkdir(match.path, options);
    },
    async rename(oldPath, newPath) {
      const match = findMountedVfsForPaths([oldPath, newPath], "rename");
      if (!match) {
        return originalPromiseMethods.rename(oldPath, newPath);
      }
      const [normalizedOld, normalizedNew] = match.paths;
      return match.vfs.promises.rename(normalizedOld, normalizedNew);
    },
    async unlink(path) {
      const match = findMountedVfs(path);
      if (!match) {
        return originalPromiseMethods.unlink(path);
      }
      return match.vfs.promises.unlink(match.path);
    },
    async rmdir(path, options) {
      const match = findMountedVfs(path);
      if (!match) {
        return originalPromiseMethods.rmdir(path, options);
      }
      return match.vfs.promises.rmdir(match.path, options);
    }
  };
  mutableFs.promises.writeFile = promisePatches.writeFile;
  mutableFs.promises.appendFile = promisePatches.appendFile;
  mutableFs.promises.mkdir = promisePatches.mkdir;
  mutableFs.promises.rename = promisePatches.rename;
  mutableFs.promises.unlink = promisePatches.unlink;
  mutableFs.promises.rmdir = promisePatches.rmdir;
  mutableFsPromises.writeFile = promisePatches.writeFile;
  mutableFsPromises.appendFile = promisePatches.appendFile;
  mutableFsPromises.mkdir = promisePatches.mkdir;
  mutableFsPromises.rename = promisePatches.rename;
  mutableFsPromises.unlink = promisePatches.unlink;
  mutableFsPromises.rmdir = promisePatches.rmdir;
  (0, import_node_module.syncBuiltinESMExports)();
  installed = true;
}
function uninstallFsWritePatches() {
  if (!installed || activeVfs.size > 0) {
    return;
  }
  mutableFs.writeFileSync = originalFsMethods.writeFileSync;
  mutableFs.appendFileSync = originalFsMethods.appendFileSync;
  mutableFs.mkdirSync = originalFsMethods.mkdirSync;
  mutableFs.renameSync = originalFsMethods.renameSync;
  mutableFs.unlinkSync = originalFsMethods.unlinkSync;
  mutableFs.rmdirSync = originalFsMethods.rmdirSync;
  mutableFs.writeFile = originalFsMethods.writeFile;
  mutableFs.appendFile = originalFsMethods.appendFile;
  mutableFs.mkdir = originalFsMethods.mkdir;
  mutableFs.rename = originalFsMethods.rename;
  mutableFs.unlink = originalFsMethods.unlink;
  mutableFs.rmdir = originalFsMethods.rmdir;
  mutableFs.promises.writeFile = originalPromiseMethods.writeFile;
  mutableFs.promises.appendFile = originalPromiseMethods.appendFile;
  mutableFs.promises.mkdir = originalPromiseMethods.mkdir;
  mutableFs.promises.rename = originalPromiseMethods.rename;
  mutableFs.promises.unlink = originalPromiseMethods.unlink;
  mutableFs.promises.rmdir = originalPromiseMethods.rmdir;
  mutableFsPromises.writeFile = originalPromiseMethods.writeFile;
  mutableFsPromises.appendFile = originalPromiseMethods.appendFile;
  mutableFsPromises.mkdir = originalPromiseMethods.mkdir;
  mutableFsPromises.rename = originalPromiseMethods.rename;
  mutableFsPromises.unlink = originalPromiseMethods.unlink;
  mutableFsPromises.rmdir = originalPromiseMethods.rmdir;
  (0, import_node_module.syncBuiltinESMExports)();
  installed = false;
}
function registerMountedVfs(vfs) {
  activeVfs.add(vfs);
  installFsWritePatches();
}
function deregisterMountedVfs(vfs) {
  activeVfs.delete(vfs);
  uninstallFsWritePatches();
}
function wrapVfsWithFsWritePatches(vfs) {
  const patchableVfs = vfs;
  const originalMount = vfs.mount.bind(vfs);
  const originalUnmount = vfs.unmount.bind(vfs);
  const originalDispose = patchableVfs[Symbol.dispose]?.bind(vfs);
  let registered = false;
  patchableVfs.mount = ((prefix) => {
    const mounted = originalMount(prefix);
    if (!registered) {
      registerMountedVfs(patchableVfs);
      registered = true;
    }
    return mounted;
  });
  patchableVfs.unmount = (() => {
    if (registered) {
      deregisterMountedVfs(patchableVfs);
      registered = false;
    }
    return originalUnmount();
  });
  if (originalDispose) {
    patchableVfs[Symbol.dispose] = (() => {
      if (registered) {
        deregisterMountedVfs(patchableVfs);
        registered = false;
      }
      return originalDispose();
    });
  }
  return patchableVfs;
}

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
      const next = import_node_buffer2.Buffer.alloc(requiredLength);
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
    return import_node_buffer2.Buffer.from(this.state.content);
  }
  writeFileSync(data, options) {
    this.ensureOpen();
    const encoding = typeof options === "string" ? options : options?.encoding;
    const buffer = typeof data === "string" ? import_node_buffer2.Buffer.from(data, encoding) : import_node_buffer2.Buffer.from(data);
    if (isAppendFlag(this.state.flags)) {
      this.state.content = import_node_buffer2.Buffer.concat([this.state.content, buffer]);
    } else {
      this.state.content = import_node_buffer2.Buffer.from(buffer);
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
    let content = import_node_buffer2.Buffer.alloc(0);
    try {
      const response = expectReadFileResult(this.bridge.requestSync({ type: "readFile", path: normalized }));
      metadata = response.metadata;
      content = import_node_buffer2.Buffer.from(response.content);
      if (isTruncateFlag(flags)) {
        content = import_node_buffer2.Buffer.alloc(0);
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
  const resolvedHost = host ?? node.config?.host ?? "https://node.tinycloud.xyz";
  return {
    kind: "session",
    host: resolvedHost,
    session: node.session
  };
}
function createTinyCloudVfs(options) {
  const provider = new TinyCloudVfsProvider(options);
  const vfs = wrapVfsWithFsWritePatches((0, import_vfs.create)(provider, {
    moduleHooks: options.moduleHooks,
    overlay: options.overlay,
    virtualCwd: options.virtualCwd
  }));
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
async function createTinyCloudDelegatedVfs(options) {
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
      kvPrefix: access.kv?.config?.prefix ?? ""
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