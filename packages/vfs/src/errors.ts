const ERRNO: Record<string, number> = {
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
  EROFS: -30,
};

export function createNodeError(
  code: string,
  message: string,
  syscall: string,
  path?: string,
): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  error.errno = ERRNO[code] ?? -1;
  error.syscall = syscall;
  if (path) {
    error.path = path;
  }
  return error;
}

export function createENOENT(syscall: string, path: string): NodeJS.ErrnoException {
  return createNodeError("ENOENT", `no such file or directory, ${syscall} '${path}'`, syscall, path);
}

export function createEISDIR(syscall: string, path: string): NodeJS.ErrnoException {
  return createNodeError("EISDIR", `illegal operation on a directory, ${syscall} '${path}'`, syscall, path);
}

export function createENOTDIR(syscall: string, path: string): NodeJS.ErrnoException {
  return createNodeError("ENOTDIR", `not a directory, ${syscall} '${path}'`, syscall, path);
}

export function createENOTEMPTY(syscall: string, path: string): NodeJS.ErrnoException {
  return createNodeError("ENOTEMPTY", `directory not empty, ${syscall} '${path}'`, syscall, path);
}

export function createEEXIST(syscall: string, path: string): NodeJS.ErrnoException {
  return createNodeError("EEXIST", `file already exists, ${syscall} '${path}'`, syscall, path);
}

export function createEACCES(syscall: string, path: string, message = "permission denied"): NodeJS.ErrnoException {
  return createNodeError("EACCES", `${message}, ${syscall} '${path}'`, syscall, path);
}

export function createEROFS(syscall: string, path: string): NodeJS.ErrnoException {
  return createNodeError("EROFS", `read-only file system, ${syscall} '${path}'`, syscall, path);
}

export function createEIO(syscall: string, path: string, message: string): NodeJS.ErrnoException {
  return createNodeError("EIO", `${message}, ${syscall} '${path}'`, syscall, path);
}

export function createEBUSY(syscall: string, path: string, message = "resource busy or locked"): NodeJS.ErrnoException {
  return createNodeError("EBUSY", `${message}, ${syscall} '${path}'`, syscall, path);
}

export function createEINVAL(syscall: string, path: string, message = "invalid argument"): NodeJS.ErrnoException {
  return createNodeError("EINVAL", `${message}, ${syscall} '${path}'`, syscall, path);
}

export function fromWorkerError(error: { code: string; message: string; syscall?: string; path?: string }): NodeJS.ErrnoException {
  return createNodeError(
    error.code,
    error.message,
    error.syscall ?? "vfs",
    error.path,
  );
}
