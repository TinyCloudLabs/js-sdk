import { afterAll, expect, test } from "bun:test";
import { createPrivateKey, sign } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalDigest, CredentialError, credentialRequirementDigest, sha256Base64Url, type IssuerVerificationKey, type VerifiedCredential } from "@tinycloud/sdk-core";
import { acquireEmailProofWithIssuerKeys, createEd25519HolderSigner, createMemoryEmailProofPendingStore, emailProofRequirement, verifyStoredEmailProof, verifyStoredWithIssuerKeys, type EmailProofResult, type StoredEmailProofInput } from "./email-proof";
import { generateHolderKey, makeWitness } from "./test-support/witness-stub.mjs";
// Courier's source, not its build: the real `StoredCredentialSource.find` and `credential show` are driven with the
// verifier seam below. The seam is source-only: `verifyStoredWithIssuerKeys` is not exported from the package index.
import { parseArgs } from "../../../courier/src/args";
import { cmdCredential } from "../../../courier/src/credential";
import { StoredCredentialSource } from "../../../courier/src/credential-source";

const ADDRESS = "reader@example.com";
const CODE = "12345678";
/** Each test issues and stores a real record (fsync, rename); on a loaded disk that can pass bun's 5 s default. */
const SLOW_IO_TIMEOUT_MS = 60_000;
const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

const holderKey = generateHolderKey();
const privateKey = createPrivateKey({ key: holderKey.jwk, format: "jwk" });
const HOLDER = createEd25519HolderSigner(holderKey.bare, async (bytes) => new Uint8Array(sign(null, bytes, privateKey)));
const AGENT_KEY = { v: 1, jwk: holderKey.jwk, did: holderKey.bare, createdAt: new Date().toISOString() };

type StoredRecord = Record<string, unknown> & { credential: string; ownerDid: string; issuedAt: string; expiresAt: string };

/** A real issuance against the witness stub, stored through Courier's own `store` with the witness keys as the verifier. */
async function issueAndStore(): Promise<{ home: string; file: string; original: StoredRecord; seam: (input: StoredEmailProofInput) => Promise<VerifiedCredential>; result: EmailProofResult }> {
  const witness = makeWitness({ code: CODE });
  const acquisition = await acquireEmailProofWithIssuerKeys(
    { address: ADDRESS, holder: HOLDER, fetch: witness.fetch as typeof globalThis.fetch, pendingStore: createMemoryEmailProofPendingStore(), getCode: async () => CODE },
    witness.issuerKeys,
  );
  if (acquisition.status !== "issued") throw new Error("witness did not issue a credential");
  const keys: readonly IssuerVerificationKey[] = witness.issuerKeys;
  const seam = (input: StoredEmailProofInput) => verifyStoredWithIssuerKeys(input, keys);
  const home = mkdtempSync(join("/var/tmp", "node-sdk-stored-"));
  homes.push(home);
  chmodSync(home, 0o700);
  const requirement = emailProofRequirement(ADDRESS);
  await new StoredCredentialSource(home, seam).store({ result: acquisition.result, requirement, requirementDigest: await credentialRequirementDigest(requirement), holderDid: HOLDER.did, now: new Date() });
  const dir = join(home, "credentials");
  const [name] = readdirSync(dir).filter((f) => f.startsWith("credential-"));
  const file = join(dir, name!);
  return { home, file, original: JSON.parse(readFileSync(file, "utf8")) as StoredRecord, seam, result: acquisition.result };
}

async function show(home: string, seam: (input: StoredEmailProofInput) => unknown, now: Date): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  await cmdCredential(parseArgs(["show", "--email", ADDRESS]), { home, now: () => now, loadKey: () => AGENT_KEY, verifyStored: seam as never, out: (t: string) => { out.push(t); }, err: (t: string) => { err.push(t); } });
  return { stdout: out.join(""), stderr: err.join("") };
}

const swap = (text: string, i: number): string => text.slice(0, i) + (text[i] === "A" ? "B" : "A") + text.slice(i + 1);
async function resealed(r: StoredRecord, credential: string): Promise<StoredRecord> {
  const credentialDigest = await sha256Base64Url(credential);
  return { ...r, credential, credentialDigest, recordId: await canonicalDigest({ credentialDigest, holderDid: r.ownerDid }) };
}

test("positive control: a valid stored record verifies through Courier's find and `credential show` prints the one JSON document", async () => {
  const { home, original, seam } = await issueAndStore();
  const { stdout, stderr } = await show(home, seam, new Date());
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  expect(parsed).toEqual({ ok: true, address: ADDRESS, credentialId: original.credentialId, issuedAt: original.issuedAt, expiresAt: original.expiresAt, status: "none" });
  expect(stderr).toBe("");
  expect(stdout).not.toContain(original.credential.slice(0, 40));
}, SLOW_IO_TIMEOUT_MS);

