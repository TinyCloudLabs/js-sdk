import { PrivateKeySigner } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import type { ShareUploadAuthorization, ShareUploadInput } from "@tinycloud/share-sdk";

const DEFAULT_SHARE_ORIGIN = "https://share.tinycloud.xyz";

function authenticationMessage(origin: string, address: string, nonce: string, issuedAt: string): string {
  return [
    `${new URL(origin).host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to TinyCloud Share.",
    "",
    `URI: ${origin}`,
    "Version: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

function cookieFromResponse(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  const raw = values[0] ?? response.headers.get("set-cookie") ?? undefined;
  return raw?.split(";", 1)[0];
}

async function profilePrivateKey(): Promise<string> {
  const config = await ProfileManager.getConfig();
  const profile = await ProfileManager.getProfile(process.env.TC_PROFILE ?? config.defaultProfile);
  if (typeof profile.privateKey !== "string" || profile.privateKey.length === 0) {
    throw new Error("share upload requires a local wallet profile");
  }
  return profile.privateKey;
}

/**
 * Establishes the same nonce-bound Share session used by the browser and
 * returns only the upload request headers. Private wallet material and the
 * session cookie never cross this adapter's boundary or enter SDK results.
 */
export function createProductionUploadAuthorizer(input: {
  readonly origin?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly privateKey?: () => Promise<string>;
} = {}): (upload: ShareUploadInput) => Promise<ShareUploadAuthorization> {
  const origin = input.origin ?? DEFAULT_SHARE_ORIGIN;
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  let sessionCookie: string | undefined;
  let sessionExpiresAt = 0;
  return async (_upload) => {
    if (sessionCookie !== undefined && sessionExpiresAt > Date.now() + 30_000) return { cookie: sessionCookie };
    const key = await (input.privateKey?.() ?? profilePrivateKey());
    const signer = new PrivateKeySigner(key);
    const address = await signer.getAddress();
    const nonceResponse = await fetchFn(`${origin}/api/share/auth/openkey/nonce`, {
      headers: { accept: "application/json", origin },
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!nonceResponse.ok) throw new Error("share sign-in nonce was rejected");
    const nonceBody = await nonceResponse.json() as { readonly nonce?: unknown; readonly expiresAt?: unknown };
    if (typeof nonceBody.nonce !== "string" || typeof nonceBody.expiresAt !== "string") throw new Error("share sign-in challenge is invalid");
    const issuedAt = new Date().toISOString();
    const message = authenticationMessage(origin, address, nonceBody.nonce, issuedAt);
    const signature = await signer.signMessage(message);
    const authenticated = await fetchFn(`${origin}/api/share/auth/openkey`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", origin },
      body: JSON.stringify({ address, signature, message, nonce: nonceBody.nonce, issuedAt }),
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const cookie = cookieFromResponse(authenticated);
    if (!authenticated.ok || cookie === undefined) throw new Error("share sign-in was rejected");
    sessionCookie = cookie;
    sessionExpiresAt = Date.now() + 15 * 60_000;
    return { cookie };
  };
}
