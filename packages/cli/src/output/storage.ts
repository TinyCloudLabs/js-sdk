/**
 * The one storage-full description every command shares. A write the node
 * refuses for storage is an account-wide condition: it names the account's
 * totals when the SDK reports them, never the per-space limit, which is 0
 * whenever the owner's other spaces already use the whole budget.
 *
 * Kept free of other CLI modules so commands can forward a storage rejection
 * without depending on the error module that command tests replace.
 */

export const MANAGE_STORAGE_URL = "https://account.tinycloud.xyz/billing";

export type StorageRejectionCode = "STORAGE_QUOTA_EXCEEDED" | "STORAGE_LIMIT_REACHED";

export interface StorageAccountTotals {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly plan?: string;
}

export interface StorageRejection {
  readonly code: StorageRejectionCode;
  readonly account?: StorageAccountTotals;
}

const MAX_CAUSE_DEPTH = 4;

/**
 * The storage rejection carried by an SDK service error (`meta.account`), a
 * CLIError (`metadata.account`), a StorageRejection itself, or a wrapper's
 * `cause` chain. The typed code decides. An error with any other code keeps
 * its own mapping. The node's or SDK's storage text counts only for an
 * uncoded error from a TinyCloud request, i.e. one carrying a 402 or 413
 * HTTP status, so a local error that merely mentions the phrase is untouched.
 */
export function storageRejection(error: unknown): StorageRejection | undefined {
  let node: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof node === "object" && node !== null; depth += 1) {
    const record = node as { code?: unknown; message?: unknown; account?: unknown; meta?: unknown; metadata?: unknown; cause?: unknown };
    let code: StorageRejectionCode | undefined;
    if (record.code === "STORAGE_QUOTA_EXCEEDED" || record.code === "STORAGE_LIMIT_REACHED") {
      code = record.code;
    } else if (record.code !== undefined) {
      return undefined;
    } else if (isStorageStatus(record)) {
      code = storageCodeFromText(record.message);
    }
    if (code) {
      const account = accountTotals(record) ?? accountTotals(record.meta) ?? accountTotals(record.metadata);
      return account ? { code, account } : { code };
    }
    node = record.cause;
  }
  return undefined;
}

/**
 * The CLI's storage-full message and hint (spec: storage-full-messaging §4.4).
 * `progress` (e.g. `Insert into "t" failed after 3 row(s): `) replaces
 * "nothing was written" when the command already wrote part of its work.
 */
export function describeStorageRejection(rejection: StorageRejection, progress?: string): { message: string; hint: string } {
  const reason = rejection.code === "STORAGE_LIMIT_REACHED"
    ? "This write is larger than the TinyCloud storage you have left"
    : "TinyCloud storage is full";
  const message = progress ? `${progress}${reason}.` : `${reason}; nothing was written.`;
  const { account } = rejection;
  const totals = account
    ? `${formatStorageBytes(account.usedBytes)} used of ${formatStorageBytes(account.limitBytes)}${account.plan ? ` (${account.plan} plan)` : ""}. `
    : "";
  return {
    message,
    hint: `${totals}Reading still works.\nFree up space or upgrade: ${MANAGE_STORAGE_URL}`,
  };
}

/** Binary units with one decimal, trailing ".0" dropped: 389777359 → "371.7 MiB", 104857600 → "100 MiB". */
export function formatStorageBytes(bytes: number): string {
  const units = ["KiB", "MiB", "GiB", "TiB"];
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`;
}

function storageCodeFromText(message: unknown): StorageRejectionCode | undefined {
  if (typeof message !== "string") return undefined;
  if (message.includes("larger than the TinyCloud storage you have left")) return "STORAGE_LIMIT_REACHED";
  if (message.includes("TinyCloud storage is full") || /storage quota exceeded/i.test(message)) {
    return "STORAGE_QUOTA_EXCEEDED";
  }
  return undefined;
}

/** A 402 or 413 HTTP status on the error itself (`status`, `statusCode` or `meta.status`). */
function isStorageStatus(record: object): boolean {
  const meta = "meta" in record && typeof record.meta === "object" && record.meta !== null ? record.meta : {};
  const statuses = [
    "status" in record ? record.status : undefined,
    "statusCode" in record ? record.statusCode : undefined,
    "status" in meta ? meta.status : undefined,
  ];
  return statuses.some((value) => value === 402 || value === 413);
}

function accountTotals(meta: unknown): StorageAccountTotals | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const account = (meta as { account?: unknown }).account;
  if (typeof account !== "object" || account === null) return undefined;
  const { usedBytes, limitBytes, plan } = account as { usedBytes?: unknown; limitBytes?: unknown; plan?: unknown };
  // A zero budget explains nothing; show no numbers rather than "of 0 B".
  if (!isByteCount(usedBytes) || !isByteCount(limitBytes) || limitBytes === 0) return undefined;
  return typeof plan === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/.test(plan)
    ? { usedBytes, limitBytes, plan }
    : { usedBytes, limitBytes };
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
