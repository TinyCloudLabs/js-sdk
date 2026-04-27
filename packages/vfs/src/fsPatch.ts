import { Buffer } from "node:buffer";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { VirtualFileSystem } from "@platformatic/vfs";
import { fileURLToPath } from "node:url";
import { createNodeError } from "./errors";

type PathArg = string | Buffer | URL;
type WriteCallback = (error: NodeJS.ErrnoException | null) => void;
type MkdirCallback = (error: NodeJS.ErrnoException | null, path?: string) => void;

interface PatchableVirtualFileSystem extends VirtualFileSystem {
  mountPoint: string | null;
  mounted: boolean;
  shouldHandle(path: string): boolean;
  writeFileSync(path: string, data: unknown, options?: unknown): void;
  appendFileSync(path: string, data: unknown, options?: unknown): void;
  mkdirSync(path: string, options?: unknown): string | undefined;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  rmdirSync(path: string, options?: unknown): void;
  promises: {
    writeFile(path: string, data: unknown, options?: unknown): Promise<void>;
    appendFile(path: string, data: unknown, options?: unknown): Promise<void>;
    mkdir(path: string, options?: unknown): Promise<string | undefined>;
    rename(oldPath: string, newPath: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string, options?: unknown): Promise<void>;
  };
  [Symbol.dispose]?: () => void;
}

interface OriginalFsMethods {
  writeFileSync: typeof NodeFs.writeFileSync;
  appendFileSync: typeof NodeFs.appendFileSync;
  mkdirSync: typeof NodeFs.mkdirSync;
  renameSync: typeof NodeFs.renameSync;
  unlinkSync: typeof NodeFs.unlinkSync;
  rmdirSync: typeof NodeFs.rmdirSync;
  writeFile: typeof NodeFs.writeFile;
  appendFile: typeof NodeFs.appendFile;
  mkdir: typeof NodeFs.mkdir;
  rename: typeof NodeFs.rename;
  unlink: typeof NodeFs.unlink;
  rmdir: typeof NodeFs.rmdir;
}

interface OriginalPromiseMethods {
  writeFile: typeof NodeFsPromises.writeFile;
  appendFile: typeof NodeFsPromises.appendFile;
  mkdir: typeof NodeFsPromises.mkdir;
  rename: typeof NodeFsPromises.rename;
  unlink: typeof NodeFsPromises.unlink;
  rmdir: typeof NodeFsPromises.rmdir;
}

const activeVfs = new Set<PatchableVirtualFileSystem>();
const mutableFs = fs as typeof NodeFs & { promises: typeof NodeFsPromises };
const mutableFsPromises = fsPromises as typeof NodeFsPromises;

const originalFsMethods: OriginalFsMethods = {
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
  rmdir: mutableFs.rmdir.bind(mutableFs),
};

const originalPromiseMethods: OriginalPromiseMethods = {
  writeFile: mutableFsPromises.writeFile.bind(mutableFsPromises),
  appendFile: mutableFsPromises.appendFile.bind(mutableFsPromises),
  mkdir: mutableFsPromises.mkdir.bind(mutableFsPromises),
  rename: mutableFsPromises.rename.bind(mutableFsPromises),
  unlink: mutableFsPromises.unlink.bind(mutableFsPromises),
  rmdir: mutableFsPromises.rmdir.bind(mutableFsPromises),
};

let installed = false;

function toPathString(path: unknown): string | null {
  if (typeof path === "string") {
    return path;
  }
  if (Buffer.isBuffer(path)) {
    return path.toString();
  }
  if (path instanceof URL) {
    return fileURLToPath(path);
  }
  return null;
}

function activeVfsBySpecificity(): PatchableVirtualFileSystem[] {
  return [...activeVfs].sort((left, right) => {
    return (right.mountPoint?.length ?? 0) - (left.mountPoint?.length ?? 0);
  });
}

function findMountedVfs(path: unknown): { vfs: PatchableVirtualFileSystem; path: string } | null {
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

function findMountedVfsForPaths(paths: unknown[], syscall: string): { vfs: PatchableVirtualFileSystem; paths: string[] } | null {
  let selected: PatchableVirtualFileSystem | null = null;
  const normalizedPaths: string[] = [];

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
        normalizedPath,
      );
    }

    selected = match.vfs;
  }

  if (!selected) {
    return null;
  }

  return { vfs: selected, paths: normalizedPaths };
}

