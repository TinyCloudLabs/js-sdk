import { afterEach, expect, test } from "bun:test";
import { discardWarnings, drainWarnings, mergeWarnings, recordWarnings } from "./warnings.js";

const skipped = (reason: string, grantCid?: string) => ({ code: "STORED_GRANT_SKIPPED", reason, ...(grantCid ? { grantCid } : {}) });

afterEach(() => { drainWarnings(); });

test("merges batches by maximum multiplicity without duplicating replay warnings", () => {
  const a = skipped("cid_mismatch");
  const b = skipped("proof_missing", "bafkr4i" + "a".repeat(52));
  expect(mergeWarnings([a, a, b], [a, b, b])).toEqual([a, a, b, b]);
  recordWarnings([a, a, b]);
  recordWarnings([a, b, b]);
  expect(drainWarnings()).toEqual([a, a, b, b]);
  expect(drainWarnings()).toEqual([]);
});

test("discardWarnings removes every warning for the removed CID", () => {
  const cid = "bafkr4i" + "a".repeat(52);
  const other = skipped("cid_mismatch");
  recordWarnings([skipped("proof_missing", cid), other, skipped("unbound", cid)]);
  discardWarnings(cid);
  expect(drainWarnings()).toEqual([other]);
});
