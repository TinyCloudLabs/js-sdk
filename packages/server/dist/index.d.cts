import { Hex } from 'viem';
import { Manifest, TinyCloudNodeConfig, TinyCloudNode, PortableDelegation, InlineEncryptedEnvelope, SecretScopeOptions } from '@tinycloud/node-sdk';

interface DstackKeyClient {
    getKey(path: string, purpose: string): Promise<{
        key: Uint8Array;
    }>;
}
interface DeriveDstackPrivateKeyOptions {
    client: DstackKeyClient;
    path: string;
    purpose: string;
}
declare function deriveDstackPrivateKey(options: DeriveDstackPrivateKeyOptions): Promise<Hex>;
declare function serverDidForPrivateKey(privateKey: string): string;
interface CreateServerIdentityOptions {
    privateKey: string;
    host?: string;
    prefix?: string;
    manifest?: Manifest | Manifest[];
    autoCreateSpace?: boolean;
    enablePublicSpace?: boolean;
    includeAccountRegistryPermissions?: boolean;
    nodeConfig?: Omit<TinyCloudNodeConfig, "privateKey" | "host" | "prefix" | "manifest" | "autoCreateSpace" | "enablePublicSpace" | "includeAccountRegistryPermissions">;
}
interface ServerIdentity {
    node: TinyCloudNode;
    did: string;
    host: string;
    privateKey: string;
}
declare function createServerIdentity(options: CreateServerIdentityOptions): Promise<ServerIdentity>;
declare function isTinyCloudSessionError(error: unknown): boolean;
declare function withSessionRefresh<T>(node: TinyCloudNode, fn: () => Promise<T>): Promise<T>;

type KvLike = {
    get<T = unknown>(key: string, options: {
        raw: true;
        prefix: string;
    }): Promise<{
        ok: true;
        data: T | unknown;
    } | {
        ok: false;
        error?: {
            message?: string;
        };
    }>;
};
type DelegatedAccessLike = {
    kv: KvLike;
    delegation: Pick<PortableDelegation, "cid">;
    restorable?: {
        delegationCid?: string;
    };
};
type DecryptResult = {
    ok: true;
    data: Uint8Array;
} | {
    ok: false;
    error: {
        code?: string;
        message: string;
    };
};
type EncryptionLike = {
    decryptEnvelope(envelope: InlineEncryptedEnvelope, capabilityProof: {
        proofs: string[];
    }): Promise<DecryptResult>;
};
type TinyCloudNodeLike = {
    signIn(): Promise<unknown>;
    useDelegation(delegation: PortableDelegation): Promise<DelegatedAccessLike>;
    encryption: EncryptionLike;
};
type DelegationInput = PortableDelegation | string;
interface ServerDelegateClient {
    getSecret(name: string, options?: SecretScopeOptions): Promise<string>;
}
interface CreateServerDelegateClientOptions {
    privateKey: string;
    host?: string;
    delegation: DelegationInput;
    prefix?: string;
    nodeConfig?: CreateServerIdentityOptions["nodeConfig"];
    node?: TinyCloudNodeLike;
    nodeFactory?: (options: CreateServerIdentityOptions) => Promise<TinyCloudNodeLike>;
}
declare function createServerDelegateClient(options: CreateServerDelegateClientOptions): ServerDelegateClient;
declare function readDelegatedSecret(node: TinyCloudNodeLike | TinyCloudNode, delegation: PortableDelegation, name: string, options?: SecretScopeOptions): Promise<string>;
declare function parseDelegation(delegation: DelegationInput): PortableDelegation;
declare function parseEncryptedEnvelope(rawEnvelope: unknown, name?: string): InlineEncryptedEnvelope;
declare function parseSecretPayload(plaintext: Uint8Array, name?: string): string;

declare class ServerAuthError extends Error {
}
declare class NonceStore {
    private readonly ttlMs;
    private readonly nonces;
    constructor(ttlMs?: number);
    issue(address: string): string;
    validate(address: string, nonce: string): boolean;
    private key;
    private sweep;
}
interface VerifiedSiwe {
    address: string;
    nonce: string;
}
declare function verifySiweMessage(message: string, signature: string): Promise<VerifiedSiwe>;
interface SessionToken {
    token: string;
    expiresIn: number;
}
interface SessionClaims {
    sub: string;
    address: string;
    iat: number;
    exp: number;
}
declare function issueSessionToken(address: string, secret: string, ttlSeconds?: number): SessionToken;
declare function verifySessionToken(token: string, secret: string): {
    address: string;
};
interface CreateSiweSessionOptions {
    jwtSecret: string;
    nonceStore?: NonceStore;
    sessionTtlSeconds?: number;
}
declare function createSiweSession(options: CreateSiweSessionOptions): {
    issueNonce(address: string): string;
    verify(message: string, signature: string): Promise<SessionToken>;
    verifyToken(token: string): {
        address: string;
    };
};

export { type CreateServerDelegateClientOptions, type CreateServerIdentityOptions, type CreateSiweSessionOptions, type DelegationInput, type DeriveDstackPrivateKeyOptions, type DstackKeyClient, NonceStore, ServerAuthError, type ServerDelegateClient, type ServerIdentity, type SessionClaims, type SessionToken, type VerifiedSiwe, createServerDelegateClient, createServerIdentity, createSiweSession, deriveDstackPrivateKey, isTinyCloudSessionError, issueSessionToken, parseDelegation, parseEncryptedEnvelope, parseSecretPayload, readDelegatedSecret, serverDidForPrivateKey, verifySessionToken, verifySiweMessage, withSessionRefresh };