function withCallback<T>(promise: Promise<T>, callback: (error: NodeJS.ErrnoException | null, result?: T) => void): void {
  promise.then(
    (result) => process.nextTick(callback, null, result),
    (error) => process.nextTick(callback, error as NodeJS.ErrnoException),
  );
}

function installFsWritePatches(): void {
  if (installed) {
    return;
  }

  mutableFs.writeFileSync = ((file: PathArg, data: unknown, options?: unknown) => {
    const match = findMountedVfs(file);
    if (!match) {
      return originalFsMethods.writeFileSync(file, data as never, options as never);
    }
    return match.vfs.writeFileSync(match.path, data, options);
  }) as typeof NodeFs.writeFileSync;

  mutableFs.appendFileSync = ((file: PathArg, data: unknown, options?: unknown) => {
    const match = findMountedVfs(file);
    if (!match) {
      return originalFsMethods.appendFileSync(file, data as never, options as never);
    }
    return match.vfs.appendFileSync(match.path, data, options);
  }) as typeof NodeFs.appendFileSync;

  mutableFs.mkdirSync = ((path: PathArg, options?: unknown) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.mkdirSync(path, options as never);
    }
    return match.vfs.mkdirSync(match.path, options);
  }) as typeof NodeFs.mkdirSync;

  mutableFs.renameSync = ((oldPath: PathArg, newPath: PathArg) => {
    const match = findMountedVfsForPaths([oldPath, newPath], "rename");
    if (!match) {
      return originalFsMethods.renameSync(oldPath, newPath);
    }
    const [normalizedOld, normalizedNew] = match.paths;
    return match.vfs.renameSync(normalizedOld, normalizedNew);
  }) as typeof NodeFs.renameSync;

  mutableFs.unlinkSync = ((path: PathArg) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.unlinkSync(path);
    }
    return match.vfs.unlinkSync(match.path);
  }) as typeof NodeFs.unlinkSync;

  mutableFs.rmdirSync = ((path: PathArg, options?: unknown) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.rmdirSync(path, options as never);
    }
    return match.vfs.rmdirSync(match.path, options);
  }) as typeof NodeFs.rmdirSync;

  mutableFs.writeFile = ((file: PathArg, data: unknown, options?: unknown, callback?: WriteCallback) => {
    const match = findMountedVfs(file);
    if (!match) {
      return originalFsMethods.writeFile(file, data as never, options as never, callback as never);
    }

    const resolvedOptions = typeof options === "function" ? undefined : options;
    const resolvedCallback = typeof options === "function" ? options : callback;
    if (typeof resolvedCallback !== "function") {
      return originalFsMethods.writeFile(file, data as never, options as never, callback as never);
    }

    withCallback(match.vfs.promises.writeFile(match.path, data, resolvedOptions), resolvedCallback);
  }) as typeof NodeFs.writeFile;

  mutableFs.appendFile = ((file: PathArg, data: unknown, options?: unknown, callback?: WriteCallback) => {
    const match = findMountedVfs(file);
    if (!match) {
      return originalFsMethods.appendFile(file, data as never, options as never, callback as never);
    }

    const resolvedOptions = typeof options === "function" ? undefined : options;
    const resolvedCallback = typeof options === "function" ? options : callback;
    if (typeof resolvedCallback !== "function") {
      return originalFsMethods.appendFile(file, data as never, options as never, callback as never);
    }

    withCallback(match.vfs.promises.appendFile(match.path, data, resolvedOptions), resolvedCallback);
  }) as typeof NodeFs.appendFile;

  mutableFs.mkdir = ((path: PathArg, options?: unknown, callback?: MkdirCallback) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.mkdir(path, options as never, callback as never);
    }

    const resolvedOptions = typeof options === "function" ? undefined : options;
    const resolvedCallback = typeof options === "function" ? options : callback;
    if (typeof resolvedCallback !== "function") {
      return originalFsMethods.mkdir(path, options as never, callback as never);
    }

    withCallback(match.vfs.promises.mkdir(match.path, resolvedOptions), resolvedCallback);
  }) as typeof NodeFs.mkdir;

  mutableFs.rename = ((oldPath: PathArg, newPath: PathArg, callback?: WriteCallback) => {
    const match = findMountedVfsForPaths([oldPath, newPath], "rename");
    if (!match) {
      return originalFsMethods.rename(oldPath, newPath, callback as never);
    }
    if (typeof callback !== "function") {
      return originalFsMethods.rename(oldPath, newPath, callback as never);
    }

    const [normalizedOld, normalizedNew] = match.paths;
    withCallback(match.vfs.promises.rename(normalizedOld, normalizedNew), callback);
  }) as typeof NodeFs.rename;

  mutableFs.unlink = ((path: PathArg, callback?: WriteCallback) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.unlink(path, callback as never);
    }
    if (typeof callback !== "function") {
      return originalFsMethods.unlink(path, callback as never);
    }

    withCallback(match.vfs.promises.unlink(match.path), callback);
  }) as typeof NodeFs.unlink;

  mutableFs.rmdir = ((path: PathArg, options?: unknown, callback?: WriteCallback) => {
    const match = findMountedVfs(path);
    if (!match) {
      return originalFsMethods.rmdir(path, options as never, callback as never);
    }

    const resolvedCallback = typeof options === "function" ? options : callback;
    if (typeof resolvedCallback !== "function") {
      return originalFsMethods.rmdir(path, options as never, callback as never);
    }

    withCallback(match.vfs.promises.rmdir(match.path, typeof options === "function" ? undefined : options), resolvedCallback);
  }) as typeof NodeFs.rmdir;

  const promisePatches: OriginalPromiseMethods = {
    async writeFile(file: PathArg, data: unknown, options?: unknown) {
      const match = findMountedVfs(file);
      if (!match) {
        return originalPromiseMethods.writeFile(file, data as never, options as never);
      }
      return match.vfs.promises.writeFile(match.path, data, options);
    },

    async appendFile(file: PathArg, data: unknown, options?: unknown) {
      const match = findMountedVfs(file);
      if (!match) {
        return originalPromiseMethods.appendFile(file, data as never, options as never);
      }
      return match.vfs.promises.appendFile(match.path, data, options);
    },

    async mkdir(path: PathArg, options?: unknown) {
      const match = findMountedVfs(path);
      if (!match) {
        return originalPromiseMethods.mkdir(path, options as never);
      }
      return match.vfs.promises.mkdir(match.path, options);
    },

    async rename(oldPath: PathArg, newPath: PathArg) {
      const match = findMountedVfsForPaths([oldPath, newPath], "rename");
      if (!match) {
        return originalPromiseMethods.rename(oldPath, newPath);
      }
      const [normalizedOld, normalizedNew] = match.paths;
      return match.vfs.promises.rename(normalizedOld, normalizedNew);
    },

    async unlink(path: PathArg) {
      const match = findMountedVfs(path);
      if (!match) {
        return originalPromiseMethods.unlink(path);
      }
      return match.vfs.promises.unlink(match.path);
    },

    async rmdir(path: PathArg, options?: unknown) {
      const match = findMountedVfs(path);
      if (!match) {
        return originalPromiseMethods.rmdir(path, options as never);
      }
      return match.vfs.promises.rmdir(match.path, options);
    },
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

  syncBuiltinESMExports();
  installed = true;
}

