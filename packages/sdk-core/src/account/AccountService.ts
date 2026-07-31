import {
  err,
  ok,
  serviceError,
  ErrorCodes,
  type IDatabaseHandle,
  type IKVService,
  type KVBatchPutItem,
  type QueryResponse,
  type Result,
  type ServiceError,
  type SqlValue,
} from "@tinycloud/sdk-services";
import {
  ACCOUNT_REGISTRY_PATH,
  composeManifestRequest,
  type Manifest,
} from "../manifest";
import { ACCOUNT_INDEX_SCHEMA } from "@tinycloud/bootstrap";
import type {
  AccountDelegationPage,
  AccountDelegationQueryOptions,
  Delegation,
  DelegationRevocationReceipt,
  SpaceInfo,
} from "../delegations/types";
import type { DelegationManager } from "../delegations/DelegationManager";
import type { ISpaceService } from "../spaces/SpaceService";

const SERVICE_NAME = "account";
const ACCOUNT_INDEX_DB = "account";
const ACCOUNT_INDEX_NAMESPACE = "tinycloud.account.index";
const ACCOUNT_SPACES_PATH = "spaces/";

export interface AccountApplication {
  appId: string;
  manifests: Manifest[];
  updatedAt?: string;
  name?: string;
  description?: string;
  manifestHash?: string;
}

export interface AccountSpace {
  spaceId: string;
  name: string;
  ownerDid: string;
  type: "owned" | "delegated" | "discovered";
  permissions: string[];
  status: "active" | "archived";
  registeredAt?: string;
  updatedAt?: string;
  expiresAt?: Date;
}

export interface RegisterBatchSuccess {
  spaces: AccountSpace[];
  /** Present iff the batch write failed ambiguously and per-space
   *  reconciliation recovered it. The original batch error verbatim, so
   *  callers can record the degradation structurally (TC-361). */
  recoveredFromBatchError?: ServiceError;
}

export interface AccountDelegation {
  cid: string;
  direction: "granted" | "received";
  spaceId: string;
  spaceName?: string;
  counterpartyDid: string;
  delegateDid: string;
  delegatorDid?: string;
  path: string;
  actions: string[];
  expiry: Date;
  status: "active" | "expired" | "revoked";
  createdAt?: Date;
}

export interface AccountStatus {
  did: string;
  host: string;
  primarySpaceId?: string;
  accountSpaceId?: string;
  applications: number;
  spaces: number;
  grantedDelegations: number;
  receivedDelegations: number;
}

export interface AccountIndexRebuildResult {
  database: string;
  applications: number;
  spaces: number;
  delegations: number;
  syncedAt: string;
}

export interface AccountIndexEnsureResult {
  database: string;
}

export interface AccountIndexedReadOptions {
  preferIndex?: boolean;
  refreshIndex?: boolean;
}

export type AccountApplicationListOptions = AccountIndexedReadOptions;

export interface AccountApplicationRegisterOptions {
  /**
   * Skip the `application_state` manifest-hash pre-read that normally
   * short-circuits a redundant write.
   *
   * The pre-read is a saving only when the application is already registered
   * with the same manifest hash. On a freshly bootstrapped account it is
   * definitionally a miss, so it costs a round trip and buys nothing — and the
   * write it guards is an `INSERT OR REPLACE`, so performing it unconditionally
   * is idempotent. Set this only when the caller knows the record cannot
   * already be current (i.e. the account bootstrap path).
   */
  assumeUnregistered?: boolean;
}

export type AccountSpaceListOptions = AccountIndexedReadOptions;

export interface AccountDelegationListOptions {
  direction?: "granted" | "received" | "all";
  space?: string;
  preferIndex?: boolean;
  refreshIndex?: boolean;
}

export interface AccountDelegationRevokeOptions {
  cid: string;
  space: string;
}

export interface AccountServiceConfig {
  getDid: () => string;
  getHost: () => string;
  getPrimarySpaceId: () => string | undefined;
  getAccountSpaceId: () => string | undefined;
  getSpaces: () => ISpaceService;
  getDelegationManager?: () => Pick<DelegationManager, "query" | "revoke">;
  getAccountDb?: () => IDatabaseHandle | undefined;
  ensureAccountSpaceHosted?: () => Promise<void>;
}

export class AccountService {
  /**
   * Per-account-space memo for {@link ensureAccountIndex}.
   *
   * Applying the index migration is a no-op once the schema exists, but the
   * SQL service still spends two round trips discovering that (create the
   * migrations table, then read the applied-migration rows). Account bootstrap
   * touches the index eight times, so without a memo that is ~14 wasted
   * requests on the cold sign-in path. The in-flight dedupe inside SQLService
   * never helps here: the node SDK builds a fresh SQLService per
   * `getAccountDb()` call, so its lock map is always empty.
   *
   * Keyed by account space id, so a different account never reuses this entry.
   * Failures are evicted so a later call retries instead of inheriting a
   * permanently poisoned result.
   */
  private readonly accountIndexReady = new Map<string, Promise<Result<void>>>();

  constructor(private readonly config: AccountServiceConfig) {}

  async status(): Promise<Result<AccountStatus>> {
    const apps = await this.applications.list();
    if (!apps.ok) return apps;

    const delegations = await this.delegations.list();
    if (!delegations.ok) return delegations;

    const spaces = await this.spaces.list();
    if (!spaces.ok) return spaces;

    return ok({
      did: this.config.getDid(),
      host: this.config.getHost(),
      primarySpaceId: this.config.getPrimarySpaceId(),
      accountSpaceId: this.config.getAccountSpaceId(),
      applications: apps.data.length,
      spaces: spaces.data.length,
      grantedDelegations: delegations.data.filter((d) => d.direction === "granted").length,
      receivedDelegations: delegations.data.filter((d) => d.direction === "received").length,
    });
  }

