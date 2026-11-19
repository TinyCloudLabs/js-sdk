import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";

const root = resolve(new URL("../..", import.meta.url).pathname);
const helper = join(root, ".github/scripts/mcp-deploy-env.sh");
const testRoot = await mkdtemp(join(tmpdir(), "mcp-deploy-env-test-"));
const envDir = join(testRoot, "env");
const homeDir = join(testRoot, "home");
await mkdir(envDir);
await mkdir(homeDir);

const fail = (message) => { throw new Error(message); };
const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
};

const fixture = {
  TINYCLOUD_MCP_IMAGE: "ghcr.io/tinycloudlabs/tinycloud-mcp:0.8.3-beta.17",
  CLOUDFLARE_API_TOKEN: `${"a".repeat(24)} #=\\ tail `,
  TC_MCP_STATE_SECRET: `${"s".repeat(32)}=state 'unchanged'`,
  TC_MCP_INTROSPECTION_CLIENT_ID: "client id #= unchanged",
  TC_MCP_INTROSPECTION_CLIENT_SECRET: `${"b".repeat(24)}'${"c".repeat(18)} # \"`,
  TC_MCP_NATIVE_SERVICE_CREDENTIAL: `${"d".repeat(20)}'${"e".repeat(18)} `,
  CERTBOT_EMAIL: "ops@tinycloud.xyz",
};

