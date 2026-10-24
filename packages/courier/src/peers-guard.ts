import fs from 'node:fs';
import path from 'node:path';
import { CourierError } from './errors.js';
import { profileDir } from './profile.js';

const refuse = (code: string, message: string): never => {
  throw new CourierError(code, message);
};

/** A peers.json location. `required` files (set explicitly) that are missing refuse; the default locations may be absent. */
export interface PeersFile {
  path: string;
  required: boolean;
}

/**
 * The peers.json location the owner named: `--peers-file` wins over `COURIER_PEERS_FILE`. Either must be a non-empty absolute path to a file that
 * exists; anything else is an error, never ignored (a service forwards a relative path unchanged and it would resolve against its own directory).
 * Courier has no stored setting for this: the profile's stored settings are written only by `init`.
 */
function explicitPeersFile(flag: string | undefined): PeersFile | undefined {
  const source = flag !== undefined ? '--peers-file' : 'COURIER_PEERS_FILE';
  const value = flag ?? process.env.COURIER_PEERS_FILE;
  if (value === undefined) return undefined;
  if (value === '' || (flag !== undefined && value === 'true')) refuse('usage', `${source} needs a path.`);
  // A control character (a newline above all) would split a line of the systemd unit this path is written into.
  if (/[\u0000-\u001f\u007f]/.test(value)) refuse('usage', `${source} must not contain control characters.`);
  if (!path.isAbsolute(value)) refuse('usage', `${source} must be an absolute path (got "${value}").`);
  if (!fs.existsSync(value)) refuse('peers-unreadable', `${source} names a file that does not exist: ${value}`);
  return { path: value, required: true };
}

/**
 * Where the box owner's peers.json may live: the explicit file (flag, else `COURIER_PEERS_FILE`) plus the intake and outbox defaults under COURIER_HOME.
 * peers.json is keyed by handle and carries the trust tier, so Courier never pairs over a handle that has an entry there.
 */
export function peersFilesFor(flag?: string): PeersFile[] {
  const home = profileDir();
  const explicit = explicitPeersFile(flag);
  return [
    ...(explicit ? [explicit] : []),
    { path: path.join(home, 'peers.json'), required: false },
    { path: path.join(home, 'intake', 'peers.json'), required: false },
  ];
}

/**
 * `peers-entry-exists` when any peers file has an entry for `handle`; `peers-unreadable` when a file exists but cannot be read as a JSON object,
 * or a required file is missing (fail closed: an unreadable file may hide an entry). A missing optional file is no entry. Reads only; never writes the file.
 * A plain string is an optional location.
 */
export function peersEntryProblem(handle: string, files: readonly (string | PeersFile)[]): 'peers-entry-exists' | 'peers-unreadable' | undefined {
  for (const entry of files) {
    const { path: file, required } = typeof entry === 'string' ? { path: entry, required: false } : entry;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!required && (code === 'ENOENT' || code === 'ENOTDIR')) continue;
      return 'peers-unreadable';
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return 'peers-unreadable';
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'peers-unreadable';
    if (Object.hasOwn(parsed, handle)) return 'peers-entry-exists';
  }
  return undefined;
}

export const PEERS_ENTRY_MESSAGE = 'The peers file already lists this handle, so its trust setting would carry over to the new peer. Remove the entry (or use another handle) and try again.';
export const PEERS_UNREADABLE_MESSAGE = 'A peers file is missing or cannot be read as a JSON object, so Courier cannot tell whether this handle is listed. Fix the file, or the --peers-file / COURIER_PEERS_FILE path, and try again.';

/** The message for a peers-guard code. */
export const peersMessage = (code: 'peers-entry-exists' | 'peers-unreadable'): string => (code === 'peers-entry-exists' ? PEERS_ENTRY_MESSAGE : PEERS_UNREADABLE_MESSAGE);

/** Refuses (stable code, no write) when a peers file lists `handle` or cannot be read. Every path that creates a peer or a grant for a handle calls this first. */
export function assertNoPeersEntry(handle: string, files: readonly (string | PeersFile)[] = peersFilesFor()): void {
  const problem = peersEntryProblem(handle, files);
  if (problem !== undefined) refuse(problem, peersMessage(problem));
}
