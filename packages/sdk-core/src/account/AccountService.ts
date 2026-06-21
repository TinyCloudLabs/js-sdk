import {
  err,
  ok,
  serviceError,
  type IDatabaseHandle,
  type IKVService,
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
import type { Delegation, SpaceInfo } from "../delegations/types";
import type { ISpaceService } from "../spaces/SpaceService";

const SERVICE_NAME = "account";
const ACCOUNT_INDEX_DB = "account";

export interface AccountApplication {
  appId: string;
  manifests: Manifest[];
  updatedAt?: string;
  name?: string;
  description?: string;
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
  grantedDelegations: number;
  receivedDelegations: number;
}

export interface AccountIndexRebuildResult {
  database: string;
  applications: number;
  delegations: number;
  syncedAt: string;
}

export interface AccountDelegationListOptions {
  direction?: "granted" | "received" | "all";
  space?: string;
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
  getAccountDb?: () => IDatabaseHandle | undefined;
  ensureAccountSpaceHosted?: () => Promise<void>;
}

export class AccountService {
  constructor(private readonly config: AccountServiceConfig) {}

  async status(): Promise<Result<AccountStatus>> {
    const apps = await this.applications.list();
    if (!apps.ok) return apps;

    const delegations = await this.delegations.list();
    if (!delegations.ok) return delegations;

    return ok({
      did: this.config.getDid(),
      host: this.config.getHost(),
      primarySpaceId: this.config.getPrimarySpaceId(),
      accountSpaceId: this.config.getAccountSpaceId(),
      applications: apps.data.length,
      grantedDelegations: delegations.data.filter((d) => d.direction === "granted").length,
      receivedDelegations: delegations.data.filter((d) => d.direction === "received").length,
    });
  }

  readonly applications = {
    list: async (): Promise<Result<AccountApplication[]>> => {
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

    register: async (manifest: Manifest | Manifest[]): Promise<Result<AccountApplication>> => {
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
        const stored = {
          app_id: record.app_id,
          manifests: record.manifests,
          updated_at: new Date().toISOString(),
        };
        const written = await kvResult.data.put(record.key, stored);
        if (!written.ok) return accountErr(written.error);
        registered = applicationFromRecord(record.key, stored);
      }

      return ok(registered!);
    },

    remove: async (appId: string): Promise<Result<void>> => {
      const kvResult = this.accountKV();
      if (!kvResult.ok) return kvResult;

      const removed = await kvResult.data.delete(applicationKey(appId));
      if (!removed.ok) return accountErr(removed.error);
      return ok(undefined);
    },
  };

  readonly delegations = {
    list: async (
      options: AccountDelegationListOptions = {},
    ): Promise<Result<AccountDelegation[]>> => {
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

    revoke: async (options: AccountDelegationRevokeOptions): Promise<Result<void>> => {
      const space = await this.resolveSpace(options.space);
      if (!space.ok) return space;

      const revoked = await this.config.getSpaces().get(space.data.id).delegations.revoke(options.cid);
      if (!revoked.ok) return accountErr(revoked.error);
      return ok(undefined);
    },
  };

  readonly index = {
    rebuild: async (): Promise<Result<AccountIndexRebuildResult>> => {
      const dbResult = this.accountDb();
      if (!dbResult.ok) return dbResult;

      const applications = await this.applications.list();
      if (!applications.ok) return applications;

      const delegations = await this.delegations.list();
      if (!delegations.ok) return delegations;

      const syncedAt = new Date().toISOString();
      const statements = [
        ...ACCOUNT_INDEX_SCHEMA.map((sql) => ({ sql })),
        { sql: "DELETE FROM applications" },
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
          params: ["delegations", syncedAt, delegations.data.length],
        },
      ];

      const rebuilt = await dbResult.data.batch(statements);
      if (!rebuilt.ok) return accountErr(rebuilt.error);

      return ok({
        database: ACCOUNT_INDEX_DB,
        applications: applications.data.length,
        delegations: delegations.data.length,
        syncedAt,
      });
    },

    applications: {
      list: async (): Promise<Result<AccountApplication[]>> => {
        const dbResult = this.accountDb();
        if (!dbResult.ok) return dbResult;

        const queried = await dbResult.data.query<string | null>(
          "SELECT app_id, name, description, updated_at, manifest_json FROM applications ORDER BY app_id",
        );
        if (!queried.ok) return accountErr(queried.error);

        return ok((queried.data.rows as unknown as IndexedApplicationRow[]).map(indexedApplicationFromRow));
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
}

const ACCOUNT_INDEX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS applications (
    app_id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    updated_at TEXT,
    manifest_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS delegations (
    cid TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    space_id TEXT NOT NULL,
    space_name TEXT,
    counterparty_did TEXT NOT NULL,
    delegate_did TEXT NOT NULL,
    delegator_did TEXT,
    path TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    expiry TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    source TEXT PRIMARY KEY,
    synced_at TEXT NOT NULL,
    count INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_delegations_direction ON delegations(direction)",
  "CREATE INDEX IF NOT EXISTS idx_delegations_space ON delegations(space_id)",
  "CREATE INDEX IF NOT EXISTS idx_delegations_counterparty ON delegations(counterparty_did)",
];

interface StoredApplicationRecord {
  app_id?: string;
  appId?: string;
  manifests?: Manifest[];
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
  };
}

type IndexedApplicationRow = [string, string | null, string | null, string | null, string];

function indexedApplicationFromRow(row: IndexedApplicationRow): AccountApplication {
  const [appId, name, description, updatedAt, manifestJson] = row;
  return {
    appId,
    name: name ?? undefined,
    description: description ?? undefined,
    updatedAt: updatedAt ?? undefined,
    manifests: JSON.parse(manifestJson) as Manifest[],
  };
}

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
