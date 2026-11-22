import { ErrorCodes, err, type Result } from "../types";
import type { VaultResealResult } from "../vault/types";
import type { ISecretsService, SecretsError } from "./ISecretsService";
import { canonicalizeSecretScope, resolveSecretPath, SECRET_NAME_RE, type ResolvedSecretPath } from "./paths";

export type SecretMigrateSkipReason = Extract<VaultResealResult, { status: "skipped" }>["reason"];

export interface SecretMigrateOptions {
  /** Only these names (in every scope, or in `scope` when given). Omitted: every secret. */
  names?: readonly string[];
  scope?: string;
  /** Count what would move without encrypting or writing anything. */
  dryRun?: boolean;
  /**
   * Called once, before anything moves and never on a dry run, with the exact key path of every selected secret that
   * has one, so a caller can get decrypt and key creation on exactly those keys. A throw stops the migration.
   */
  authorizeKeys?: (keyPaths: readonly string[]) => Promise<void>;
}

/** Counts only: a migration report never names a secret or carries a value. */
export interface SecretMigrateReport {
  dryRun: boolean;
  /** Secrets examined. */
  total: number;
  /** Moved to their own key; on a dry run, the ones that would move. */
  moved: number;
  /** Already on their own key. */
  already: number;
  /** A name or scope over 64 bytes has no key of its own and stays on the network key. */
  staysOnNetwork: number;
  /** Left as they were, by reason; the old copy is kept. */
  skipped: Partial<Record<SecretMigrateSkipReason, number>>;
}

/**
 * Move secrets sealed to the network key onto each secret's own key (TC-3284). A secret moves only once its new
 * copy decrypts to the same bytes and only if nothing wrote it since it was read; any failure leaves the old copy and
 * goes on to the next secret. Running it again moves nothing already moved.
 */
export async function migrateSecrets(
  secrets: ISecretsService,
  options: SecretMigrateOptions = {},
): Promise<Result<SecretMigrateReport, SecretsError>> {
  let scope: string | undefined;
  try {
    scope = canonicalizeSecretScope(options.scope);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  const names = options.names === undefined ? undefined : new Set(options.names.map((name) => name.trim()));
  for (const name of names ?? []) {
    if (!SECRET_NAME_RE.test(name)) return invalid(`Invalid secret name ${JSON.stringify(name)}.`);
  }

  const catalog = await secrets.listAll();
  if (!catalog.ok) return catalog;
  const selected = catalog.data.filter((entry) =>
    (names === undefined || names.has(entry.name)) && (scope === undefined || entry.scope === scope));

  const dryRun = options.dryRun === true;
  const report: SecretMigrateReport = { dryRun, total: selected.length, moved: 0, already: 0, staysOnNetwork: 0, skipped: {} };
  // A named secret that is not stored anywhere selected counts as not found.
  const unmatched = [...names ?? []].filter((name) => !selected.some((entry) => entry.name === name)).length;
  if (unmatched > 0) {
    report.total += unmatched;
    report.skipped.not_found = unmatched;
  }
  const vault = secrets.vault;
  const moves: { vaultKey: string; keyPath: string }[] = [];
  for (const entry of selected) {
    // A name or scope over 64 bytes has no key of its own, and one such secret must not stop the others moving.
    let resolved: ResolvedSecretPath | undefined;
    try {
      resolved = resolveSecretPath(entry.name, entry.scope === undefined ? {} : { scope: entry.scope });
    } catch {
      resolved = undefined;
    }
    if (resolved === undefined || resolved.keyPath === undefined) {
      report.staysOnNetwork += 1;
    } else {
      moves.push({ vaultKey: resolved.vaultKey, keyPath: resolved.keyPath });
    }
  }
  if (!dryRun && moves.length > 0) await options.authorizeKeys?.(moves.map((move) => move.keyPath));
  for (const { vaultKey, keyPath } of moves) {
    const result = await vault.resealToKey(vaultKey, keyPath, { dryRun });
    if (result.status === "skipped") {
      report.skipped[result.reason] = (report.skipped[result.reason] ?? 0) + 1;
    } else if (result.status === "already") {
      report.already += 1;
    } else {
      report.moved += 1;
    }
  }
  return { ok: true, data: report };
}

function invalid(message: string): Result<never, SecretsError> {
  return err({ code: ErrorCodes.INVALID_INPUT, service: "secrets", message });
}
