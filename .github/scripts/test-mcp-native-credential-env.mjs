import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";

const root = resolve(new URL("../..", import.meta.url).pathname);
const helper = join(root, ".github/scripts/mcp-native-credential-env.sh");
const testRoot = await mkdtemp(join(tmpdir(), "mcp-native-credential-test-"));
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
const bash = (script, credential) => run("bash", ["-c", script], {
  TC_MCP_NATIVE_SERVICE_CREDENTIAL: credential,
  RUNNER_TEMP: envDir,
});
const helperCall = (fn, credential, keepFile = true) => bash(
  `set -euo pipefail; source "${helper}"; ${fn}; ${keepFile ? "trap - EXIT;" : ""} printf '%s\\n' "$MCP_NATIVE_SERVICE_CREDENTIAL_ENV_FILE"`,
  credential,
);

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
const receiverSecret = x25519.utils.randomSecretKey();
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

async function encryptWithPhala(envFile) {
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(shimPath).href}`].filter(Boolean).join(" ");
  const result = run(bin, ["envs", "encrypt", "test-cvm", "--api-token", "test-only", "--env", envFile, "--no-newline"], {
    PHALA_CLOUD_API_PREFIX: apiPrefix,
    PHALA_CLOUD_DIR: homeDir,
    NODE_OPTIONS: nodeOptions,
  });
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

try {
  const cases = [
    `${"a".repeat(24)} #=\\ tail `,
    `${"b".repeat(20)}'${"c".repeat(18)} # \\"`,
    `${"d".repeat(20)}'${"e".repeat(18)}\` `,
  ];
  for (const [index, credential] of cases.entries()) {
    const written = helperCall("write_mcp_native_service_credential_env_file", credential);
    if (written.status !== 0) fail(`Representable single-line case ${index} was rejected.`);
    const envFile = written.stdout.trim().split("\n").at(-1);
    if (!envFile || !envFile.startsWith(envDir)) fail(`Single-line case ${index} did not create its temporary env file.`);
    const fileMode = (await stat(envFile)).mode & 0o777;
    if (fileMode !== 0o600) fail("Credential env file is not mode 0600.");
    const parsed = await encryptWithPhala(envFile);
    if (parsed.env?.length !== 1 || parsed.env[0]?.key !== "TC_MCP_NATIVE_SERVICE_CREDENTIAL" || parsed.env[0]?.value !== credential) {
      fail(`Phala 1.1.22 did not round-trip single-line case ${index} exactly.`);
    }
    await rm(envFile, { force: true });
  }
  const short = helperCall("write_mcp_native_service_credential_env_file", "too-short");
  if (short.status === 0 || (await readdir(envDir)).length !== 0) fail("Credential shorter than 32 bytes was accepted.");

  const cleanup = helperCall("write_mcp_native_service_credential_env_file", "C".repeat(32), false);
  if (cleanup.status !== 0 || !cleanup.stdout.trim() || (await readdir(envDir)).length !== 0) {
    fail("Temporary credential env file cleanup did not run on shell exit.");
  }

  for (const [index, credential] of [
    `${"x".repeat(32)}\rINJECTED=yes`,
    `${"x".repeat(32)}\nINJECTED=yes`,
    `${"x".repeat(32)}\r\nINJECTED=yes`,
  ].entries()) {
    const rejected = helperCall("write_mcp_native_service_credential_env_file", credential);
    if (rejected.status === 0) fail(`CR/LF payload ${index} was accepted.`);
    if ((await readdir(envDir)).length !== 0) fail(`CR/LF payload ${index} created an env file before rejection.`);
  }

  const unrepresentable = `${"z".repeat(32)}'"\``;
  if (helperCall("write_mcp_native_service_credential_env_file", unrepresentable).status === 0) {
    fail("A credential that the Phala parser cannot preserve was accepted.");
  }
  if ((await readdir(envDir)).length !== 0) fail("Unrepresentable credential created an env file.");

  const absent = helperCall("write_mcp_native_service_credential_env_file", "");
  if (absent.status !== 0 || (await readdir(envDir)).length !== 0) fail("Absent optional credential did not leave native auth unset.");

  const rawUnsafeFile = join(envDir, "unsafe.env");
  await writeFile(rawUnsafeFile, `TC_MCP_NATIVE_SERVICE_CREDENTIAL=${"x".repeat(32)}\nINJECTED=yes\n`);
  const rawParsed = await encryptWithPhala(rawUnsafeFile);
  if (rawParsed.env?.length !== 2 || rawParsed.env[1]?.key !== "INJECTED" || rawParsed.env[1]?.value !== "yes") {
    fail("The pinned Phala consumer did not reproduce the unvalidated line-injection case.");
  }
  process.stdout.write("Phala 1.1.22 env transport regression passed: 3 exact round trips, 3 CR/LF refusals, absent no-op, unsafe-line injection reproduced.\n");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
