import {
  TinyCloudSession,
  KVService,
  IKVService,
  HooksService,
  IHooksService,
  SQLService,
  ISQLService,
  DuckDbService,
  IDuckDbService,
  ServiceSession,
  ServiceContext,
  type TelemetryConfig,
} from "@tinycloud/sdk-core";
import {
  parsePermissionHint,
  resolveSecretPath,
  type DataVaultService,
  type EncryptionService,
  type FetchFunction,
  type IEncryptionService,
  type InvokeFunction,
  type InvokeAnyFunction,
  type RequestSink,
} from "@tinycloud/sdk-services";
import { createServiceContext } from "./recordingServiceContext";
import { PortableDelegation } from "./delegation";
import type { DelegatedSecrets } from "./secret-read";
import type { SecretReadResult } from "./TinyCloudNode";

/**
 * Builds the encryption and vault services of a {@link DelegatedAccess}. Both
 * sign with the access's delegated session and target the encryption network
 * of the delegation's owner. `TinyCloudNode.useDelegation` supplies it.
 */
export interface DelegatedEncryptionFactory {
  encryption(): EncryptionService;
  vault(kv: IKVService, encryption: EncryptionService): DataVaultService;
}

/** Input for {@link DelegatedAccess.readSecret}. The space is the delegation's. */
export interface DelegatedSecretReadInput {
  /** Env-style secret name. */
  name: string;
  /** Optional logical secret scope. */
  scope?: string;
}

/**
 * The handles needed to rehydrate this delegation activation in a fresh
 * `TinyCloudNode` via `TinyCloudNode.restoreSession(...)` in another process
 * or after a restart.
 *
 * In wallet mode, `delegationHeader` and `delegationCid` are bound to the
 * session key that ran `useDelegation`. They are NOT intrinsic to the
 * portable delegation — they expire with the server-side session (typically
 * ~1h). To keep a restored node alive longer, re-run `useDelegation` with
 * the original portable delegation and call `restoreSession` again with the
 * fresh `RestorableSession`.
 */
export interface RestorableSession {
  delegationHeader: { Authorization: string };
  delegationCid: string;
  spaceId: string;
  jwk: object;
  verificationMethod: string;
  address: string;
  chainId: number;
}

/**
 * Provides access to a space via a received delegation.
 *
 * This is returned by TinyCloudNode.useDelegation() and provides
 * KV, SQL, DuckDB and hooks operations on the delegated space, plus decrypt
 * and secret reads under the delegation (`encryption`, `readSecret`).
 */
export class DelegatedAccess {
  private session: TinyCloudSession;
  private _delegation: PortableDelegation;
  private host: string;
  private _serviceContext: ServiceContext;
  private _kv: KVService;
  private _sql: SQLService;
  private _duckdb: DuckDbService;
  private _hooks: HooksService;
  private encryptionFactory: DelegatedEncryptionFactory | undefined;
  private _encryption: IEncryptionService | undefined;
  private _secrets: Promise<DelegatedSecrets> | undefined;

  /**
   * @param lifetime - Optional owner of this access: its `fetch` is used for
   *   requests and the service context is registered with `track`, so the
   *   owner can cancel and retire the access (TinyCloudNode does this when its
   *   session is replaced or signed out).
   * @param encryptionFactory - Builds `encryption` and the vault behind
   *   `readSecret`; without it both throw.
   */
  constructor(
    session: TinyCloudSession,
    delegation: PortableDelegation,
    host: string,
    invoke: InvokeFunction,
    invokeAny?: InvokeAnyFunction,
    telemetry?: TelemetryConfig,
    lifetime?: {
      fetch: FetchFunction;
      track(context: ServiceContext): ServiceContext;
      requestSink?: RequestSink;
    },
    encryptionFactory?: DelegatedEncryptionFactory,
  ) {
    this.session = session;
    this._delegation = delegation;
    this.host = host;
    this.encryptionFactory = encryptionFactory;

    // Create service context. invokeAny is required for SQL operations whose
    // statements span multiple actions in a single invocation (e.g. the
    // migration runner batches a CREATE TABLE (ddl) with the tracking-row
    // INSERT (write)); without it those calls throw "multi-resource
    // invocations" not supported.
    const context = createServiceContext({
      invoke,
      invokeAny,
      fetch: lifetime?.fetch ?? globalThis.fetch.bind(globalThis),
      hosts: [host],
      telemetry,
      requestSink: lifetime?.requestSink,
    });
    this._serviceContext = lifetime ? lifetime.track(context) : context;

    // Create and initialize KV service with path prefix from delegation.
    // Strip trailing slash to avoid double-slash in paths. A delegation of
    // several resources has no one prefix: its KV takes full keys.
    const prefix = (this._delegation.resources?.length ?? 0) > 1
      ? undefined
      : this._delegation.path.replace(/\/$/, '');
    this._kv = new KVService({ prefix });
    this._kv.initialize(this._serviceContext);
    this._serviceContext.registerService('kv', this._kv);

    // Create and initialize SQL service with same delegation context
    this._sql = new SQLService({});
    this._sql.initialize(this._serviceContext);
    this._serviceContext.registerService('sql', this._sql);

    // Create and initialize DuckDB service with same delegation context
    this._duckdb = new DuckDbService({});
    this._duckdb.initialize(this._serviceContext);
    this._serviceContext.registerService('duckdb', this._duckdb);

    // Create and initialize Hooks service with same delegation context
    this._hooks = new HooksService({});
    this._hooks.initialize(this._serviceContext);
    this._serviceContext.registerService('hooks', this._hooks);

    // Set session on context
    const serviceSession: ServiceSession = {
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId: session.spaceId,
      verificationMethod: session.verificationMethod,
      jwk: session.jwk,
    };
    this._serviceContext.setSession(serviceSession);
  }