  readonly applications = {
    list: async (options: AccountApplicationListOptions = {}): Promise<Result<AccountApplication[]>> => {
      if (options.preferIndex) {
        const indexed = await this.index.applications.list();
        if (indexed.ok && indexed.data.length > 0) return indexed;
        if (!indexed.ok && !isMissingIndexError(indexed.error)) return indexed;

        const canonical = await this.applications.list();
        if (canonical.ok && options.refreshIndex !== false) {
          await this.replaceApplicationsIndexQuietly(canonical.data);
        }
        return canonical;
      }

      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      const listed = await kvResult.data.list({ prefix: ACCOUNT_REGISTRY_PATH });
      if (!listed.ok) return accountErr(listed.error);

      const applications: AccountApplication[] = [];
      for (const key of listed.data.keys) {
        const loaded = await kvResult.data.get<StoredApplicationRecord>(key);
        if (!loaded.ok) return accountErr(loaded.error);
        applications.push(applicationFromRecord(key, loaded.data.data));
      }

      applications.sort((a, b) => a.appId.localeCompare(b.appId));
      return ok(applications);
    },

    get: async (appId: string): Promise<Result<AccountApplication>> => {
      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      const key = applicationKey(appId);
      const loaded = await kvResult.data.get<StoredApplicationRecord>(key);
      if (!loaded.ok) return accountErr(loaded.error);
      return ok(applicationFromRecord(key, loaded.data.data));
    },

    register: async (
      manifest: Manifest | Manifest[],
      options: AccountApplicationRegisterOptions = {},
    ): Promise<Result<AccountApplication>> => {
      const manifests = Array.isArray(manifest) ? manifest : [manifest];
      const request = composeManifestRequest(manifests);
      if (request.registryRecords.length === 0) {
        return err(
          serviceError(
            "INVALID_MANIFEST",
            "Manifest did not produce an account application registry record",
            SERVICE_NAME,
          ),
        );
      }

      await this.config.ensureAccountSpaceHosted?.();

      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      let registered: AccountApplication | undefined;
      for (const record of request.registryRecords) {
        const manifestHash = hashJson(record.manifests);
        if (
          !options.assumeUnregistered &&
          (await this.indexHasApplicationHash(record.app_id, manifestHash))
        ) {
          registered = {
            appId: record.app_id,
            manifests: record.manifests,
            manifestHash,
            name: record.manifests[0]?.name,
            description: record.manifests[0]?.description,
          };
          continue;
        }

        const stored = {
          app_id: record.app_id,
          manifests: record.manifests,
          manifest_hash: manifestHash,
          updated_at: new Date().toISOString(),
        };
      const written = await kvResult.data.put(record.key, stored);
      if (!written.ok) return accountErr(written.error);
      registered = applicationFromRecord(record.key, stored);
      await this.upsertApplicationIndexQuietly(registered);
      }

      return ok(registered!);
    },

    remove: async (appId: string): Promise<Result<void>> => {
      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      const removed = await kvResult.data.delete(applicationKey(appId));
      if (!removed.ok) return accountErr(removed.error);
      await this.deleteApplicationIndexQuietly(appId);
      return ok(undefined);
    },
  };

  readonly spaces = {
    list: async (options: AccountSpaceListOptions = {}): Promise<Result<AccountSpace[]>> => {
      if (options.preferIndex) {
        const indexed = await this.index.spaces.list();
        if (indexed.ok && indexed.data.length > 0) return indexed;
        if (!indexed.ok && !isMissingIndexError(indexed.error)) return indexed;

        const canonical = await this.spaces.syncAccessible();
        if (canonical.ok && options.refreshIndex !== false) {
          await this.replaceSpacesIndexQuietly(canonical.data);
        }
        return canonical;
      }

      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      const listed = await kvResult.data.list({ prefix: ACCOUNT_SPACES_PATH });
      if (!listed.ok) return accountErr(listed.error);

      const spaces: AccountSpace[] = [];
      for (const key of listed.data.keys) {
        const loaded = await kvResult.data.get<StoredSpaceRecord>(key);
        if (!loaded.ok) return accountErr(loaded.error);
        spaces.push(spaceFromRecord(key, loaded.data.data));
      }

      spaces.sort((a, b) => a.name.localeCompare(b.name) || a.spaceId.localeCompare(b.spaceId));
      return ok(spaces);
    },

    get: async (spaceId: string): Promise<Result<AccountSpace>> => {
      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      const loaded = await kvResult.data.get<StoredSpaceRecord>(spaceKey(spaceId));
      if (!loaded.ok) return accountErr(loaded.error);
      return ok(spaceFromRecord(spaceKey(spaceId), loaded.data.data));
    },

    register: async (space: SpaceInfo | AccountSpace): Promise<Result<AccountSpace>> => {
      await this.config.ensureAccountSpaceHosted?.();

      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      const stored = spaceRecordFromInput(space);
      const written = await kvResult.data.put(spaceKey(stored.space_id), stored);
      if (!written.ok) return accountErr(written.error);

      const registered = spaceFromRecord(spaceKey(stored.space_id), stored);
      await this.upsertSpaceIndexQuietly(registered);
      return ok(registered);
    },

    /**
     * Register multiple spaces in one KV batch write + one multi-row index
     * write, instead of one `register()` round trip per space (TC-373).
     *
     * The stored records are computed exactly once and reused for both the
     * batch attempt and any reconciliation below, so a fallback never mints a
     * fresh timestamp for a space that already has a written record — a
     * second `spaceRecordFromInput` call would produce a new content hash and
     * leave the first attempt's blocks orphaned.
     */
    registerBatch: async (
      spaces: readonly (SpaceInfo | AccountSpace)[],
    ): Promise<Result<RegisterBatchSuccess>> => {
      if (spaces.length === 0) return ok({ spaces: [] });

      await this.config.ensureAccountSpaceHosted?.();

      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      const stored = spaces.map((space) => spaceRecordFromInput(space));
      const registered = stored.map((record) =>
        spaceFromRecord(spaceKey(record.space_id), record),
      );
      const items: KVBatchPutItem[] = stored.map((record) => ({
        key: spaceKey(record.space_id),
        value: record,
      }));

      const batchResult = await kvResult.data.batchPut(items);

      if (batchResult.ok) {
        // Index write is derived/best-effort: its failure must never cause a
        // KV rewrite, so it stays on the existing "quietly" path.
        await this.upsertSpacesIndexQuietly(registered);
        return ok({ spaces: registered });
      }

      if (!isAmbiguousBatchFailure(batchResult.error)) {
        return accountErr(batchResult.error);
      }

      // Ambiguous transport failure: the node's content-addressed block store
      // can persist writes before (or independently of) the response that
      // reports success, so "the batch errored" does not mean "nothing was
      // written". Reconcile with per-space puts using the SAME precomputed
      // bytes: anything that already landed is an idempotent overwrite, not a
      // new differently-timestamped blob.
      const reconcileFailures: string[] = [];
      for (const record of stored) {
        const written = await kvResult.data.put(spaceKey(record.space_id), record);
        if (!written.ok) {
          reconcileFailures.push(`${record.space_id}: ${written.error.message}`);
        }
      }

      if (reconcileFailures.length > 0) {
        return err(
          serviceError(
            "KV_BATCH_RECONCILE_FAILED",
            `KV batch write for ${items.length} space(s) failed ambiguously (${batchResult.error.message}) and per-space reconciliation also failed for: ${reconcileFailures.join("; ")}`,
            SERVICE_NAME,
            { cause: batchResult.error.cause, meta: { originalError: batchResult.error } },
          ),
        );
      }

      // Reconciliation succeeded, but the batch's own error must not vanish
      // silently — that exact swallow is what turns an ambiguous transport
      // failure into an undiagnosable half-provisioned account later.
      console.warn(
        `[AccountService] KV batch write for ${items.length} space(s) returned an ambiguous error and was reconciled via per-space fallback. Original error: ${batchResult.error.message}`,
      );

      await this.upsertSpacesIndexQuietly(registered);
      return ok({ spaces: registered, recoveredFromBatchError: batchResult.error });
    },

    syncAccessible: async (): Promise<Result<AccountSpace[]>> => {
      const listed = await this.config.getSpaces().list();
      if (!listed.ok) return accountErr(listed.error);

      const registered: AccountSpace[] = [];
      for (const space of listed.data) {
        const result = await this.spaces.register(space);
        if (!result.ok) return result;
        registered.push(result.data);
      }
      return ok(registered);
    },

    remove: async (spaceId: string): Promise<Result<void>> => {
      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      const removed = await kvResult.data.delete(spaceKey(spaceId));
      if (!removed.ok) return accountErr(removed.error);
      await this.deleteSpaceIndexQuietly(spaceId);
      return ok(undefined);
    },
  };

