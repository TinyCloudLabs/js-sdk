import type { ISQLService } from "@tinycloud/sdk-services";

export interface FeedPreparedImportOptions {
  sql: Pick<ISQLService, "db">;
  targetSpace: string;
  bundle: unknown;
}

export interface FeedPreparedImportReceipt {
  targetSpace: string;
  source: { spaceId: string; namespace: string; snapshotId: string };
  archiveResource: string;
  publishers: number;
  cards: number;
  responses: number;
}
