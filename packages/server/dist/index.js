// src/identity.ts
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TinyCloudNode } from "@tinycloud/node-sdk";
var DEFAULT_HOST = "https://node.tinycloud.xyz";
async function deriveDstackPrivateKey(options) {
  const res = await options.client.getKey(options.path, options.purpose);
  if (!(res.key instanceof Uint8Array) || res.key.length === 0) {
    throw new Error("dstack getKey returned no key material");
  }
  return keccak256(res.key);
}
function serverDidForPrivateKey(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return `did:pkh:eip155:1:${account.address}`;
}
async function createServerIdentity(options) {
  const host = options.host ?? DEFAULT_HOST;
  const node = new TinyCloudNode({
    ...options.nodeConfig,
    privateKey: options.privateKey,
    host,
    prefix: options.prefix,
    manifest: options.manifest,
    autoCreateSpace: options.autoCreateSpace ?? false,
    enablePublicSpace: options.enablePublicSpace ?? false,
    includeAccountRegistryPermissions: options.includeAccountRegistryPermissions ?? false
  });
  await node.signIn();
  return {
    node,
    did: node.did,
    host,
    privateKey: options.privateKey
  };
}
var SESSION_ERROR_PATTERN = /\b(session\s+expired|invalid\s+session|token\s+expired|expired\s+credentials?|unauthorized|unauthenticated|sign.?in\s*required)\b|\b401\b(?![\d-])/i;
function isTinyCloudSessionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return SESSION_ERROR_PATTERN.test(message);
}
async function withSessionRefresh(node, fn) {
  try {
    return await fn();
  } catch (error) {
    if (isTinyCloudSessionError(error)) {
      await node.signIn();
      return fn();
    }
    throw error;
  }
}

// src/delegated-secrets.ts
import {
  deserializeDelegation
} from "@tinycloud/node-sdk";
import { resolveSecretPath } from "@tinycloud/sdk-core";
function createServerDelegateClient(options) {
  const delegation = parseDelegation(options.delegation);
  let nodePromise;
  async function getNode() {
    if (!nodePromise) {
      if (options.node) {
        nodePromise = Promise.resolve(options.node);
        return options.node;
      }
      const identityOptions = {
        privateKey: options.privateKey,
        host: options.host,
        prefix: options.prefix,
        enablePublicSpace: false,
        includeAccountRegistryPermissions: false,
        nodeConfig: options.nodeConfig
      };
      const created = options.nodeFactory ? options.nodeFactory(identityOptions) : createServerIdentity(identityOptions).then(
        (identity) => identity.node
      );
      nodePromise = created;
      return created;
    }
    return nodePromise;
  }
  return {
    async getSecret(name, secretOptions) {
      const node = await getNode();
      return readDelegatedSecret(node, delegation, name, secretOptions);
    }
  };
}
async function readDelegatedSecret(node, delegation, name, options) {
  const secretKey = resolveSecretPath(name, options).permissionPaths.vault;
  const access = await node.useDelegation(delegation);
  const result = await access.kv.get(secretKey, { raw: true, prefix: "" });
  if (!result.ok) {
    const message = result.error?.message ?? `failed to read ${secretKey}`;
    throw new Error(`delegated secret ${name} KV get failed: ${message}`);
  }
  const envelope = parseEncryptedEnvelope(
    result.data?.data,
    name
  );
  const proofCid = access.restorable?.delegationCid ?? access.delegation.cid;
  if (!proofCid) {
    throw new Error(`delegated secret ${name} has no decrypt proof`);
  }
  const decrypted = await node.encryption.decryptEnvelope(envelope, { proofs: [proofCid] });
  if (!decrypted.ok) {
    throw new Error(`delegated secret ${name} decrypt failed: ${decrypted.error.message}`);
  }
  return parseSecretPayload(decrypted.data, name);
}
function parseDelegation(delegation) {
  return typeof delegation === "string" ? deserializeDelegation(delegation) : delegation;
}
function parseEncryptedEnvelope(rawEnvelope, name = "secret") {
  const parsed = typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.v !== "number" || typeof parsed.networkId !== "string" || typeof parsed.ciphertext !== "string" || typeof parsed.encryptedSymmetricKey !== "string") {
    throw new Error(`delegated secret ${name} did not contain an encrypted envelope`);
  }
  return parsed;
}
function parseSecretPayload(plaintext, name = "secret") {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error(`delegated secret ${name} did not contain valid JSON`);
  }
  if (typeof parsed.value !== "string") {
    throw new Error(`delegated secret ${name} did not contain a string value`);
  }
  return parsed.value;
}

