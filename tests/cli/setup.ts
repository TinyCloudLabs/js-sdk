import { TinyCloudNode } from "@tinycloud/node-sdk";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";

const SERVER_URL = process.env.TC_TEST_SERVER ?? "http://localhost:8000";
const DEFAULT_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_KEY = process.env.TC_TEST_PRIVATE_KEY ?? DEFAULT_KEY;
const PROFILE_NAME = "cli-test";
const PROFILES_DIR = join(homedir(), ".tinycloud", "profiles");
const CONFIG_DIR = join(homedir(), ".tinycloud");
const TC_BIN = join(import.meta.dir, "../../packages/cli/bin/tc");

export { SERVER_URL, TEST_KEY, PROFILE_NAME, TC_BIN };

export async function checkServerHealth(): Promise<void> {
  try {
    const res = await fetch(`${SERVER_URL}/version`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const info = await res.json();
    console.log(`[Server] Connected to tinycloud-node v${info.version} at ${SERVER_URL}`);
  } catch (e) {
    throw new Error(
      `Cannot reach tinycloud-node at ${SERVER_URL}.\n` +
      `Start the server: cd tinycloud-node && cargo run\n` +
      `Or set TC_TEST_SERVER=https://node.tinycloud.xyz\n` +
      `Error: ${e}`
    );
  }
}

/**
 * Creates a TinyCloudNode instance, signs in, and writes
 * a CLI profile so that `tc --profile cli-test` commands work.
 */
export async function setupCliProfile(): Promise<TinyCloudNode> {
  const node = new TinyCloudNode({
    privateKey: TEST_KEY,
    host: SERVER_URL,
    prefix: "cli-test",
    autoCreateSpace: true,
  });

  await node.signIn();
  console.log("[Setup] Signed in, DID:", node.did);

  const session = node.session!;
  const profileDir = join(PROFILES_DIR, PROFILE_NAME);

  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  await writeFile(
    join(CONFIG_DIR, "config.json"),
    JSON.stringify({ defaultProfile: PROFILE_NAME, version: 1 }, null, 2),
  );

  await writeFile(
    join(profileDir, "profile.json"),
    JSON.stringify({
      name: PROFILE_NAME,
      host: SERVER_URL,
      chainId: session.chainId ?? 1,
      spaceName: "default",
      did: session.verificationMethod,
      authMethod: "local",
      posture: "local-owner-key",
      privateKey: TEST_KEY,
      address: session.address,
      spaceId: session.spaceId,
      createdAt: new Date().toISOString(),
    }, null, 2),
  );

  await writeFile(
    join(profileDir, "key.json"),
    JSON.stringify(session.jwk, null, 2),
  );

  await writeFile(
    join(profileDir, "session.json"),
    JSON.stringify({
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId: session.spaceId,
      jwk: session.jwk,
      verificationMethod: session.verificationMethod,
      address: session.address,
      chainId: session.chainId,
      siwe: session.siwe,
      signature: session.signature,
    }, null, 2),
  );

  console.log("[Setup] CLI profile written to", profileDir);
  return node;
}

/**
 * Run a `tc` CLI command and return parsed JSON output.
 * Always passes --profile, --host, --json, --quiet flags.
 */
export async function tc(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; json: any }> {
  const proc = Bun.spawn(
    ["bun", TC_BIN, "--profile", PROFILE_NAME, "--host", SERVER_URL, "--json", "--quiet", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test" },
    },
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  let json: any = null;
  try {
    json = JSON.parse(stdout.trim());
  } catch {}

  return { stdout: stdout.trim(), stderr, exitCode, json };
}

/**
 * Clean up the test profile directory.
 */
export async function cleanupCliProfile(): Promise<void> {
  const profileDir = join(PROFILES_DIR, PROFILE_NAME);
  try {
    await rm(profileDir, { recursive: true });
    console.log("[Cleanup] Removed CLI test profile");
  } catch {}
}
