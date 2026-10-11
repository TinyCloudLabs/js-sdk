import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  additionalDelegationsPath,
  profileConfigPath,
  sessionPath,
  withTinyCloudStateRoot,
  writeJsonAtomic,
} from "@tinycloud/operations/state";

/** `bin/tc`; spawned tests need a fresh `bun run --cwd packages/cli build`. */
export const TC_BIN = join(import.meta.dir, "../../bin/tc");

interface RestorableSession {
  readonly spaceId: string;
  readonly chainId: number;
  readonly verificationMethod: string;
  readonly address: string;
}

interface StoredDelegation {
  readonly cid: string;
}

/** The node-sdk loopback fixture, as these tests use it. */
export interface WaitHermetic {
  readonly host: string;
  readonly ownerDid: string;
  readonly ownerPrivateKey: string;
  readonly restorableSession: RestorableSession & Record<string, unknown>;
  readonly ownerRestorableSession: RestorableSession & Record<string, unknown>;
  readonly permissions: readonly unknown[];
  requests(): readonly { readonly method: string; readonly path: string; readonly authorizationSha256?: string }[];
  invocations(): readonly { readonly service: string; readonly action: string; readonly space: string; readonly path: string }[];
  decryptRequests(): number;
  failDelegate(status: number | null): void;
  denyKvReads(paths: readonly string[]): void;
  setSecretPresent(value: boolean): void;
  stallInvocations(match: ((invocation: { readonly action: string; readonly path: string }) => boolean) | null): void;
  provisionKvSpace(spaceId: string): void;
  provisionSecret(): void;
  mintDelegation(): Promise<StoredDelegation>;
  mintDelegationForAudience(audience: string): Promise<StoredDelegation>;
  stop(): void;
}

// The node-sdk loopback fixture lives outside this package's rootDir, so it is
// loaded by URL, as the other CLI and operations fixtures do.
const hermeticModule = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(options?: { secretPresent?: boolean }): Promise<WaitHermetic> };

export function startWaitHermetic(options: { secretPresent?: boolean } = {}): Promise<WaitHermetic> {
  return hermeticModule.createHermeticEncryptedNode(options);
}

export function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tc-secrets-wait-"));
}

export function removeHome(home: string): Promise<void> {
  return rm(home, { recursive: true, force: true });
}

/** The fixture owner's `secrets` space, where status probes `vault/secrets/<NAME>`. */
export function secretsSpaceId(hermetic: WaitHermetic): string {
  return hermetic.restorableSession.spaceId;
}

const profileBase = { spaceName: "secrets", createdAt: "2026-07-15T00:00:00.000Z" };

/**
 * A `did:key` delegate-session profile (owner from its space). With `grant`,
 * the fixture's minted grant is stored bound to its request, as
 * `tc auth import` stores it, so no migration is pending.
 */
export async function writeDelegateProfile(
  home: string,
  hermetic: WaitHermetic,
  name: string,
  options: { session?: boolean; space?: boolean; grant?: StoredDelegation } = {},
): Promise<void> {
  const session = hermetic.restorableSession;
  const did = session.verificationMethod.split("#", 1)[0]!;
  await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(name), {
      ...profileBase,
      name,
      host: hermetic.host,
      chainId: session.chainId,
      ...(options.space === false ? {} : { spaceId: session.spaceId }),
      did,
      sessionDid: did,
      posture: "delegate-session",
      operatorType: "agent",
      authMethod: "openkey",
    });
    if (options.session !== false) await writeJsonAtomic(sessionPath(name), session);
    if (options.grant !== undefined) {
      await writeJsonAtomic(additionalDelegationsPath(name), [{
        delegation: options.grant,
        permissions: [],
        authorityRequest: { requestId: "req_fixture_plan", requested: hermetic.permissions },
      }]);
    }
  });
}

/** Write raw stored-grant records (e.g. an unbound compact record that needs the migration). */
export async function writeStoredGrants(home: string, name: string, records: readonly unknown[]): Promise<void> {
  await withTinyCloudStateRoot(home, () => writeJsonAtomic(additionalDelegationsPath(name), records));
}

