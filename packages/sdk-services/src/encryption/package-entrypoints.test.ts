import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const execFile = promisify(execFileCallback);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "../..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const nodeBinary = process.env.NODE_BINARY ?? "node";

async function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFile(command, [...arguments_], {
    cwd,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

test("packed root and encryption entrypoints preserve unforgeable CJS and ESM error identity", async () => {
  const smokeDirectory = await mkdtemp(join(packageDirectory, ".entrypoint-smoke-"));
  try {
    await run(process.execPath, ["run", "build"], packageDirectory);
    const packed = JSON.parse(
      await run(
        "npm",
        ["pack", "--json", "--pack-destination", smokeDirectory],
        packageDirectory,
        { ...process.env, npm_config_cache: join(smokeDirectory, ".npm-cache") },
      ),
    ) as Array<{ filename: string }>;
    expect(packed).toHaveLength(1);

    const installedPackage = join(
      smokeDirectory,
      "node_modules",
      "@tinycloud",
      "sdk-services",
    );
    await mkdir(installedPackage, { recursive: true });
    await run(
      "tar",
      ["-xzf", join(smokeDirectory, packed[0]!.filename), "-C", installedPackage, "--strip-components=1"],
      packageDirectory,
    );

    // Keep the smoke install hermetic while satisfying external runtime deps.
    await symlink(
      join(workspaceDirectory, "node_modules", "zod"),
      join(smokeDirectory, "node_modules", "zod"),
      "dir",
    );
    await mkdir(join(smokeDirectory, "node_modules", "@tinycloud"), { recursive: true });
    await symlink(
      join(workspaceDirectory, "node_modules", "@tinycloud", "bootstrap"),
      join(smokeDirectory, "node_modules", "@tinycloud", "bootstrap"),
      "dir",
    );

    const assertEntrypoints = `
      if (typeof root.EncryptionService !== 'function' || typeof encryption.EncryptionService !== 'function' ||
          typeof root.DecryptTransportResponseError !== 'function' || typeof encryption.DecryptTransportResponseError !== 'function') {
        throw new Error('encryption values missing from packed entrypoint');
      }
    `;
    const assertSharedConstructor = `
      const constructors = [
        rootCjs.DecryptTransportResponseError,
        encryptionCjs.DecryptTransportResponseError,
        rootEsm.DecryptTransportResponseError,
        encryptionEsm.DecryptTransportResponseError,
      ];
      if (!constructors.every((constructor) => constructor === constructors[0])) {
        throw new Error('decrypt transport constructors differ across entrypoints');
      }
      for (const constructor of constructors) {
        if (!(new constructors[0](403) instanceof constructor)) {
          throw new Error('decrypt transport instanceof differs across entrypoints');
        }
      }
    `;
    const exerciseTransportFailure = `
      async function exerciseTransportFailure(EncryptionService, transportError, expectedCode) {
        const sha256 = (bytes) => {
          const output = new Uint8Array(32);
          let sum = 0;
          for (const byte of bytes) sum = (sum + byte) & 255;
          output.fill(sum);
          return output;
        };
        let seed = 1;
        const crypto = {
          sha256,
          randomBytes: (length) => Uint8Array.from({ length }, () => seed++ & 255),
          x25519FromSeed: (key) => ({ publicKey: key, privateKey: key }),
          x25519Dh: (left, right) => sha256(Uint8Array.from([...left, ...right])),
          authEncrypt: (_key, plaintext) => plaintext,
          authDecrypt: (_key, ciphertext) => ciphertext,
          sealToNetworkKey: (_key, symmetricKey) => symmetricKey,
          openWithReceiverKey: (_key, wrappedKey) => wrappedKey,
          verifyNodeSignature: () => true,
        };
        const networkId = 'urn:tinycloud:encryption:did:key:z6MkPrincipal:default';
        const descriptor = {
          networkId,
          ownerDid: 'did:key:z6MkPrincipal',
          name: 'default',
          members: [{ nodeId: 'did:key:z6MkNode', role: 'primary' }],
          threshold: { n: 1, t: 1 },
          state: 'active',
          publicEncryptionKey: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
          alg: 'x25519-aes256gcm/v1',
          keyVersion: 1,
          keyBackend: 'local-one-of-one',
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
        };
        const service = new EncryptionService({
          crypto,
          signer: { signDecryptInvocation: async (input) => ({
            authorization: 'authorization-canary',
            invocationCid: 'bafy-entrypoint',
            canonicalBody: JSON.stringify(Object.fromEntries(Object.entries(input.body).sort(([a], [b]) => a.localeCompare(b)))),
          }) },
          transport: { postDecrypt: async () => {
            throw transportError;
          } },
          node: { fetchByNetworkId: async () => descriptor },
        });
        const encrypted = await service.encryptToNetwork(networkId, new Uint8Array([1]));
        if (!encrypted.ok) throw new Error('could not create envelope');
        const result = await service.decryptEnvelope(encrypted.data, { proofs: [] });
        if (result.ok || result.error.code !== expectedCode) {
          throw new Error('mixed-entrypoint transport response was not classified correctly');
        }
      }
    `;
    await run(
      nodeBinary,
      [
        "--input-type=module",
        "-e",
        `const registryKey = Symbol.for('@tinycloud/sdk-services/DecryptTransportResponseError.constructor'); class PreseededError extends Error { constructor(status) { super('preseeded'); this.status = status; } }; Object.defineProperty(globalThis, registryKey, { configurable: false, value: PreseededError }); const { createRequire } = await import('node:module'); const require = createRequire(import.meta.url); const rootCjs = require('@tinycloud/sdk-services'); const encryptionCjs = require('@tinycloud/sdk-services/encryption'); const rootEsm = await import('@tinycloud/sdk-services'); const encryptionEsm = await import('@tinycloud/sdk-services/encryption'); const root = rootEsm; const encryption = encryptionEsm; ${assertEntrypoints} ${assertSharedConstructor} if (rootCjs.DecryptTransportResponseError === PreseededError || !(new rootCjs.DecryptTransportResponseError(403) instanceof Error) || new PreseededError(403) instanceof rootCjs.DecryptTransportResponseError) throw new Error('pre-seeded global constructor affected packed package identity'); ${exerciseTransportFailure} await exerciseTransportFailure(rootCjs.EncryptionService, new encryptionEsm.DecryptTransportResponseError(403), 'DECRYPT_DENIED'); await exerciseTransportFailure(encryptionCjs.EncryptionService, new rootEsm.DecryptTransportResponseError(403), 'DECRYPT_DENIED'); const spoofed = Object.assign(new Error('forged response'), { status: 403 }); Object.defineProperty(spoofed, Symbol.for('@tinycloud/sdk-services/decrypt-transport-response'), { value: true }); await exerciseTransportFailure(rootEsm.EncryptionService, spoofed, 'TRANSPORT_ERROR');`,
      ],
      smokeDirectory,
    );
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true });
  }
}, 30_000);