  readonly delegations = {
    query: async (
      options: AccountDelegationQueryOptions = {},
    ): Promise<Result<AccountDelegationPage>> => {
      const manager = this.config.getDelegationManager?.();
      if (!manager) {
        return err(serviceError(
          "NOT_INITIALIZED",
          "Delegation history requires an authenticated delegation manager",
          SERVICE_NAME,
        ));
      }
      const queried = await manager.query(options);
      return queried.ok ? ok(queried.data) : accountErr(queried.error);
    },

    list: async (
      options: AccountDelegationListOptions = {},
    ): Promise<Result<AccountDelegation[]>> => {
      if (options.preferIndex) {
        const indexed = await this.index.delegations.list(options);
        if (indexed.ok && indexed.data.length > 0) return indexed;
        if (!indexed.ok && !isMissingIndexError(indexed.error)) return indexed;

        const live = await this.delegations.list({
          direction: options.direction,
          space: options.space,
        });
        if (live.ok && options.refreshIndex !== false) {
          await this.replaceDelegationsIndexQuietly(live.data);
        }
        return live;
      }

      const spaces = await this.config.getSpaces().list();
      if (!spaces.ok) return accountErr(spaces.error);

      const targetSpaces = options.space
        ? spaces.data.filter((space) => space.id === options.space || space.name === options.space)
        : spaces.data;

      const delegations: AccountDelegation[] = [];
      for (const space of targetSpaces) {
        const scoped = this.config.getSpaces().get(space.id).delegations;

        if (options.direction !== "received") {
          const granted = await scoped.list();
          if (!granted.ok) return accountErr(granted.error);
          delegations.push(...granted.data.map((d) => mapDelegation(d, space, "granted")));
        }

        if (options.direction !== "granted") {
          const received = await scoped.listReceived();
          if (!received.ok) return accountErr(received.error);
          delegations.push(...received.data.map((d) => mapDelegation(d, space, "received")));
        }
      }

      delegations.sort((a, b) => a.spaceId.localeCompare(b.spaceId) || a.cid.localeCompare(b.cid));
      return ok(delegations);
    },

    revoke: async (
      input: string | AccountDelegationRevokeOptions,
    ): Promise<Result<DelegationRevocationReceipt | void>> => {
      const cid = typeof input === "string" ? input : input.cid;
      const manager = this.config.getDelegationManager?.();
      if (manager) {
        const revoked = await manager.revoke(cid);
        return revoked.ok ? ok(revoked.data) : accountErr(revoked.error);
      }

      // Deprecated compatibility path for callers constructing AccountService directly.
      if (typeof input === "string") {
        return err(serviceError(
          "NOT_INITIALIZED",
          "CID-only revocation requires an authenticated delegation manager",
          SERVICE_NAME,
        ));
      }
      const space = await this.resolveSpace(input.space);
      if (!space.ok) return space;
      const revoked = await this.config.getSpaces().get(space.data.id).delegations.revoke(cid);
      if (!revoked.ok) return accountErr(revoked.error);
      return ok(undefined);
    },
  };