/** An owner-openkey profile holding the owner's stored session; `grant` is stored as a cli-grant. */
export async function writeOwnerOpenKeyProfile(
  home: string,
  hermetic: WaitHermetic,
  name: string,
  options: { grant?: StoredDelegation; session?: boolean } = {},
): Promise<void> {
  const session = hermetic.ownerRestorableSession;
  await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(name), {
      ...profileBase,
      name,
      host: hermetic.host,
      chainId: session.chainId,
      spaceId: session.spaceId,
      did: hermetic.ownerDid,
      sessionDid: session.verificationMethod.split("#", 1)[0],
      posture: "owner-openkey",
      operatorType: "human",
      authMethod: "openkey",
    });
    if (options.session !== false) await writeJsonAtomic(sessionPath(name), session);
    if (options.grant !== undefined) {
      await writeJsonAtomic(additionalDelegationsPath(name), [{
        delegation: options.grant,
        permissions: [],
        authorityRequest: { requestId: "req_cli_grant", requested: hermetic.permissions },
        authorityRequestAudit: { source: "cli-grant", recordedAt: "2026-07-15T00:00:00.000Z", note: "fixture" },
      }]);
    }
  });
}

/** A local-owner-key profile (owner key in the profile), with or without a stored session. */
export async function writeLocalOwnerProfile(
  home: string,
  hermetic: WaitHermetic,
  name: string,
  options: { session?: boolean } = {},
): Promise<void> {
  const session = hermetic.ownerRestorableSession;
  await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(name), {
      ...profileBase,
      name,
      host: hermetic.host,
      chainId: session.chainId,
      spaceId: session.spaceId,
      did: hermetic.ownerDid,
      sessionDid: session.verificationMethod.split("#", 1)[0],
      posture: "local-owner-key",
      operatorType: "human",
      authMethod: "local",
      privateKey: hermetic.ownerPrivateKey,
      address: session.address,
    });
    if (options.session === true) await writeJsonAtomic(sessionPath(name), session);
  });
}

/** Every entry under `root`: path, kind, size, sha256 and mtime. */
export async function snapshotHome(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (entry.isDirectory()) {
        entries.push(`dir ${relative(root, path)} ${stats.mtimeMs}`);
        await walk(path);
      } else {
        const sha256 = entry.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : "-";
        entries.push(`file ${relative(root, path)} ${stats.size} ${sha256} ${stats.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return entries;
}

export interface TcRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly pid: number;
  /** `stdout` parsed as JSON, when it is JSON. */
  readonly json?: unknown;
  /** `error` of the stderr JSON document, when there is one. */
  readonly error?: Record<string, unknown>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Spawn `node bin/tc ARGS` against `home` (HOME and TC_HOME), with TC_HOST and
 * TC_PRIVATE_KEY removed unless `env` sets them.
 */
export async function runTc(
  home: string,
  args: readonly string[],
  options: {
    env?: Readonly<Record<string, string>>;
    onSpawn?: (pid: number) => void | Promise<void>;
  } = {},
): Promise<TcRun> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home, TC_HIDE_BANNER: "1" };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  delete env.TC_PROFILE;
  Object.assign(env, options.env);
  const started = performance.now();
  const child = Bun.spawn([process.env.NODE_BINARY ?? "node", TC_BIN, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const spawned = options.onSpawn?.(child.pid);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await spawned;
  const document = parseJson(stderr.trim());
  const error = typeof document === "object" && document !== null && "error" in document &&
      typeof document.error === "object" && document.error !== null
    ? document.error as Record<string, unknown>
    : undefined;
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: performance.now() - started,
    pid: child.pid,
    ...(stdout.trim() === "" ? {} : { json: parseJson(stdout) }),
    ...(error === undefined ? {} : { error }),
  };
}

/** PIDs whose parent is `ppid` (Linux `/proc`). */
export async function childPids(ppid: number): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    // Fields after the parenthesised command: state, ppid, ...
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[1]) === ppid) pids.push(Number(entry));
  }
  return pids;
}

/** True while `pid` exists (signal 0); false once it is gone (ESRCH). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
