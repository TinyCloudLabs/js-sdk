import {
  TinyCloudSession,
  KVService,
  IKVService,
  type KVServiceConfig,
  SQLService,
  ISQLService,
  DuckDbService,
  IDuckDbService,
  ServiceSession,
  ServiceContext,
} from "@tinycloud/sdk-core";
import type { InvokeFunction } from "@tinycloud/sdk-services";
import { PortableDelegation } from "./delegation";

/**
 * Provides access to a space via a received delegation.
 *
 * This is returned by TinyCloudNode.useDelegation() and provides
 * KV operations on the delegated space.
 */
export class DelegatedAccess {
  private session: TinyCloudSession;
  private _delegation: PortableDelegation;
  private host: string;
  private _serviceContext: ServiceContext;
  private _kv: KVService;
  private _sql: SQLService;
  private _duckdb: DuckDbService;

  constructor(
    session: TinyCloudSession,
    delegation: PortableDelegation,
    host: string,
    invoke: InvokeFunction,
    kvConfig: KVServiceConfig = {},
  ) {
    this.session = session;
    this._delegation = delegation;
    this.host = host;

    // Create service context
    this._serviceContext = new ServiceContext({
      invoke,
      fetch: globalThis.fetch.bind(globalThis),
      hosts: [host],
    });

    // Create and initialize KV service with path prefix from delegation
    // Strip trailing slash to avoid double-slash in paths
    const prefix = this._delegation.path.replace(/\/$/, '');
    this._kv = new KVService({
      ...kvConfig,
      prefix,
    });
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
   * The path this access is scoped to.
   */
  get path(): string {
    return this._delegation.path;
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
}