  readonly index = {
    ensure: async (): Promise<Result<AccountIndexEnsureResult>> => {
      const dbResult = this.accountDb();
      if (!dbResult.ok) return dbResult;

      const schema = await this.ensureAccountIndex(dbResult.data);
      if (!schema.ok) return schema;

      return ok({ database: ACCOUNT_INDEX_DB });
    },

    rebuild: async (): Promise<Result<AccountIndexRebuildResult>> => {
      const dbResult = this.accountDb();
      if (!dbResult.ok) return dbResult;

      const applications = await this.applications.list();
      if (!applications.ok) return applications;

      const spaces = await this.spaces.list();
      if (!spaces.ok) return spaces;

      const delegations = await this.delegations.list();
      if (!delegations.ok) return delegations;

      const syncedAt = new Date().toISOString();
      // `rebuild` is the explicit repair entry point: re-verify the schema
      // server-side instead of trusting the per-space memo.
      this.invalidateAccountIndexMemo();
      const schema = await this.ensureAccountIndex(dbResult.data);
      if (!schema.ok) return schema;

      const statements = [
        { sql: "DELETE FROM applications" },
        { sql: "DELETE FROM application_state" },
        { sql: "DELETE FROM spaces" },
        { sql: "DELETE FROM delegations" },
        { sql: "DELETE FROM sync_state" },
        ...applications.data.map((app) => ({
          sql:
            "INSERT INTO applications (app_id, name, description, updated_at, manifest_json) VALUES (?, ?, ?, ?, ?)",
          params: [
            app.appId,
            app.name ?? null,
            app.description ?? null,
            app.updatedAt ?? syncedAt,
            JSON.stringify(app.manifests),
          ],
        })),
        ...applications.data.map((app) => ({
          sql:
            "INSERT OR REPLACE INTO application_state (app_id, manifest_hash, indexed_at) VALUES (?, ?, ?)",
          params: [app.appId, app.manifestHash ?? hashJson(app.manifests), syncedAt],
        })),
        ...spaces.data.map((space) => ({
          sql:
            "INSERT OR REPLACE INTO spaces (space_id, name, owner_did, type, permissions_json, status, registered_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [
            space.spaceId,
            space.name,
            space.ownerDid,
            space.type,
            JSON.stringify(space.permissions),
            space.status,
            space.registeredAt ?? syncedAt,
            space.updatedAt ?? syncedAt,
            space.expiresAt?.toISOString() ?? null,
          ],
        })),
        ...delegations.data.map((delegation) => ({
          sql:
            "INSERT INTO delegations (cid, direction, space_id, space_name, counterparty_did, delegate_did, delegator_did, path, actions_json, expiry, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [
            delegation.cid,
            delegation.direction,
            delegation.spaceId,
            delegation.spaceName ?? null,
            delegation.counterpartyDid,
            delegation.delegateDid,
            delegation.delegatorDid ?? null,
            delegation.path,
            JSON.stringify(delegation.actions),
            delegation.expiry.toISOString(),
            delegation.status,
            delegation.createdAt?.toISOString() ?? null,
            syncedAt,
          ],
        })),
        {
          sql: "INSERT INTO sync_state (source, synced_at, count) VALUES (?, ?, ?)",
          params: ["applications", syncedAt, applications.data.length],
        },
        {
          sql: "INSERT INTO sync_state (source, synced_at, count) VALUES (?, ?, ?)",
          params: ["spaces", syncedAt, spaces.data.length],
        },
        {
          sql: "INSERT INTO sync_state (source, synced_at, count) VALUES (?, ?, ?)",
          params: ["delegations", syncedAt, delegations.data.length],
        },
      ];

      const rebuilt = await dbResult.data.batch(statements);
      if (!rebuilt.ok) return accountErr(rebuilt.error);

