import type { IKVService, KVChangesAuthority, KVChangesResponse } from "@tinycloud/sdk-services";

/** Owner-only raw bytes. Classification and resolved feed protocol records belong to Home. */
export interface FeedRawSourceRow {
  sourceKey: string;
  sourceArea: "kv" | "watch-state" | "thread-watch-state" | "expiry-state";
  encoding: "base64";
  rawBase64: string;
  sha256: string;
  etag?: string;
  metadata?: Record<string, string>;
}

export interface FeedRawDeletion {
  sourceKey: string;
  sourceArea: "kv";
  deleted: true;
}

export interface FeedRawChangePage {
  inputCursor?: string;
  cursor: string;
  more: boolean;
  source: KVChangesResponse["source"];
  authority: KVChangesAuthority;
}

export interface FeedRawSnapshot {
  format: "tinycloud.feed.raw-snapshot";
  formatVersion: 1;
  source: {
    spaceId: string;
    namespace: string;
    snapshotId: string;
    completePrefixSnapshot: true;
    cursor: string;
  };
  frozenAt: string;
  rows: FeedRawSourceRow[];
  deletions: FeedRawDeletion[];
  proof: { pages: FeedRawChangePage[]; tail: FeedRawChangePage };
}

/** Explicit operator configuration, never legacy watcher discovery or execution. */
export interface FeedRawSidecar {
  sourceKey: string;
  sourceArea: "watch-state" | "thread-watch-state" | "expiry-state";
  path: string;
}

export interface FeedRawExportOptions {
  kv: Pick<IKVService, "get" | "changes">;
  sourceSpace: string;
  prefix: string;
  outFile: string;
  sidecarsFile?: string;
  signal?: AbortSignal;
}

/** Safe for CLI output; the owner-only snapshot and its raw rows are not returned. */
export interface FeedRawExportReceipt {
  snapshotId: string;
  outFile: string;
  rowCount: number;
  deletionCount: number;
}