// src/siwe-session.ts
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { getAddress, recoverMessageAddress } from "viem";
var DEFAULT_NONCE_TTL_MS = 5 * 60 * 1e3;
var DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
var ServerAuthError = class extends Error {
};
var NonceStore = class {
  constructor(ttlMs = DEFAULT_NONCE_TTL_MS) {
    this.ttlMs = ttlMs;
  }
  nonces = /* @__PURE__ */ new Map();
  issue(address) {
    this.sweep();
    const normalized = getAddress(address).toLowerCase();
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(this.key(normalized, nonce), {
      address: normalized,
      createdAt: Date.now()
    });
    return nonce;
  }
  validate(address, nonce) {
    const normalized = getAddress(address).toLowerCase();
    const key = this.key(normalized, nonce);
    const entry = this.nonces.get(key);
    if (!entry) return false;
    this.nonces.delete(key);
    return Date.now() - entry.createdAt <= this.ttlMs;
  }
  key(address, nonce) {
    return `${address}:${nonce}`;
  }
  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.nonces) {
      if (now - entry.createdAt > this.ttlMs) this.nonces.delete(key);
    }
  }
};
async function verifySiweMessage(message, signature) {
  const lines = message.split("\n");
  let claimed;
  try {
    claimed = getAddress((lines[1] ?? "").trim());
  } catch {
    throw new ServerAuthError("SIWE message is missing a valid address on line 2");
  }
  const nonceMatch = message.match(/^Nonce: (.+)$/m);
  if (!nonceMatch || nonceMatch[1] === void 0) {
    throw new ServerAuthError("SIWE message is missing a Nonce line");
  }
  const nonce = nonceMatch[1].trim();
  let recovered;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch (error) {
    throw new ServerAuthError(
      `SIWE signature recovery failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (getAddress(recovered) !== claimed) {
    throw new ServerAuthError(
      `SIWE signature does not match message address (recovered ${recovered}, expected ${claimed})`
    );
  }
  return { address: claimed, nonce };
}
function issueSessionToken(address, secret, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS) {
  const normalized = getAddress(address);
  const now = Math.floor(Date.now() / 1e3);
  const claims = {
    sub: normalized,
    address: normalized,
    iat: now,
    exp: now + ttlSeconds
  };
  return {
    token: signJwt({ alg: "HS256", typ: "JWT" }, claims, secret),
    expiresIn: ttlSeconds
  };
}
function verifySessionToken(token, secret) {
  const claims = verifyJwt(token, secret);
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw new ServerAuthError("session token missing 'sub' claim");
  }
  return { address: claims.sub };
}
function createSiweSession(options) {
  const nonceStore = options.nonceStore ?? new NonceStore();
  const sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  return {
    issueNonce(address) {
      return nonceStore.issue(address);
    },
    async verify(message, signature) {
      const verified = await verifySiweMessage(message, signature);
      if (!nonceStore.validate(verified.address, verified.nonce)) {
        throw new ServerAuthError("nonce is invalid, expired, or already used");
      }
      return issueSessionToken(verified.address, options.jwtSecret, sessionTtlSeconds);
    },
    verifyToken(token) {
      return verifySessionToken(token, options.jwtSecret);
    }
  };
}
function signJwt(header, payload, secret) {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new ServerAuthError("session token is not a valid JWT");
  }
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  const actual = base64UrlDecode(parts[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ServerAuthError("session token signature verification failed");
  }
  const claims = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1e3)) {
    throw new ServerAuthError("session token expired");
  }
  return claims;
}
function base64UrlEncode(value) {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return buffer.toString("base64url");
}
function base64UrlDecode(value) {
  return Buffer.from(value, "base64url");
}
export {
  NonceStore,
  ServerAuthError,
  createServerDelegateClient,
  createServerIdentity,
  createSiweSession,
  deriveDstackPrivateKey,
  isTinyCloudSessionError,
  issueSessionToken,
  parseDelegation,
  parseEncryptedEnvelope,
  parseSecretPayload,
  readDelegatedSecret,
  serverDidForPrivateKey,
  verifySessionToken,
  verifySiweMessage,
  withSessionRefresh
};
//# sourceMappingURL=index.js.map