      return ok({
        database: ACCOUNT_INDEX_DB,
        applications: applications.data.length,
        spaces: spaces.data.length,
        delegations: delegations.data.length,
        syncedAt,
      });
    },

    applications: {
      list: async (): Promise<Result<AccountApplication[]>> => {
        const dbResult = this.accountDb();
        if (!dbResult.ok) return dbResult;

        const queried = await dbResult.data.query<string | null>(
          "SELECT applications.app_id, name, description, updated_at, manifest_json, application_state.manifest_hash FROM applications LEFT JOIN application_state ON applications.app_id = application_state.app_id ORDER BY applications.app_id",
        );
        if (!queried.ok) return accountErr(queried.error);

        return ok((queried.data.rows as unknown as IndexedApplicationRow[]).map(indexedApplicationFromRow));
      },
    },

    spaces: {
      list: async (): Promise<Result<AccountSpace[]>> => {
        const dbResult = this.accountDb();
        if (!dbResult.ok) return dbResult;

        const queried = await dbResult.data.query<string | null>(
          "SELECT space_id, name, owner_did, type, permissions_json, status, registered_at, updated_at, expires_at FROM spaces ORDER BY name, space_id",
        );
        if (!queried.ok) return accountErr(queried.error);

        return ok((queried.data.rows as unknown as IndexedSpaceRow[]).map(indexedSpaceFromRow));
      },
    },

    delegations: {
      list: async (
        options: AccountDelegationListOptions = {},
      ): Promise<Result<AccountDelegation[]>> => {
        const dbResult = this.accountDb();
        if (!dbResult.ok) return dbResult;

        const where: string[] = [];
        const params: SqlValue[] = [];
        if (options.direction && options.direction !== "all") {
          where.push("direction = ?");
          params.push(options.direction);
        }
        if (options.space) {
          where.push("(space_id = ? OR space_name = ?)");
          params.push(options.space, options.space);
        }

        const queried = await dbResult.data.query<string | null>(
          `SELECT cid, direction, space_id, space_name, counterparty_did, delegate_did, delegator_did, path, actions_json, expiry, status, created_at FROM delegations${
            where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
          } ORDER BY space_id, cid`,
          params,
        );
        if (!queried.ok) return accountErr(queried.error);

        return ok((queried.data.rows as unknown as IndexedDelegationRow[]).map(indexedDelegationFromRow));
      },
    },

    query: async <T = Record<string, unknown>>(
      sql: string,
      params?: SqlValue[],
    ): Promise<Result<QueryResponse<T>>> => {
      const dbResult = this.accountDb();
      if (!dbResult.ok) return dbResult;
      const queried = await dbResult.data.query<T>(sql, params);
      if (!queried.ok) return accountErr(queried.error);
      return ok(queried.data);
    },

    status: async (): Promise<Result<AccountIndexStatus>> => {
      const dbResult = this.accountDb();
      if (!dbResult.ok) return dbResult;
      const queried = await dbResult.data.query<string | number>(
        "SELECT source, synced_at, count FROM sync_state ORDER BY source",
      );
      if (!queried.ok) {
        if (isMissingIndexError(queried.error)) {
          return ok({ database: ACCOUNT_INDEX_DB, state: "missing", sources: [] });
        }
        return accountErr(queried.error);
      }
      return ok({
        database: ACCOUNT_INDEX_DB,
        state: "ready",
        sources: (queried.data.rows as unknown as IndexedSyncStateRow[]).map(([source, syncedAt, count]) => ({
          source,
          syncedAt,
          count,
        })),
      });
    },
  };

  private accountKV(): Result<IKVService> {
    const accountSpaceId = this.config.getAccountSpaceId();
    if (!accountSpaceId) {
      return err(
        serviceError(
          "ACCOUNT_SPACE_UNAVAILABLE",
          "Account space is unavailable. Sign in with a wallet-backed profile first.",
          SERVICE_NAME,
        ),
      );
    }
    return ok(this.config.getSpaces().get(accountSpaceId).kv);
  }

  private accountDb(): Result<IDatabaseHandle> {
    const db = this.config.getAccountDb?.();
    if (!db) {
      return err(
        serviceError(
          "ACCOUNT_INDEX_UNAVAILABLE",
          "Account index database is unavailable. Sign in with a wallet-backed profile first.",
          SERVICE_NAME,
        ),
      );
    }
    return ok(db);
  }

  private async indexHasApplicationHash(appId: string, manifestHash: string): Promise<boolean> {
    const dbResult = this.accountDb();
    if (!dbResult.ok) return false;

    const schema = await this.ensureAccountIndex(dbResult.data);
    if (!schema.ok) return false;

    const queried = await dbResult.data.query<string>(
      "SELECT 1 FROM application_state WHERE app_id = ? AND manifest_hash = ? LIMIT 1",
      [appId, manifestHash],
    );
    return queried.ok && queried.data.rows.length > 0;
  }

  private async upsertApplicationIndexQuietly(app: AccountApplication): Promise<void> {
    await ignoreIndexFailure(() => this.upsertApplicationIndex(app));
  }

  private async upsertApplicationIndex(app: AccountApplication): Promise<Result<void>> {
    const dbResult = this.accountDb();
    if (!dbResult.ok) return ok(undefined);

    const schema = await this.ensureAccountIndex(dbResult.data);
    if (!schema.ok) return schema;

    const updatedAt = app.updatedAt ?? new Date().toISOString();
    const manifestHash = app.manifestHash ?? hashJson(app.manifests);
    const written = await dbResult.data.batch([
      {
        sql:
          "INSERT OR REPLACE INTO applications (app_id, name, description, updated_at, manifest_json) VALUES (?, ?, ?, ?, ?)",
        params: [
          app.appId,
          app.name ?? null,
          app.description ?? null,
          updatedAt,
          JSON.stringify(app.manifests),
        ],
      },
      {
        sql:
          "INSERT OR REPLACE INTO application_state (app_id, manifest_hash, indexed_at) VALUES (?, ?, ?)",
        params: [app.appId, manifestHash, updatedAt],
      },
    ]);
    if (!written.ok) return accountErr(written.error);
    return ok(undefined);
  }

  private async deleteApplicationIndexQuietly(appId: string): Promise<void> {
    await ignoreIndexFailure(() => this.deleteApplicationIndex(appId));
  }

  private async deleteApplicationIndex(appId: string): Promise<Result<void>> {
    const dbResult = this.accountDb();
    if (!dbResult.ok) return ok(undefined);
    const schema = await this.ensureAccountIndex(dbResult.data);
    if (!schema.ok) return schema;

    const deleted = await dbResult.data.batch([
      { sql: "DELETE FROM applications WHERE app_id = ?", params: [appId] },
      { sql: "DELETE FROM application_state WHERE app_id = ?", params: [appId] },
    ]);
    if (!deleted.ok) return accountErr(deleted.error);
    return ok(undefined);
  }

  private async upsertSpaceIndexQuietly(space: AccountSpace): Promise<void> {
    await ignoreIndexFailure(() => this.upsertSpaceIndex(space));
  }

  private async upsertSpaceIndex(space: AccountSpace): Promise<Result<void>> {
    const dbResult = this.accountDb();
    if (!dbResult.ok) return ok(undefined);
    const schema = await this.ensureAccountIndex(dbResult.data);
    if (!schema.ok) return schema;

    const updatedAt = space.updatedAt ?? new Date().toISOString();
    const written = await dbResult.data.batch([
      {
        sql:
          "INSERT OR REPLACE INTO spaces (space_id, name, owner_did, type, permissions_json, status, registered_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params: [
          space.spaceId,
          space.name,
          space.ownerDid,
          space.type,
          JSON.stringify(space.permissions),
          space.status,
          space.registeredAt ?? updatedAt,
          updatedAt,
          space.expiresAt?.toISOString() ?? null,
        ],
      },
    ]);
    if (!written.ok) return accountErr(written.error);
    return ok(undefined);
  }

  private async upsertSpacesIndexQuietly(spaces: AccountSpace[]): Promise<void> {
    await ignoreIndexFailure(() => this.upsertSpacesIndex(spaces));
  }

  /**
   * Upsert multiple space index rows in ONE multi-row `INSERT OR REPLACE`
   * statement (TC-373), rather than one statement per space. This matters
   * because `IDatabaseHandle.batch()` executes its statement list as a plain
   * loop, not a single database transaction — an N-statement batch is not
   * atomic. A single multi-row INSERT is one SQLite statement, so it applies
   * atomically: all rows or none.
   */
  private async upsertSpacesIndex(spaces: AccountSpace[]): Promise<Result<void>> {
    if (spaces.length === 0) return ok(undefined);

    const dbResult = this.accountDb();
    if (!dbResult.ok) return ok(undefined);
    const schema = await this.ensureAccountIndex(dbResult.data);
    if (!schema.ok) return schema;

    const placeholders = spaces.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = spaces.flatMap((space) => {
      const updatedAt = space.updatedAt ?? new Date().toISOString();
      return [
        space.spaceId,
        space.name,
        space.ownerDid,
        space.type,
        JSON.stringify(space.permissions),
        space.status,
        space.registeredAt ?? updatedAt,
        updatedAt,
        space.expiresAt?.toISOString() ?? null,
      ];
    });

    const written = await dbResult.data.batch([
      {
        sql:
          `INSERT OR REPLACE INTO spaces (space_id, name, owner_did, type, permissions_json, status, registered_at, updated_at, expires_at) VALUES ${placeholders}`,
        params,
      },
    ]);
    if (!written.ok) return accountErr(written.error);
    return ok(undefined);
  }

  private async deleteSpaceIndexQuietly(spaceId: string): Promise<void> {
    await ignoreIndexFailure(() => this.deleteSpaceIndex(spaceId));
  }

  private async deleteSpaceIndex(spaceId: string): Promise<Result<void>> {
    const dbResult = this.accountDb();
    if (!dbResult.ok) return ok(undefined);
    const schema = await this.ensureAccountIndex(dbResult.data);
    if (!schema.ok) return schema;

    const deleted = await dbResult.data.batch([
      { sql: "DELETE FROM spaces WHERE space_id = ?", params: [spaceId] },
    ]);
    if (!deleted.ok) return accountErr(deleted.error);
    return ok(undefined);
  }

  private async resolveSpace(space: string): Promise<Result<SpaceInfo>> {
    const listed = await this.config.getSpaces().list();
    if (!listed.ok) return accountErr(listed.error);

    const found = listed.data.find((candidate) => candidate.id === space || candidate.name === space);
    if (!found) {
      return err(
        serviceError("SPACE_NOT_FOUND", `No account space found for ${JSON.stringify(space)}`, SERVICE_NAME),
      );
    }
    return ok(found);
  }

  private async replaceApplicationsIndexQuietly(applications: AccountApplication[]): Promise<void> {
    await ignoreIndexFailure(async () => {
      const dbResult = this.accountDb();
      if (!dbResult.ok) return;
      const syncedAt = new Date().toISOString();
      const schema = await this.ensureAccountIndex(dbResult.data);
      if (!schema.ok) return;

      await dbResult.data.batch([
        { sql: "DELETE FROM applications" },
        { sql: "DELETE FROM application_state" },
        ...applications.map((app) => ({
          sql:
            "INSERT OR REPLACE INTO applications (app_id, name, description, updated_at, manifest_json) VALUES (?, ?, ?, ?, ?)",
          params: [
            app.appId,
            app.name ?? null,
            app.description ?? null,
            app.updatedAt ?? syncedAt,
            JSON.stringify(app.manifests),
          ],
        })),
        ...applications.map((app) => ({
          sql:
            "INSERT OR REPLACE INTO application_state (app_id, manifest_hash, indexed_at) VALUES (?, ?, ?)",
          params: [app.appId, app.manifestHash ?? hashJson(app.manifests), syncedAt],
        })),
        {
          sql: "INSERT OR REPLACE INTO sync_state (source, synced_at, count) VALUES (?, ?, ?)",
          params: ["applications", syncedAt, applications.length],
        },
      ]);
    });
  }

  private async replaceSpacesIndexQuietly(spaces: AccountSpace[]): Promise<void> {
    await ignoreIndexFailure(async () => {
      const dbResult = this.accountDb();
      if (!dbResult.ok) return;
      const syncedAt = new Date().toISOString();
      const schema = await this.ensureAccountIndex(dbResult.data);
      if (!schema.ok) return;

      await dbResult.data.batch([
        { sql: "DELETE FROM spaces" },
        ...spaces.map((space) => ({
          sql:
            "INSERT OR REPLACE INTO spaces (space_id, name, owner_did, type, permissions_json, status, registered_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [
            space.spaceId,
            space.name,
            space.ownerDid,
            space.type,
            JSON.stringify(space.permissions),
            space.status,
            space.registeredAt ?? syncedAt,
            space.updatedAt ?? syncedAt,
            space.expiresAt?.toISOString() ?? null,
          ],
        })),
        {
          sql: "INSERT OR REPLACE INTO sync_state (source, synced_at, count) VALUES (?, ?, ?)",
          params: ["spaces", syncedAt, spaces.length],
        },
      ]);
    });
  }

  private async replaceDelegationsIndexQuietly(delegations: AccountDelegation[]): Promise<void> {
    await ignoreIndexFailure(async () => {
      const dbResult = this.accountDb();
      if (!dbResult.ok) return;
      const syncedAt = new Date().toISOString();
      const schema = await this.ensureAccountIndex(dbResult.data);
      if (!schema.ok) return;

      await dbResult.data.batch([
        { sql: "DELETE FROM delegations" },
        ...delegations.map((delegation) => ({
          sql:
            "INSERT OR REPLACE INTO delegations (cid, direction, space_id, space_name, counterparty_did, delegate_did, delegator_did, path, actions_json, expiry, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [
            delegation.cid,
            delegation.direction,
            delegation.spaceId,
            delegation.spaceName ?? null,
            delegation.counterpartyDid,
            delegation.delegateDid,
            delegation.delegatorDid ?? null,
            delegation.path,
            JSON.stringify(delegation.actions),
            delegation.expiry.toISOString(),
            delegation.status,
            delegation.createdAt?.toISOString() ?? null,
            syncedAt,
          ],
        })),
        {
          sql: "INSERT OR REPLACE INTO sync_state (source, synced_at, count) VALUES (?, ?, ?)",
          params: ["delegations", syncedAt, delegations.length],
        },
      ]);
    });
  }

  /**
   * Apply the account index schema at most once per account space.
   *
   * The index is a cache over canonical KV state, and every caller already
   * tolerates it being absent (`ignoreIndexFailure` / `isMissingIndexError`),
   * so a memo that is wrong in the "already applied" direction degrades to a
   * `no such table` read that the caller handles. A memo that is wrong in the
   * other direction would be a real bug, so failures are never cached.
   */
  private async ensureAccountIndex(db: IDatabaseHandle): Promise<Result<void>> {
    const key = this.config.getAccountSpaceId() ?? "";
    const cached = this.accountIndexReady.get(key);
    if (cached) return cached;

    const pending = this.applyAccountIndex(db);
    this.accountIndexReady.set(key, pending);

    // Only evict our own entry: a concurrent caller may already have installed
    // a fresh attempt by the time this one settles.
    const evict = () => {
      if (this.accountIndexReady.get(key) === pending) {
        this.accountIndexReady.delete(key);
      }
    };

    let settled: Result<void>;
    try {
      settled = await pending;
    } catch (error) {
      evict();
      throw error;
    }
    if (!settled.ok) evict();
    return settled;
  }

  /** Drop the memo so the next {@link ensureAccountIndex} re-applies the schema. */
  private invalidateAccountIndexMemo(): void {
    this.accountIndexReady.delete(this.config.getAccountSpaceId() ?? "");
  }

  private async applyAccountIndex(db: IDatabaseHandle): Promise<Result<void>> {
    const migrated = await db.migrations.apply({
      namespace: ACCOUNT_INDEX_NAMESPACE,
      migrations: [
        {
          id: "001_initial",
          sql: [...ACCOUNT_INDEX_SCHEMA],
        },
      ],
    });
    if (!migrated.ok) return accountErr(migrated.error);
    return ok(undefined);
  }
}