const tampers: readonly { readonly name: string; readonly mutate: (r: StoredRecord) => StoredRecord | Promise<StoredRecord> }[] = [
  { name: "subjectDid", mutate: (r) => ({ ...r, subjectDid: "did:example:someone-else" }) },
  { name: "descriptor.protocol", mutate: (r) => ({ ...r, descriptor: { ...(r.descriptor as object), protocol: "tinycloud.credentials/other/v1" } }) },
  { name: "profile.id", mutate: (r) => ({ ...r, profile: { ...(r.profile as object), id: "tinycloud.email-domain-proof/v1" } }) },
  { name: "descriptor.format.vct", mutate: (r) => { const d = r.descriptor as { format: object }; return { ...r, descriptor: { ...d, format: { ...d.format, vct: "opencredentials.other/v1" } } }; } },
  { name: "descriptor content (lifecycle edited)", mutate: (r) => { const d = r.descriptor as { lifecycle: object }; return { ...r, descriptor: { ...d, lifecycle: { ...d.lifecycle, tampered: true } } }; } },
  { name: "descriptor removed", mutate: ({ descriptor: _removed, ...rest }) => rest as StoredRecord },
  { name: "subjectDid removed", mutate: ({ subjectDid: _removed, ...rest }) => rest as StoredRecord },
  { name: "expiresAt moved 1 h later", mutate: (r) => ({ ...r, expiresAt: new Date(Date.parse(r.expiresAt) + 3_600_000).toISOString() }) },
  { name: "issuedAt moved 1 s later", mutate: (r) => ({ ...r, issuedAt: new Date(Date.parse(r.issuedAt) + 1_000).toISOString() }) },
  { name: "claims.email", mutate: (r) => ({ ...r, claims: { ...(r.claims as object), email: "attacker@example.com" } }) },
  { name: "SD-JWT header byte", mutate: (r) => ({ ...r, credential: swap(r.credential, 10) }) },
  { name: "SD-JWT payload byte", mutate: (r) => ({ ...r, credential: swap(r.credential, r.credential.indexOf(".") + 8) }) },
  { name: "SD-JWT signature byte", mutate: (r) => ({ ...r, credential: swap(r.credential, r.credential.split("~")[0]!.lastIndexOf(".") + 5) }) },
  { name: "SD-JWT signature byte, credentialDigest and recordId recomputed", mutate: (r) => resealed(r, swap(r.credential, r.credential.split("~")[0]!.lastIndexOf(".") + 5)) },
  { name: "ownerDid", mutate: (r) => ({ ...r, ownerDid: "did:example:someone-else" }) },
  { name: "expiresAt moved to the past", mutate: (r) => ({ ...r, expiresAt: new Date(Date.now() - 3_600_000).toISOString() }) },
  { name: "issuedAt moved 2 h earlier", mutate: (r) => ({ ...r, issuedAt: new Date(Date.parse(r.issuedAt) - 2 * 3_600_000).toISOString() }) },
];

for (const tamper of tampers) {
  test(`a valid record whose ${tamper.name} is tampered is refused credential-record-invalid, kept byte-identical, with empty stdout`, async () => {
    const { home, file, original, seam } = await issueAndStore();
    writeFileSync(file, JSON.stringify(await tamper.mutate(original), null, 2) + "\n");
    const before = readFileSync(file);
    expect(before.equals(Buffer.from(`${JSON.stringify(original, null, 2)}\n`))).toBe(false);
    const out: string[] = [];
    const error: unknown = await cmdCredential(parseArgs(["show", "--email", ADDRESS]), { home, now: () => new Date(), loadKey: () => AGENT_KEY, verifyStored: seam as never, out: (t: string) => { out.push(t); }, err: (t: string) => { out.push(t); } })
      .then(() => undefined, (caught: unknown) => caught);
    expect((error as { code?: string } | undefined)?.code).toBe("credential-record-invalid");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(out.join("")).toBe("");
  }, SLOW_IO_TIMEOUT_MS);
}

test("a valid record inside the 60 s expiry margin is verified, then dropped: show reports it as not found and the file is deleted", async () => {
  const { home, file, original, seam } = await issueAndStore();
  const error: unknown = await show(home, seam, new Date(Date.parse(original.expiresAt) - 30_000)).then(() => undefined, (caught: unknown) => caught);
  expect((error as { code?: string } | undefined)?.code).toBe("credential.show.NOT_FOUND");
  expect(existsSync(file)).toBe(false);
}, SLOW_IO_TIMEOUT_MS);

test("a valid record read after its own exp is verified at its issuance instant, then dropped as expired, not refused as invalid", async () => {
  const { home, file, original, seam } = await issueAndStore();
  const error: unknown = await show(home, seam, new Date(Date.parse(original.expiresAt) + 10_000)).then(() => undefined, (caught: unknown) => caught);
  expect((error as { code?: string } | undefined)?.code).toBe("credential.show.NOT_FOUND");
  expect(existsSync(file)).toBe(false);
}, SLOW_IO_TIMEOUT_MS);

test("the production wrapper verifies against the pinned issuer key: a record signed by another key is refused for its signature, not for a missing key", async () => {
  const { original, result } = await issueAndStore();
  const requirement = emailProofRequirement(ADDRESS);
  const input: StoredEmailProofInput = { record: original as never, requirement, holderDid: HOLDER.did, now: new Date(Date.parse(result.issuedAt)) };
  const error: unknown = await verifyStoredEmailProof(input).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CredentialError);
  expect((error as CredentialError).code).toBe("VERIFICATION_FAILED");
  // The stub issues under the pinned kid, so the pinned key list must resolve it and reject the signature.
  expect((error as CredentialError).message).toBe("Issuer signature is invalid");
}, SLOW_IO_TIMEOUT_MS);
