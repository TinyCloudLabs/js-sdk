import {
  err,
  ok,
  serviceError,
  type IKVService,
  type Result,
  type KVResponse,
} from "@tinycloud/sdk-services";
import { ACCOUNT_REGISTRY_PATH } from "../manifest";
import {
  decodeApplicationRecord,
  type AccountApplication,
  type AccountApplicationIssue,
  type AccountApplicationListing,
} from "./applicationRecords";

export interface AccountApplicationDiscoveryOptions {
  /** Use only when this host is explicitly known not to support KV batch reads. Never inferred from failures. */
  batchSupport?: "supported" | "unsupported";
}

export type AccountApplicationKVReader = Pick<
  IKVService,
  "list" | "get" | "batchGet"
>;
const MAX_RECORDS = 1000;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const READ_OPTIONS = { raw: true, maxResponseBytes: MAX_RECORD_BYTES } as const;

/** Read-only canonical discovery. Invalid records are issues; access failures fail the operation. */
export async function listAccountApplications(
  kv: AccountApplicationKVReader,
  options: AccountApplicationDiscoveryOptions = {},
): Promise<Result<AccountApplicationListing>> {
  const listed = await kv.list({
    prefix: ACCOUNT_REGISTRY_PATH,
    limit: MAX_RECORDS,
  });
  if (!listed.ok) return listed;
  const keys = [...new Set(listed.data.keys)].sort();
  if (keys.length > MAX_RECORDS)
    return err(
      serviceError(
        "APPLICATION_REGISTRY_TOO_LARGE",
        "Application registry exceeds the record limit",
        "account",
      ),
    );
  const applications: AccountApplication[] = [];
  const issues: AccountApplicationIssue[] = [];
  if (listed.data.truncated)
    issues.push({
      key: ACCOUNT_REGISTRY_PATH,
      code: "APPLICATION_REGISTRY_INCOMPLETE",
      category: "truncated",
      field: "$",
    });
  let totalBytes = 0;
  const accept = (
    key: string,
    result: Result<KVResponse<unknown>>,
  ): Result<void> => {
    if (!result.ok) {
      if (result.error.code !== "KV_NOT_FOUND") return result;
      issues.push({
        key,
        code: "APPLICATION_RECORD_MISSING",
        category: "missing",
        field: "$",
      });
      return ok(undefined);
    }
    const value = result.data.data;
    let byteLength: number;
    try {
      byteLength = new TextEncoder().encode(
        typeof value === "string" ? value : JSON.stringify(value),
      ).byteLength;
    } catch {
      issues.push({
        key,
        code: "INVALID_APPLICATION_RECORD",
        category: "invalid_shape",
        field: "$",
      });
      return ok(undefined);
    }
    totalBytes += byteLength;
    if (byteLength > MAX_RECORD_BYTES || totalBytes > MAX_TOTAL_BYTES)
      return err(
        serviceError(
          "KV_RESPONSE_TOO_LARGE",
          "Application registry exceeds the byte limit",
          "account",
        ),
      );
    const decoded = decodeApplicationRecord(key, value);
    if (decoded.ok) applications.push(decoded.data);
    else
      issues.push({
        key,
        code: decoded.error.code as AccountApplicationIssue["code"],
        category: decoded.error.meta!
          .category as AccountApplicationIssue["category"],
        field: decoded.error.meta!.field as string,
      });
    return ok(undefined);
  };
  if (options.batchSupport === "unsupported") {
    for (let offset = 0; offset < keys.length; offset += 4) {
      const group = keys.slice(offset, offset + 4);
      const results = await Promise.all(
        group.map((key) => kv.get(key, READ_OPTIONS)),
      );
      for (let index = 0; index < group.length; index++) {
        const accepted = accept(group[index]!, results[index]!);
        if (!accepted.ok) return accepted;
      }
    }
  } else {
    for (let offset = 0; offset < keys.length; offset += 100) {
      const groups = [
        keys.slice(offset, offset + 50),
        keys.slice(offset + 50, offset + 100),
      ].filter((group) => group.length > 0);
      const batches = await Promise.all(
        groups.map((group) => kv.batchGet(group, READ_OPTIONS)),
      );
      for (let index = 0; index < groups.length; index++) {
        const batch = batches[index]!;
        if (!batch.ok) return batch;
        const expected = groups[index]!;
        const results = new Map(
          batch.data.results.map((entry) => [entry.key, entry.result]),
        );
        if (
          results.size !== expected.length ||
          batch.data.results.length !== expected.length ||
          batch.data.count !== expected.length ||
          expected.some((key) => !results.has(key))
        ) {
          return err(
            serviceError(
              "NETWORK_ERROR",
              "Application batch response does not match requested keys",
              "account",
            ),
          );
        }
        for (const key of expected) {
          const accepted = accept(key, results.get(key)!);
          if (!accepted.ok) return accepted;
        }
      }
    }
  }
  return ok({ applications, issues, complete: issues.length === 0 });
}