interface StoredApplicationRecord {
  app_id?: string;
  appId?: string;
  manifests?: Manifest[];
  manifest_hash?: string;
  manifestHash?: string;
  updated_at?: string;
  updatedAt?: string;
}

function applicationKey(appId: string): string {
  return `${ACCOUNT_REGISTRY_PATH}${appId}`;
}

function appIdFromKey(key: string): string {
  return key.startsWith(ACCOUNT_REGISTRY_PATH) ? key.slice(ACCOUNT_REGISTRY_PATH.length) : key;
}

function applicationFromRecord(key: string, record: StoredApplicationRecord): AccountApplication {
  const manifests = Array.isArray(record.manifests) ? record.manifests : [];
  const first = manifests[0];
  return {
    appId: record.app_id ?? record.appId ?? first?.app_id ?? appIdFromKey(key),
    manifests,
    updatedAt: record.updated_at ?? record.updatedAt,
    name: first?.name,
    description: first?.description,
    manifestHash: record.manifest_hash ?? record.manifestHash ?? hashJson(manifests),
  };
}

type IndexedApplicationRow = [string, string | null, string | null, string | null, string, string | null];

function indexedApplicationFromRow(row: IndexedApplicationRow): AccountApplication {
  const [appId, name, description, updatedAt, manifestJson, manifestHash] = row;
  return {
    appId,
    name: name ?? undefined,
    description: description ?? undefined,
    updatedAt: updatedAt ?? undefined,
    manifests: JSON.parse(manifestJson) as Manifest[],
    manifestHash: manifestHash ?? undefined,
  };
}