const env = {
  ...fixture,
  PHALA_CLOUD_API_KEY: "test-only-api-key-not-for-container",
  RUNNER_TEMP: envDir,
};
try {
const writerScript = `set -euo pipefail; source "${helper}"; write_mcp_deploy_env_file; trap - EXIT; printf '%s\\n' "$MCP_DEPLOY_ENV_FILE"`;
const written = run("bash", ["-c", writerScript], env);
if (written.status !== 0) fail("The complete MCP deploy environment file writer is not implemented.");
const envFile = written.stdout.trim().split("\n").at(-1);
if (!envFile || !envFile.startsWith(envDir)) fail("The complete deploy environment file was not created under RUNNER_TEMP.");
let mergeAllowedEnvKeys;
try {
  ({ mergeAllowedEnvKeys } = await import("./mcp-sync-allowed-envs.mjs"));
} catch {
  fail("The MCP allowed_envs synchronization helper is not implemented.");
}
const currentAllowed = ["LEGACY_CONFIG", "TC_MCP_STATE_SECRET", "CLOUDFLARE_API_TOKEN", "LEGACY_CONFIG"];
const deployKeys = Object.keys(fixture);
const nextAllowed = mergeAllowedEnvKeys(currentAllowed, deployKeys);
const expectedAllowed = [...new Set([...currentAllowed, ...deployKeys])];
if (JSON.stringify(nextAllowed) !== JSON.stringify(expectedAllowed)) {
  fail("Allowed-env merge did not preserve existing names and add each deploy key once.");
}
const withheldKey = "test-value-must-not-be-logged";
const missingSyncConfig = run("node", [join(root, ".github/scripts/mcp-sync-allowed-envs.mjs")], {
  PHALA_CLOUD_API_KEY: withheldKey,
  PHALA_CVM_ID: "",
  ENV_FILE: "",
});
if (missingSyncConfig.status === 0 || !missingSyncConfig.stderr.includes("MCP allowed_envs sync failed")) {
  fail("The allowlist sync helper did not fail closed when required configuration was missing.");
}
if (missingSyncConfig.stderr.includes(withheldKey)) fail("The allowlist sync helper exposed a credential in its error output.");

const bin = process.env.PHALA_BIN ?? "phala";
const version = run(bin, ["--version"]);
if (version.status !== 0 || !/(?:^|[^0-9])1\.1\.22(?:$|[^0-9])/.test(version.stdout)) {
  fail("This regression must exercise the workflow-pinned Phala CLI 1.1.22.");
}
const phalaPath = run("which", [bin]);
if (phalaPath.status !== 0) fail("Pinned Phala CLI was not found.");
const phalaEntry = realpathSync(phalaPath.stdout.trim());
const nobleRequire = createRequire(phalaEntry);
const noblePath = nobleRequire.resolve("@noble/curves/ed25519");
const { x25519 } = await import(pathToFileURL(noblePath).href);
const receiverSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const receiverPublic = x25519.getPublicKey(receiverSecret);
const apiPrefix = "http://phala-test.invalid/api/v1";
const shimPath = join(testRoot, "phala-fetch-shim.mjs");
const cvmFixture = {
  id: "test-cvm",
  name: "test-cvm",
  app_id: "test-app",
  vm_uuid: null,
  instance_id: null,
  vcpu: 1,
  memory: 1,
  disk_size: 1,
  status: "running",
  resource: {},
  gateway: {},
  kms_info: { encrypted_env_pubkey: Buffer.from(receiverPublic).toString("hex") },
};
await writeFile(shimPath, `
const apiPrefix = new URL(process.env.PHALA_CLOUD_API_PREFIX);
const cvm = ${JSON.stringify(cvmFixture)};
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.origin !== apiPrefix.origin || url.pathname !== \`\${apiPrefix.pathname}/cvms/test-cvm\`) {
    throw new Error("Phala test attempted an unexpected request");
  }
  return new Response(JSON.stringify(cvm), { status: 200, headers: { "content-type": "application/json" } });
};
`);

async function encryptWithPhala(file) {
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(shimPath).href}`].filter(Boolean).join(" ");
  const result = run(bin, ["envs", "encrypt", "test-cvm", "--env", file, "--no-newline"], {
    PHALA_CLOUD_API_KEY: "test-only",
    PHALA_CLOUD_API_PREFIX: apiPrefix,
    PHALA_CLOUD_DIR: homeDir,
    NODE_OPTIONS: nodeOptions,
  });
  if ([...Object.values(fixture), "test-only"].some((value) => result.stdout.includes(value) || result.stderr.includes(value))) {
    fail("Pinned Phala CLI logged a deploy environment value.");
  }
  if (result.status !== 0 || !/^[0-9a-f]+\n?$/.test(result.stdout)) {
    fail(`Pinned Phala env encryption failed locally (${result.status}): ${result.stderr.trim().slice(0, 400)}`);
  }
  const bytes = Buffer.from(result.stdout.trim(), "hex");
  const senderPublic = bytes.subarray(0, 32);
  const iv = bytes.subarray(32, 44);
  const ciphertext = bytes.subarray(44);
  const sharedSecret = x25519.getSharedSecret(receiverSecret, senderPublic);
  const key = await webcrypto.subtle.importKey("raw", sharedSecret, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

  const fileMode = (await stat(envFile)).mode & 0o777;
  if (fileMode !== 0o600) fail("Complete deploy environment file is not mode 0600.");
  const parsed = await encryptWithPhala(envFile);
  const actual = Object.fromEntries((parsed.env ?? []).map(({ key, value }) => [key, value]));
  for (const [key, value] of Object.entries(fixture)) {
    if (!Buffer.from(actual[key] ?? "", "utf8").equals(Buffer.from(value, "utf8"))) {
      fail(`Pinned Phala 1.1.22 CLI env-file round-trip did not preserve ${key} byte-for-byte.`);
    }
  }
  if (Object.hasOwn(actual, "PHALA_CLOUD_API_KEY")) fail("Phala API token was included in the container environment.");
  if (Object.keys(actual).length !== Object.keys(fixture).length) fail("Deploy environment file contains an unexpected or missing key.");
  const optionalEnvFile = join(envDir, "optional-native-credential.env");
  const optionalState = "o".repeat(32);
  await writeFile(optionalEnvFile, `TC_MCP_STATE_SECRET='${optionalState}'\n`, { mode: 0o600 });
  const optionalParsed = await encryptWithPhala(optionalEnvFile);
  const optionalValues = Object.fromEntries((optionalParsed.env ?? []).map(({ key, value }) => [key, value]));
  if (optionalValues.TC_MCP_STATE_SECRET !== optionalState) fail("Phala CLI changed the state secret in the optional-env case.");
  if (Object.hasOwn(optionalValues, "TC_MCP_NATIVE_SERVICE_CREDENTIAL")) {
    fail("Phala CLI injected the optional native credential when it was unset.");
  }
  await rm(optionalEnvFile, { force: true });

  const contents = await readFile(envFile, "utf8");
  if (contents.includes(env.PHALA_CLOUD_API_KEY)) fail("Phala API token was written to the deploy environment file.");
  for (const value of Object.values(fixture)) {
    if (written.stdout.includes(value) || written.stderr.includes(value)) fail("A deploy environment value was logged.");
  }
  await rm(envFile, { force: true });

  const missingCredential = run("bash", ["-c", writerScript], { ...env, TC_MCP_NATIVE_SERVICE_CREDENTIAL: "" });
  if (missingCredential.status === 0 || (await readdir(envDir)).length !== 0) {
    fail("Missing native service credential was accepted or left a partial env file.");
  }

  const injectedNewline = run("bash", ["-c", writerScript], { ...env, TC_MCP_STATE_SECRET: `${"s".repeat(32)}\nINJECTED=yes` });
  if (injectedNewline.status === 0 || (await readdir(envDir)).length !== 0) {
    fail("Line-injected state secret was accepted or left a partial env file.");
  }
  const injectedNativeCredential = run("bash", ["-c", writerScript], {
    ...env,
    TC_MCP_NATIVE_SERVICE_CREDENTIAL: `${"d".repeat(32)}\r\nINJECTED=yes`,
  });
  if (injectedNativeCredential.status === 0 || (await readdir(envDir)).length !== 0) {
    fail("CRLF-injected native service credential was accepted or left a partial env file.");
  }

  const cleanup = run("bash", ["-c", `set -euo pipefail; source "${helper}"; write_mcp_deploy_env_file; printf '%s\\n' "$MCP_DEPLOY_ENV_FILE"`], env);
  if (cleanup.status !== 0 || (await readdir(envDir)).length !== 0) fail("Deploy env file cleanup did not run on shell exit.");

  process.stdout.write("MCP deploy env regression passed: pinned Phala 1.1.22 CLI exact round-trip, state/native bytes, optional-unset omission, no logged values, CRLF injection refusal, allowlist preservation, missing-config refusal, 0600 file, and cleanup.\n");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
