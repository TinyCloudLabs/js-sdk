import type { Result } from "../types";
import type { SQLService } from "./SQLService";
import type { ISQLMigrations } from "./ISQLService";
import type {
  SqlMigrationApplyOptions,
  SqlMigrationApplyResponse,
} from "./types";

export class SQLMigrations implements ISQLMigrations {
  constructor(
    private readonly service: SQLService,
    private readonly dbName: string,
  ) {}

  apply(options: SqlMigrationApplyOptions): Promise<Result<SqlMigrationApplyResponse>> {
    return this.service.applyMigrationsOnDb(this.dbName, options);
  }
}