interface StoredSpaceRecord {
  space_id?: string;
  spaceId?: string;
  name?: string;
  owner_did?: string;
  ownerDid?: string;
  owner?: string;
  type?: "owned" | "delegated" | "discovered";
  permissions?: string[];
  status?: "active" | "archived";
  registered_at?: string;
  registeredAt?: string;
  updated_at?: string;
  updatedAt?: string;
  expires_at?: string;
  expiresAt?: string | Date;
}

function spaceKey(spaceId: string): string {
  return `${ACCOUNT_SPACES_PATH}${spaceId}`;
}

function spaceIdFromKey(key: string): string {
  return key.startsWith(ACCOUNT_SPACES_PATH) ? key.slice(ACCOUNT_SPACES_PATH.length) : key;
}

function spaceRecordFromInput(space: SpaceInfo | AccountSpace): Required<Pick<StoredSpaceRecord, "space_id" | "name" | "owner_did" | "type" | "permissions" | "status" | "updated_at">> &
  StoredSpaceRecord {
  const now = new Date().toISOString();
  const accountSpace: AccountSpace = "spaceId" in space
    ? space
    : {
        spaceId: space.id,
        name: space.name ?? space.id.split(":").pop() ?? space.id,
        ownerDid: space.owner ?? "",
        type: (space.type ?? "discovered") as AccountSpace["type"],
        permissions: space.permissions ?? [],
        status: "active" as const,
        expiresAt: space.expiresAt,
      };

  return {
    space_id: accountSpace.spaceId,
    name: accountSpace.name,
    owner_did: accountSpace.ownerDid,
    type: accountSpace.type,
    permissions: accountSpace.permissions,
    status: accountSpace.status,
    registered_at: accountSpace.registeredAt ?? now,
    updated_at: now,
    expires_at: accountSpace.expiresAt instanceof Date
      ? accountSpace.expiresAt.toISOString()
      : accountSpace.expiresAt,
  };
}

function spaceFromRecord(key: string, record: StoredSpaceRecord): AccountSpace {
  const expiresAt = record.expires_at ?? record.expiresAt;
  return {
    spaceId: record.space_id ?? record.spaceId ?? spaceIdFromKey(key),
    name: record.name ?? spaceIdFromKey(key).split(":").pop() ?? spaceIdFromKey(key),
    ownerDid: record.owner_did ?? record.ownerDid ?? record.owner ?? "",
    type: record.type ?? "discovered",
    permissions: Array.isArray(record.permissions) ? record.permissions : [],
    status: record.status ?? "active",
    registeredAt: record.registered_at ?? record.registeredAt,
    updatedAt: record.updated_at ?? record.updatedAt,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
  };
}

type IndexedSpaceRow = [string, string, string, "owned" | "delegated" | "discovered", string, "active" | "archived", string | null, string, string | null];

function indexedSpaceFromRow(row: IndexedSpaceRow): AccountSpace {
  const [spaceId, name, ownerDid, type, permissionsJson, status, registeredAt, updatedAt, expiresAt] = row;
  return {
    spaceId,
    name,
    ownerDid,
    type,
    permissions: JSON.parse(permissionsJson) as string[],
    status,
    registeredAt: registeredAt ?? undefined,
    updatedAt,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
  };
}

