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

test("packed root and encryption entrypoints load in CJS and ESM", async () => {
  const smokeDirectory = await mkdtemp(join(packageDirectory, ".entrypoint-smoke-"));
  try {
    // Runtime entrypoint coverage does not need declaration bundling (which is
    // validated separately by the public-facade compile fixture).
    await run(process.execPath, ["x", "tsup", "--no-dts"], packageDirectory);
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
    const exerciseTaggedHttp = `
      async function exerciseTaggedHttp(EncryptionService, TransportResponseError) {
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
            const error = new TransportResponseError(403);
            if (error.name !== 'DecryptTransportResponseError') throw new Error('transport error name is unstable');
            throw error;
          } },
          node: { fetchByNetworkId: async () => descriptor },
        });
        const encrypted = await service.encryptToNetwork(networkId, new Uint8Array([1]));
        if (!encrypted.ok) throw new Error('could not create envelope');
        const result = await service.decryptEnvelope(encrypted.data, { proofs: [] });
        if (result.ok || result.error.code !== 'DECRYPT_DENIED') {
          throw new Error('tagged cross-entrypoint HTTP response was not classified as denied');
        }
      }
    `;
    await run(
      nodeBinary,
      [
        "-e",
        `const root = require('@tinycloud/sdk-services'); const encryption = require('@tinycloud/sdk-services/encryption'); ${assertEntrypoints} ${exerciseTaggedHttp} (async () => { await exerciseTaggedHttp(root.EncryptionService, encryption.DecryptTransportResponseError); await exerciseTaggedHttp(encryption.EncryptionService, root.DecryptTransportResponseError); })().catch((error) => { console.error(error); process.exitCode = 1; });`,
      ],
      smokeDirectory,
    );
    await run(
      nodeBinary,
      [
        "--input-type=module",
        "-e",
        `const root = await import('@tinycloud/sdk-services'); const encryption = await import('@tinycloud/sdk-services/encryption'); ${assertEntrypoints} ${exerciseTaggedHttp} await exerciseTaggedHttp(root.EncryptionService, encryption.DecryptTransportResponseError); await exerciseTaggedHttp(encryption.EncryptionService, root.DecryptTransportResponseError);`,
      ],
      smokeDirectory,
    );
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true });
  }
}, 30_000);