  /**
   * Get the delegation this access was created from.
   */
  get delegation(): PortableDelegation {
    return this._delegation;
  }

  /**
   * The space ID this access is for.
   */
  get spaceId(): string {
    return this._delegation.spaceId;
  }

  /**
   * The path this access is scoped to: the first resource when the delegation carries several
   * (see `resources`).
   */
  get path(): string {
    return this._delegation.path;
  }

  /**
   * Every resource the delegation grants, when it lists them.
   */
  get resources(): PortableDelegation["resources"] {
    return this._delegation.resources;
  }

  /**
   * KV operations on the delegated space.
   */
  get kv(): IKVService {
    return this._kv;
  }

  /**
   * SQL operations on the delegated space.
   */
  get sql(): ISQLService {
    return this._sql;
  }

  /**
   * DuckDB operations on the delegated space.
   */
  get duckdb(): IDuckDbService {
    return this._duckdb;
  }

  /**
   * Hooks write-stream subscriptions on the delegated space.
   */
  get hooks(): IHooksService {
    return this._hooks;
  }

  /**
   * Encryption under this delegation: `decrypt` signs with the delegated
   * session, so it succeeds only for a network the delegation grants
   * `tinycloud.encryption/decrypt` on (the owner's default network for
   * secrets). Works for a session-only recipient: no wallet or SIWE session of
   * its own is needed.
   *
   * `tinycloud.encryption/decrypt` isn't limited to one secret: it covers the owner's default network.
   */
  get encryption(): IEncryptionService {
    if (!this.encryptionFactory) {
      throw new Error("This delegated access was created without encryption.");
    }
    // The service itself loads with the secret-read module on the first call.
    const loaded = async () => (await this.secrets()).encryption;
    return this._encryption ??= {
      config: {},
      initialize() {},
      onSessionChange() {},
      onSignOut() {},
      discoverNetwork: async (...args) => (await loaded()).discoverNetwork(...args),
      encryptToNetwork: async (...args) => (await loaded()).encryptToNetwork(...args),
      decryptEnvelope: async (...args) => (await loaded()).decryptEnvelope(...args),
    };
  }

  /**
   * Read a secret from the delegated space, as `TinyCloudNode.readSecret` does
   * for an explicit space. Needs `tinycloud.kv/get` on the secret's vault
   * record (`vault/secrets/...`) and `tinycloud.encryption/decrypt` on the
   * secret's own key (`<network>/secrets/<name>`, or a `secrets/` prefix) in
   * this delegation; a missing one comes back as `permission_required`. A
   * secret still sealed to the network key opens only when this delegation
   * decrypts with the bare network, else `legacy_envelope` with no node call
   * (TC-3284). Never requests or signs new authority.
   */
  async readSecret(input: DelegatedSecretReadInput): Promise<SecretReadResult> {
    const resolved = resolveSecretPath(input.name, { scope: input.scope });
    return (await this.secrets()).read(resolved.vaultKey, {
      expectAad: true,
      keyPath: resolved.keyPath,
      namedKeyOnly: !(this._delegation.resources ?? [this._delegation]).some((resource) =>
        /^urn:tinycloud:encryption:[^/]+$/.test(resource.path) &&
        resource.actions.some((action) => action.endsWith("decrypt"))),
    });
  }

  /** One load and one set of services per access; a failed load is retried by the next call. */
  private secrets(): Promise<DelegatedSecrets> {
    return this._secrets ??= (async () => {
      // Not a static import on purpose: web-sdk's root size budget has no room for it, so bundlers ship it as its own file.
      const { delegatedSecrets } = await import("./secret-read.js");
      return delegatedSecrets(this._serviceContext, this.encryptionFactory, new KVService({}), parsePermissionHint);
    })().catch((error: unknown) => {
      this._secrets = undefined;
      throw error;
    });
  }

  /**
   * Export the handles needed to rehydrate this activated delegation via
   * `TinyCloudNode.restoreSession(...)` in another process or after a
   * restart.
   *
   * See `RestorableSession` for lifetime caveats.
   */
  get restorable(): RestorableSession {
    return {
      delegationHeader: this.session.delegationHeader,
      delegationCid: this.session.delegationCid,
      spaceId: this.session.spaceId,
      jwk: this.session.jwk,
      verificationMethod: this.session.verificationMethod,
      address: this.session.address,
      chainId: this.session.chainId,
    };
  }
}
