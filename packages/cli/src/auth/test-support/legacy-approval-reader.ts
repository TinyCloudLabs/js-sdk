/**
 * The way CLI 1.6.x (and every release before TC-2377) reads and writes `approval-pending.json`: a copy of the logic of
 * `activePending`, `updatePending` and the read in `recoverApprovalCommand` as they stood in `auth/approval-request.ts`, kept
 * here only so a test can run the OLD reader against a version 2 file and record what a downgraded CLI does. It is frozen on
 * purpose: do not "fix" it, and do not use it for anything else.
 */
import { join } from "node:path";

interface LegacyDeps {
  readonly profilePath: (profile: string) => string;
  readonly readJson: <T>(path: string) => Promise<T | null | undefined>;
  readonly writeJsonDurable: (path: string, data: unknown) => Promise<void>;
  readonly withLock: <T>(profile: string, action: () => Promise<T>, options?: { requireProfile?: boolean }) => Promise<T>;
  readonly ensureProfileDir: (profile: string) => Promise<string>;
}
interface LegacyEntry { readonly requestId: string; readonly commandIntent?: string; readonly resultExpiresAt?: string; readonly command?: { readonly result: { readonly expiry: string } } }

const STATE_FILE = "approval-pending.json";

export function legacyReader(deps: LegacyDeps) {
  /** `activePending` of 1.6.x: what `auth login`, `onboard` and `auth grant` see as the saved approvals. */
  async function activePending(profile: string): Promise<LegacyEntry[]> {
    const path = join(deps.profilePath(profile), STATE_FILE);
    if (!(await deps.readJson<LegacyEntry[]>(path))?.length) return [];
    return deps.withLock(profile, async () => {
      const entries = await deps.readJson<LegacyEntry[]>(path) ?? [];
      const now = Date.now();
      const active = entries.filter((entry) => {
        const expiry = entry.command ? entry.command.result.expiry : entry.resultExpiresAt;
        return expiry === undefined || !(Date.parse(expiry) <= now);
      });
      if (active.length !== entries.length) await deps.writeJsonDurable(path, active);
      return active;
    }, { requireProfile: true });
  }

  /** `updatePending` of 1.6.x: the one writer (a new request, a result, an ack). */
  async function updatePending(profile: string, update: (pending: LegacyEntry[]) => LegacyEntry[]): Promise<void> {
    await deps.withLock(profile, async () => {
      const directory = await deps.ensureProfileDir(profile);
      const path = join(directory, STATE_FILE);
      await deps.writeJsonDurable(path, update(await deps.readJson<LegacyEntry[]>(path) ?? []));
    }, { requireProfile: true });
  }

  /** The read at the top of `recoverApprovalCommand` / `commitApprovalCommand` of 1.6.x. */
  async function recoveryEntries(profile: string, commandIntent: string): Promise<LegacyEntry[]> {
    const entries = await deps.readJson<LegacyEntry[]>(join(deps.profilePath(profile), STATE_FILE)) ?? [];
    return entries.filter((item) => item.commandIntent === commandIntent);
  }

  return { activePending, updatePending, recoveryEntries };
}
