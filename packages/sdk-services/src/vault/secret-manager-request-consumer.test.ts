import { describe, expect, test } from "bun:test";
import type { IServiceContext } from "../types";
import { KVService } from "../kv/KVService";
import { SecretsService } from "../secrets/SecretsService";
import { DataVaultService } from "./DataVaultService";

// TC-834 review P2: a refused vault write must reach Secret Manager's shipped
// `/request` page as a row error, never as an expired session. The chain is
// real (KVService → network DataVaultService → SecretsService); only the
// node's HTTP answers are stubbed, and the page's classifier is copied below.

// ---------------------------------------------------------------------------
// Copied from TinyCloudLabs/secret-manager b7aaa37 src/lib/request/session.ts:113-153,278-289 and storage-status.ts. Update only together with Secret Manager.

const STORAGE_FULL_CODES = new Set([
  "STORAGE_QUOTA_EXCEEDED",
  "STORAGE_LIMIT_REACHED",
]);

// Older SDKs report the node's text ("Storage quota exceeded. Used: …") or
// wrap it in another code; newer SDKs use the codes above and their own copy.
const STORAGE_FULL_TEXT =
  /storage quota exceeded|write exceeds remaining storage|storage is full|storage you have left/i;

function codeAndMessage(error: unknown): { code?: unknown; message?: unknown } {
  if (typeof error === "string") return { message: error };
  if (!error || typeof error !== "object") return {};
  return error as { code?: unknown; message?: unknown };
}

/**
 * True when a write failed for storage: the owner's TinyCloud storage is
 * full, or the write is larger than what is left. Reads keep working, so the
 * app stays usable read-only.
 */
export function isStorageFullError(error: unknown): boolean {
  const { code, message } = codeAndMessage(error);
  if (typeof code === "string" && STORAGE_FULL_CODES.has(code)) return true;
  return typeof message === "string" && STORAGE_FULL_TEXT.test(message);
}

export type Existence = "present" | "absent" | "unauthorized" | "error";

interface HeadResult {
  ok: boolean;
  error?: { code?: string; message?: string; meta?: unknown };
}

/** `meta.status` of an SDK error, when it has one. */
function errorStatus(error: { meta?: unknown } | undefined): unknown {
  const meta = error?.meta;
  return meta !== null && typeof meta === "object" && "status" in meta ? meta.status : undefined;
}

/**
 * 200 is present; a plain 404 ("Key not found") is absent. A 401
 * (`AUTH_UNAUTHORIZED`) means TinyCloud refused this session, so only a new
 * sign-in helps. Anything else (403, "Space not found", network errors) is
 * an error, never absent.
 */
export function classifyHead(result: HeadResult): Existence {
  if (result.ok) return "present";
  const { code, message, meta } = result.error ?? {};
  if (code === "KV_NOT_FOUND" && meta === undefined && message?.startsWith("Key not found:")) {
    return "absent";
  }
  if (code === "AUTH_UNAUTHORIZED" || errorStatus(result.error) === 401) return "unauthorized";
  return "error";
}

export type AddOutcome = "saved" | "present" | "storage-full" | "expired" | "error";

interface SecretsPutResult {
  ok: boolean;
  error?: { code?: string; message?: string; meta?: unknown };
}

/** Maps a failed `secrets.put` to the row state it leaves. */
export function classifyPutFailure(error: SecretsPutResult["error"]): AddOutcome {
  if (isStorageFullError(error)) return "storage-full";
  if (error?.code === "AUTH_UNAUTHORIZED" || errorStatus(error) === 401) return "expired";
  return "error";
}

// The decision part of `RequestSession.add` (session.ts:278-289) as a pure
// function: the existence re-check before the put, the put, and the
// existence re-check after a failed put.
function addOutcome(existsBefore: Existence, putResult: SecretsPutResult, existsAfter: () => Existence): AddOutcome {
  if (existsBefore === "present") return "present";
  if (existsBefore === "unauthorized") return "expired";
  if (existsBefore === "error") return "error";
  if (putResult.ok) return "saved";
  const outcome = classifyPutFailure(putResult.error);
  if (outcome !== "error") return outcome;
  return existsAfter() === "unauthorized" ? "expired" : "error";
}
// End of the Secret Manager copy.
// ---------------------------------------------------------------------------

const ADDRESS = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const SPACE_ID = `tinycloud:pkh:eip155:1:${ADDRESS}:secrets`;
const HOST = "https://node.tinycloud.test";
const PUT_REFUSAL = `Unauthorized Action: ${SPACE_ID}/kv/vault/secrets/API_KEY / tinycloud.kv/put`;

