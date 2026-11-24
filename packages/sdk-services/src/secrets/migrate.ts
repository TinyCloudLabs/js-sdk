/**
 * Published as `@tinycloud/sdk-services/secrets/migrate` and deliberately not exported from the package root, so the
 * root and web bundles do not carry a CLI migration (the same way as `secrets/totp`).
 */

import { ErrorCodes, err, type Result } from "../types";
import type { VaultResealResult } from "../vault/types";
import type { ISecretsService, SecretsError } from "./ISecretsService";
import { BOT_HISTORY_KEY_PATH, canonicalizeSecretScope, resolveSecretPath, SECRET_NAME_RE, type ResolvedSecretPath } from "./paths";

export type SecretMigrateSkipReason = Extract<VaultResealResult, { status: "skipped" }>["reason"];

export interface SecretMigrateOptions {
  /** Only these names (in every scope, or in `scope` when given). Omitted: every secret. */
  names?: readonly string[];
  scope?: string;
  /** Count what would move without encrypting or writing anything. */
  dryRun?: boolean;
  /**
   * Called once, before anything moves and never on a dry run, with the exact key path of every selected secret that
   * still has to move, so a caller can get decrypt and key creation on exactly those keys. A throw stops the migration.
   * When it is given, each secret is first classified with a dry-run reseal (a read, no decrypt or key call), so a
   * secret already on its own key or one that cannot be read is never in the request, and a rerun after a stop asks
   * only for the rest.
   */
  authorizeKeys?: (keyPaths: readonly string[]) => Promise<void>;
  /** Called once on a dry run with the key paths `authorizeKeys` would get, so a caller can plan the approvals. */
  previewKeys?: (keyPaths: readonly string[]) => Promise<void>;
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

  // `resealToKey` is optional on the interface: a vault built outside the SDK may not have it. Refuse before reading
  // the catalog (`listAll` can prompt) or asking for any key, so a vault that cannot move secrets never prompts.
  const vault = secrets.vault;
  const reseal = vault.resealToKey?.bind(vault);
  if (reseal === undefined) return invalid("This vault cannot move secrets onto their own keys.");

  const catalog = await secrets.listAll();
  if (!catalog.ok) return catalog;
  // TinyChat's bot-history key and its data live under a reserved scope: migrate neither counts nor touches them.
  const selected = catalog.data.filter((entry) =>
    !isBotHistoryEntry(entry) && (names === undefined || names.has(entry.name)) && (scope === undefined || entry.scope === scope));

  const dryRun = options.dryRun === true;
  const report: SecretMigrateReport = { dryRun, total: selected.length, moved: 0, already: 0, staysOnNetwork: 0, skipped: {} };
  // A named secret that is not stored anywhere selected counts as not found.
  const unmatched = [...names ?? []].filter((name) => !selected.some((entry) => entry.name === name)).length;
  if (unmatched > 0) {
    report.total += unmatched;
    report.skipped.not_found = unmatched;
  }
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
  if (moves.length === 0) return { ok: true, data: report };
  const count = (result: VaultResealResult): void => {
    if (result.status === "skipped") {
      report.skipped[result.reason] = (report.skipped[result.reason] ?? 0) + 1;
    } else if (result.status === "already") {
      report.already += 1;
    } else {
      report.moved += 1;
    }
  };
  let toMove = moves;
  if (dryRun || options.authorizeKeys !== undefined) {
    // Classify with a dry-run reseal; on a real run, `already` and `skipped` are final here and only `pending` moves.
    const pending: typeof moves = [];
    for (const move of moves) {
      const result = await reseal(move.vaultKey, move.keyPath, { dryRun: true });
      if (result.status === "pending") {
        pending.push(move);
        if (!dryRun) continue;
      }
      count(result);
    }
    if (dryRun) {
      await options.previewKeys?.(pending.map((move) => move.keyPath));
      return { ok: true, data: report };
    }
    if (pending.length === 0) return { ok: true, data: report };
    await options.authorizeKeys!(pending.map((move) => move.keyPath));
    toMove = pending;
  }
  for (const { vaultKey, keyPath } of toMove) {
    count(await reseal(vaultKey, keyPath, { dryRun: false }));
  }
  return { ok: true, data: report };
}

function invalid(message: string): Result<never, SecretsError> {
  return err({ code: ErrorCodes.INVALID_INPUT, service: "secrets", message });
}

/** An entry under the scope of the reserved bot-history key (derived from the key's own path, never a copied string). */
function isBotHistoryEntry(entry: { scope?: string }): boolean {
  return entry.scope !== undefined && BOT_HISTORY_KEY_PATH.startsWith(`secrets/scoped/${entry.scope}/`);
}