function uninstallFsWritePatches(): void {
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

  syncBuiltinESMExports();
  installed = false;
}

function registerMountedVfs(vfs: PatchableVirtualFileSystem): void {
  activeVfs.add(vfs);
  installFsWritePatches();
}

function deregisterMountedVfs(vfs: PatchableVirtualFileSystem): void {
  activeVfs.delete(vfs);
  uninstallFsWritePatches();
}

export function wrapVfsWithFsWritePatches(vfs: VirtualFileSystem): VirtualFileSystem {
  const patchableVfs = vfs as PatchableVirtualFileSystem;
  const originalMount = vfs.mount.bind(vfs);
  const originalUnmount = vfs.unmount.bind(vfs);
  const originalDispose = patchableVfs[Symbol.dispose]?.bind(vfs);
  let registered = false;

  patchableVfs.mount = ((prefix: string) => {
    const mounted = originalMount(prefix);
    if (!registered) {
      registerMountedVfs(patchableVfs);
      registered = true;
    }
    return mounted;
  }) as typeof vfs.mount;

  patchableVfs.unmount = (() => {
    if (registered) {
      deregisterMountedVfs(patchableVfs);
      registered = false;
    }
    return originalUnmount();
  }) as typeof vfs.unmount;

  if (originalDispose) {
    patchableVfs[Symbol.dispose] = (() => {
      if (registered) {
        deregisterMountedVfs(patchableVfs);
        registered = false;
      }
      return originalDispose();
    }) as typeof patchableVfs[typeof Symbol.dispose];
  }

  return patchableVfs;
}
