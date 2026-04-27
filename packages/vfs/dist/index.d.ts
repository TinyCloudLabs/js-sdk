import { Buffer as Buffer$1 } from 'node:buffer';
import { VirtualProvider, VirtualFileSystem } from '@platformatic/vfs';

interface PortableDelegationLike {
    cid: string;
    delegationHeader: {
        Authorization: string;
    };
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
interface TinyCloudVfsSessionData {
    delegationHeader: {
        Authorization: string;
    };
    delegationCid: string;
    spaceId: string;
    jwk: object;
    verificationMethod: string;
    address?: string;
    chainId?: number;
}
type TinyCloudVfsSource = {
    kind: "session";
    host: string;
    session: TinyCloudVfsSessionData;
} | {
    kind: "resolved-delegation";
    host: string;
    session: TinyCloudVfsSessionData;
    kvPrefix: string;
};
interface TinyCloudVfsOptions {
    mountPoint?: string;
    mountPrefix?: string;
    readOnly?: boolean;
    moduleHooks?: boolean;
    overlay?: boolean;
    virtualCwd?: boolean;
}
interface TinyCloudVfsProviderOptions {
    source: TinyCloudVfsSource;
    mountPrefix?: string;
    readOnly?: boolean;
}
interface TinyCloudVfsWorkerInit {
    source: TinyCloudVfsSource;
    mountPrefix: string;
}
interface TinyCloudVfsMetadata {
    kind: "file" | "directory";
    size: number;
    mode: number;
    ctimeMs: number;
    mtimeMs: number;
    birthtimeMs: number;
}
interface TinyCloudVfsDirent {
    name: string;
    kind: "file" | "directory";
    parentPath: string;
}
type WorkerRequest = {
    type: "init";
    init: TinyCloudVfsWorkerInit;
} | {
    type: "stat";
    path: string;
} | {
    type: "readFile";
    path: string;
} | {
    type: "writeFile";
    path: string;
    content: Uint8Array;
    mode?: number;
} | {
    type: "readdir";
    path: string;
} | {
    type: "mkdir";
    path: string;
    recursive?: boolean;
    mode?: number;
} | {
    type: "rmdir";
    path: string;
} | {
    type: "unlink";
    path: string;
} | {
    type: "rename";
    oldPath: string;
    newPath: string;
};
type WorkerResponse = {
    ok: true;
    result: null;
} | {
    ok: true;
    result: {
        metadata: TinyCloudVfsMetadata;
    };
} | {
    ok: true;
    result: {
        content: Uint8Array;
        metadata: TinyCloudVfsMetadata;
    };
} | {
    ok: true;
    result: {
        entries: TinyCloudVfsDirent[];
    };
} | {
    ok: false;
    error: WorkerErrorPayload;
};
interface WorkerErrorPayload {
    code: string;
    message: string;
    syscall?: string;
    path?: string;
}
interface TinyCloudVfsHandleState {
    path: string;
    flags: string;
    mode: number;
    content: Buffer;
    metadata: TinyCloudVfsMetadata;
}
interface CreateTinyCloudDelegatedVfsOptions extends Omit<TinyCloudVfsOptions, "mountPrefix"> {
    node: TinyCloudNodeLike;
    delegation: PortableDelegationLike;
    mountPrefix?: string;
    host?: string;
}
interface CreateTinyCloudNodeVfsOptions extends Omit<TinyCloudVfsOptions, "mountPrefix"> {
    mountPrefix?: string;
    host?: string;
}
interface TinyCloudNodeLike {
    session?: TinyCloudVfsSessionData;
    config?: {
        host?: string;
    };
    useDelegation?: (delegation: PortableDelegationLike) => Promise<{
        session?: TinyCloudVfsSessionData;
        kv: {
            config?: {
                prefix?: string;
            };
        };
    }>;
}

declare class TinyCloudVfsBridge {
    private readonly worker;
    constructor(init: TinyCloudVfsWorkerInit);
    close(): void;
    requestSync(request: WorkerRequest): WorkerResponse;
    requestAsync(request: WorkerRequest): Promise<WorkerResponse>;
}

declare class TinyCloudVfsFileHandle {
    private readonly bridge;
    private readonly state;
    private closed;
    private dirty;
    private position;
    constructor(bridge: TinyCloudVfsBridge, state: TinyCloudVfsHandleState);
    private ensureOpen;
    private commit;
    readSync(buffer: Buffer$1, offset: number, length: number, position: number | null): number;
    writeSync(buffer: Buffer$1, offset: number, length: number, position: number | null): number;
    readFileSync(options?: BufferEncoding | {
        encoding?: BufferEncoding | null;
    } | null): Buffer$1 | string;
    writeFileSync(data: string | Buffer$1, options?: BufferEncoding | {
        encoding?: BufferEncoding;
        mode?: number;
    }): void;
    statSync(): {
        dev: number;
        mode: number;
        nlink: number;
        uid: number;
        gid: number;
        rdev: number;
        blksize: number;
        ino: number;
        size: number;
        blocks: number;
        atimeMs: number;
        mtimeMs: number;
        ctimeMs: number;
        birthtimeMs: number;
        atime: Date;
        mtime: Date;
        ctime: Date;
        birthtime: Date;
        isFile: () => boolean;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        isBlockDevice: () => boolean;
        isCharacterDevice: () => boolean;
        isFIFO: () => boolean;
        isSocket: () => boolean;
    };
    closeSync(): void;
}
declare class TinyCloudVfsProvider extends VirtualProvider {
    private readonly bridge;
    private readonly forceReadOnly;
    constructor(options: TinyCloudVfsProviderOptions);
    get readonly(): boolean;
    close(): void;
    private ensureWritable;
    private normalize;
    openSync(path: string, flags?: string, mode?: number): TinyCloudVfsFileHandle;
    open(path: string, flags?: string, mode?: number): Promise<TinyCloudVfsFileHandle>;
    statSync(path: string): {
        dev: number;
        mode: number;
        nlink: number;
        uid: number;
        gid: number;
        rdev: number;
        blksize: number;
        ino: number;
        size: number;
        blocks: number;
        atimeMs: number;
        mtimeMs: number;
        ctimeMs: number;
        birthtimeMs: number;
        atime: Date;
        mtime: Date;
        ctime: Date;
        birthtime: Date;
        isFile: () => boolean;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        isBlockDevice: () => boolean;
        isCharacterDevice: () => boolean;
        isFIFO: () => boolean;
        isSocket: () => boolean;
    };
    stat(path: string): Promise<{
        dev: number;
        mode: number;
        nlink: number;
        uid: number;
        gid: number;
        rdev: number;
        blksize: number;
        ino: number;
        size: number;
        blocks: number;
        atimeMs: number;
        mtimeMs: number;
        ctimeMs: number;
        birthtimeMs: number;
        atime: Date;
        mtime: Date;
        ctime: Date;
        birthtime: Date;
        isFile: () => boolean;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        isBlockDevice: () => boolean;
        isCharacterDevice: () => boolean;
        isFIFO: () => boolean;
        isSocket: () => boolean;
    }>;
    lstatSync(path: string): {
        dev: number;
        mode: number;
        nlink: number;
        uid: number;
        gid: number;
        rdev: number;
        blksize: number;
        ino: number;
        size: number;
        blocks: number;
        atimeMs: number;
        mtimeMs: number;
        ctimeMs: number;
        birthtimeMs: number;
        atime: Date;
        mtime: Date;
        ctime: Date;
        birthtime: Date;
        isFile: () => boolean;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        isBlockDevice: () => boolean;
        isCharacterDevice: () => boolean;
        isFIFO: () => boolean;
        isSocket: () => boolean;
    };
    lstat(path: string): Promise<{
        dev: number;
        mode: number;
        nlink: number;
        uid: number;
        gid: number;
        rdev: number;
        blksize: number;
        ino: number;
        size: number;
        blocks: number;
        atimeMs: number;
        mtimeMs: number;
        ctimeMs: number;
        birthtimeMs: number;
        atime: Date;
        mtime: Date;
        ctime: Date;
        birthtime: Date;
        isFile: () => boolean;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        isBlockDevice: () => boolean;
        isCharacterDevice: () => boolean;
        isFIFO: () => boolean;
        isSocket: () => boolean;
    }>;
    readdirSync(path: string, options?: {
        withFileTypes?: boolean;
    }): string[] | {
        name: string;
        parentPath: string;
        path: string;
        isFile: () => boolean;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        isBlockDevice: () => boolean;
        isCharacterDevice: () => boolean;
        isFIFO: () => boolean;
        isSocket: () => boolean;
    }[];
    readdir(path: string, options?: {
        withFileTypes?: boolean;
    }): Promise<string[] | {
        name: string;
        parentPath: string;
        path: string;
        isFile: () => boolean;
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
        isBlockDevice: () => boolean;
        isCharacterDevice: () => boolean;
        isFIFO: () => boolean;
        isSocket: () => boolean;
    }[]>;
    mkdirSync(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): string | undefined;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<string | undefined>;
    rmdirSync(path: string): void;
    rmdir(path: string): Promise<void>;
    unlinkSync(path: string): void;
    unlink(path: string): Promise<void>;
    renameSync(oldPath: string, newPath: string): void;
    rename(oldPath: string, newPath: string): Promise<void>;
}
declare function createTinyCloudVfs(options: TinyCloudVfsProviderOptions & TinyCloudVfsOptions): {
    provider: TinyCloudVfsProvider;
    vfs: VirtualFileSystem;
};
declare function createTinyCloudVfsFromNode(node: TinyCloudNodeLike, options?: CreateTinyCloudNodeVfsOptions): {
    provider: TinyCloudVfsProvider;
    vfs: VirtualFileSystem;
};
declare function createTinyCloudDelegatedVfs(options: CreateTinyCloudDelegatedVfsOptions): Promise<{
    provider: TinyCloudVfsProvider;
    vfs: VirtualFileSystem;
}>;

export { type CreateTinyCloudDelegatedVfsOptions, type CreateTinyCloudNodeVfsOptions, type TinyCloudVfsMetadata, type TinyCloudVfsOptions, TinyCloudVfsProvider, type TinyCloudVfsProviderOptions, type TinyCloudVfsSessionData, type TinyCloudVfsSource, createTinyCloudDelegatedVfs, createTinyCloudVfs, createTinyCloudVfsFromNode };
