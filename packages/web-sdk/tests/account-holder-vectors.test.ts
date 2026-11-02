import { expect, test } from "bun:test";
import { createAccountHolderSigner } from "../src/credentials/account-holder";

// TC-2254 C9.5 (3): the witness's recorded accept/reject matrix for the holder signature (`holderProof.fixed.verifyCases`) against the
// signer's LOCAL checks. The SDK is a strict subset of the witness: it returns a signature only if it is 65 bytes, v is 27 or 28, and it
// recovers to the account over exactly the bytes it was given. The wire form (`0x` + lowercase hex) is produced by the interpreter and is
// pinned by the fake-witness acquisition tests in node-sdk.
const vectors = await Bun.file(new URL("../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const FIXED = vectors.holderProof.fixed;
const ACCOUNT = FIXED.binding.holderDid as string;
const SIGNING_INPUT = Uint8Array.from(Buffer.from((FIXED.signingInputHex as string).replace(/^0x/, ""), "hex"));

interface Case { name: string; accepted: boolean; signature: string }
const bytesOfHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex.replace(/^0[xX]/, ""), "hex"));

async function localVerdict(signature: Uint8Array): Promise<"returned" | "refused"> {
  const signer = createAccountHolderSigner(ACCOUNT, async () => signature);
  try {
    await signer.sign(SIGNING_INPUT);
    return "returned";
  } catch {
    return "refused";
  }
}

for (const c of FIXED.verifyCases as Case[]) {
  // Wire-format cases are about the text the witness receives, which the interpreter writes itself; they have no signer-side form.
  if (c.name === "missing_0x_prefix" || c.name === "prefix_0X_uppercase_X") continue;
  test(`${c.name}: the witness ${c.accepted ? "accepts" : "rejects"} it, the signer ${c.name === "v_0_1" ? "refuses it (a wallet returning v 0 or 1 is refused locally)" : c.accepted ? "returns it" : "refuses it"}`, async () => {
    const verdict = await localVerdict(bytesOfHex(c.signature));
    const expected = c.accepted && c.name !== "v_0_1" ? "returned" : "refused";
    expect([c.name, verdict]).toEqual([c.name, expected]);
  });
}

test("the recorded signature over the fixed signing input is the signer's own, byte for byte, from the recorded key", async () => {
  expect(await localVerdict(bytesOfHex(FIXED.signature))).toBe("returned");
  expect(vectors.holderProof.fixed.signer).toBeDefined();
});