type NodeAnswer = { status: number; body: string };

/** One owner session: the node answers KV puts with `put` and metadata reads with `head`. */
function secretsOverStubbedNode(answers: { put: NodeAnswer; head: NodeAnswer }) {
  const actions: string[] = [];
  const context = {
    session: {
      delegationHeader: { Authorization: "Bearer test" },
      delegationCid: "bafy-test",
      spaceId: SPACE_ID,
      verificationMethod: "did:key:z6MkSession",
      jwk: {},
    },
    isAuthenticated: true,
    invoke: (_session: unknown, _service: string, _path: string, action: string) => {
      actions.push(action);
      return { Authorization: "Bearer signed-invocation", "x-test-action": action };
    },
    fetch: async (_url: string, init: { headers: Record<string, string> }) => {
      const answer = init.headers["x-test-action"] === "tinycloud.kv/put" ? answers.put : answers.head;
      return new Response(answer.body, { status: answer.status, statusText: "" });
    },
    hosts: [HOST],
    getService: () => undefined,
    emit: () => undefined,
    on: () => () => undefined,
    abortSignal: new AbortController().signal,
    retryPolicy: { maxAttempts: 1, backoff: "none", baseDelayMs: 0, maxDelayMs: 0, retryableErrors: [] },
  } as unknown as IServiceContext;

  const kv = new KVService({});
  kv.initialize(context);
  const vault = new DataVaultService({
    spaceId: SPACE_ID,
    crypto: {} as never,
    encryption: {
      networkId: `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:default`,
      service: {
        encryptToNetwork: async (networkId: string) => ({
          ok: true,
          data: {
            v: 1,
            networkId,
            alg: "x25519-aes256gcm/v1",
            keyVersion: 1,
            encryptedSymmetricKey: "AQID",
            encryptedSymmetricKeyHash: "a".repeat(64),
            ciphertext: "AQID",
          },
        }),
      } as never,
    },
    tc: { kv, did: `did:pkh:eip155:1:${ADDRESS}`, address: ADDRESS, chainId: 1, hosts: [HOST] },
  } as never);
  vault.initialize(context);
  return { secrets: new SecretsService(vault), kv, actions };
}

describe("Secret Manager /request consumer (b7aaa37 classifier copy)", () => {
  test("a 403 put is a row error, not an expired session; the authorized re-check finds the key absent", async () => {
    const { secrets, kv, actions } = secretsOverStubbedNode({
      put: { status: 403, body: PUT_REFUSAL },
      head: { status: 404, body: "Key not found" },
    });

    const put = await secrets.put("API_KEY", "value");
    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error).toMatchObject({ code: "PERMISSION_DENIED", service: "vault", meta: { status: 403 } });
    expect(classifyPutFailure(put.error)).toBe("error");

    // The page's follow-up metadata request on the same path, through the real KVService.
    const head = await kv.head("vault/secrets/API_KEY", { prefix: "" });
    expect(classifyHead(head)).toBe("absent");
    expect(addOutcome("absent", put, () => classifyHead(head))).toBe("error");
    expect(actions).toEqual(["tinycloud.kv/put", "tinycloud.kv/metadata"]);
  });

  test("control: a 401 put is AUTH_UNAUTHORIZED with status 401, so the page signs out without another request", async () => {
    const { secrets } = secretsOverStubbedNode({
      put: { status: 401, body: PUT_REFUSAL },
      head: { status: 404, body: "Key not found" },
    });

    const put = await secrets.put("API_KEY", "value");
    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error).toMatchObject({ code: "AUTH_UNAUTHORIZED", service: "vault", meta: { status: 401 } });
    expect(classifyPutFailure(put.error)).toBe("expired");
    expect(addOutcome("absent", put, () => { throw new Error("no re-check after a 401"); })).toBe("expired");
  });

  test("control: an ifAbsent put that meets an existing key (412) is ALREADY_EXISTS, a row error today", async () => {
    const { secrets } = secretsOverStubbedNode({
      put: { status: 412, body: "Precondition Failed" },
      head: { status: 200, body: "" },
    });

    const put = await secrets.put("API_KEY", "value", { ifAbsent: true });
    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error).toMatchObject({ code: "ALREADY_EXISTS", service: "vault", meta: { status: 412 } });
    expect(classifyPutFailure(put.error)).toBe("error");
  });
});