function hashJson(value: unknown): string {
  const input = stableJson(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

export interface AccountIndexStatus {
  database: string;
  state: "ready" | "missing";
  sources: Array<{
    source: string;
    syncedAt: string;
    count: number;
  }>;
}

type IndexedSyncStateRow = [string, string, number];

type IndexedDelegationRow = [
  string,
  "granted" | "received",
  string,
  string | null,
  string,
  string,
  string | null,
  string,
  string,
  string,
  "active" | "expired" | "revoked",
  string | null,
];

function indexedDelegationFromRow(row: IndexedDelegationRow): AccountDelegation {
  const [
    cid,
    direction,
    spaceId,
    spaceName,
    counterpartyDid,
    delegateDid,
    delegatorDid,
    path,
    actionsJson,
    expiry,
    status,
    createdAt,
  ] = row;
  return {
    cid,
    direction,
    spaceId,
    spaceName: spaceName ?? undefined,
    counterpartyDid,
    delegateDid,
    delegatorDid: delegatorDid ?? undefined,
    path,
    actions: JSON.parse(actionsJson) as string[],
    expiry: new Date(expiry),
    status,
    createdAt: createdAt ? new Date(createdAt) : undefined,
  };
}

function mapDelegation(
  delegation: Delegation,
  space: SpaceInfo,
  direction: "granted" | "received",
): AccountDelegation {
  return {
    cid: delegation.cid,
    direction,
    spaceId: delegation.spaceId || space.id,
    spaceName: space.name,
    counterpartyDid:
      direction === "granted"
        ? delegation.delegateDID
        : delegation.delegatorDID ?? delegation.delegateDID,
    delegateDid: delegation.delegateDID,
    delegatorDid: delegation.delegatorDID,
    path: delegation.path,
    actions: delegation.actions,
    expiry: delegation.expiry,
    status: delegation.isRevoked
      ? "revoked"
      : delegation.expiry.getTime() <= Date.now()
        ? "expired"
        : "active",
    createdAt: delegation.createdAt,
  };
}

function accountErr(error: ServiceError): Result<never> {
  return err(serviceError(error.code, error.message, SERVICE_NAME, { cause: error.cause, meta: error.meta }));
}

function isMissingIndexError(error: ServiceError): boolean {
  return /no such table:/i.test(error.message);
}

/** Server/gateway statuses where the write may have committed before the
 *  failure. 500 is included on node-side evidence: the KV invoke route can
 *  complete `invoke_with_options` — i.e. COMMIT the batch — and only then
 *  return 500 while validating the committed outcomes
 *  (tinycloud-node-server/src/routes/mod.rs:1631-1641, "KV batch put
 *  committed unexpected invocation outcomes"). 501/505 (protocol
 *  rejections), 408, 429 and every other 4xx are definitive: nothing was
 *  written.
 *
 *  Cloudflare's edge-specific 52x family (production is Cloudflare-proxied)
 *  is evaluated by the same test — did the request reach the origin? — and
 *  cross-checked against `packages/sdk-services/src/responseErrors.ts:26-30`,
 *  which already special-cases 524 as an upstream timeout:
 *    - 520 (unknown origin error) — INCLUDED. Cloudflare received *some*
 *      response from the origin, just not a well-formed HTTP one, so the
 *      origin was reached and may have already committed the write.
 *    - 521 (web server is down) — EXCLUDED. Cloudflare could not open a
 *      connection to the origin at all; the request never arrived.
 *    - 522 (connection timed out) — INCLUDED. Cloudflare documents two
 *      distinct 522 modes: in one, the TCP handshake to the origin itself
 *      times out and nothing is ever delivered; in the other, the TCP
 *      connection IS established and the request is sent, but the origin
 *      never ACKs the response. That second mode means the request can
 *      have reached the origin and been processed before the timeout
 *      fired, so a committed write cannot be ruled out
 *      (https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-522/).
 *    - 523 (origin unreachable) — EXCLUDED. Routing/DNS failure reaching the
 *      origin; unlike 522's post-connection mode, the request never
 *      arrived.
 *    - 524 (a timeout occurred) — INCLUDED. Cloudflare connected to the
 *      origin and forwarded the request, but the origin did not answer
 *      within the timeout; the origin may have processed (and committed)
 *      the write before the response was dropped. This was excluded by the
 *      old deny-list only by omission, not by intent — that was a
 *      regression this allow-list must not repeat. */
const AMBIGUOUS_WRITE_STATUSES = new Set([500, 502, 503, 504, 520, 522, 524]);

/**
 * Classify a KV batch write failure for the seed-spaces reconciliation
 * fallback (TC-373).
 *
 * Only AMBIGUOUS transport failures are safe to retry: the node's
 * content-addressed block store can persist a write before (or independently
 * of) the response that would report success, so an errored batch does not
 * imply nothing was written. Failures the node reports unambiguously must
 * never be retried — retrying would either repeat a definite rejection for
 * no benefit (auth, quota, a space that doesn't exist) or ignore an explicit
 * caller cancellation.
 *
 * This is an ALLOW-LIST: default `false`. Only the states enumerated below
 * are treated as ambiguous; everything else — including every unknown or
 * future error code — is deterministic and must surface immediately rather
 * than trigger five pointless per-space reconcile puts.
 */
function isAmbiguousBatchFailure(error: ServiceError): boolean {
  // Transport-layer failures: ambiguous ONLY if a fully-constructed request
  // was actually handed to fetch. A pre-dispatch throw (serialization, WASM
  // signing — including one wrapError labels TIMEOUT) is deterministic.
  if (
    error.code === ErrorCodes.NETWORK_ERROR ||
    error.code === ErrorCodes.TIMEOUT
  ) {
    return error.meta?.requestMayHaveDispatched === true;
  }

  // The server responded, but the outcome is unstated.
  if (error.code === ErrorCodes.KV_WRITE_FAILED) {
    const status = error.meta?.status;
    return typeof status === "number" && AMBIGUOUS_WRITE_STATUSES.has(status);
  }

  // Everything else — including every unknown/future code — is treated as
  // deterministic. Unknown ≠ ambiguous: fail fast and surface.
  return false;
}

async function ignoreIndexFailure(task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch {
    // The account index is a cache. Canonical reads/writes must not fail
    // because a best-effort cache update could not be applied.
  }
}
