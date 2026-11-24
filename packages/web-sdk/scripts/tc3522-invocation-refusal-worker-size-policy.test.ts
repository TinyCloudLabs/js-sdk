import { expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import { ancestryPins, rootCeilingFor, validateLedger, validateTc3522InvocationRefusalWorkerTransition } from "./replica-size-policy";

const kv = ledger.tc3522InvocationRefusalKvWorker;
const replica = ledger.tc3522InvocationRefusalReplicaWorker;
const prior = ledger.tc3947ReplicaRevokeRoot;
const before = { ...ledger, tc3522InvocationRefusalKvWorker: undefined, tc3522InvocationRefusalReplicaWorker: undefined };
const head = "d2b8696ae792eaddea6fd8662ff451e4d307473e";

test("TC-3522 worker ceilings admit exactly the canonical bytes without moving the root", () => {
  validateLedger(ledger);
  validateTc3522InvocationRefusalWorkerTransition(before, ledger);
  expect(kv.worker).toEqual({ delta: 146, ceiling: 781337 });
  expect(replica.replicaWorker).toEqual({ delta: 156, ceiling: 775076 });
  expect(kv.worker.ceiling - prior.worker.ceiling).toBe(kv.worker.delta);
  expect(replica.replicaWorker.ceiling - prior.replicaWorker.ceiling).toBe(replica.replicaWorker.delta);
  for (const format of ["index.mjs", "index.cjs"] as const) {
    expect(rootCeilingFor(ledger, format)).toEqual(rootCeilingFor(before, format));
  }
  const pins = ancestryPins(ledger, false);
  expect(pins).toContainEqual({ row: "tc3522InvocationRefusalKvWorker", pin: head });
  expect(pins).toContainEqual({ row: "tc3522InvocationRefusalReplicaWorker", pin: head });
});

test("TC-3522 worker admission requires both exact rows and cannot be changed or removed", () => {
  expect(() => validateLedger({ ...ledger, tc3522InvocationRefusalKvWorker: undefined })).toThrow("TC-3522 worker");
  expect(() => validateLedger({ ...ledger, tc3522InvocationRefusalReplicaWorker: undefined })).toThrow("TC-3522 worker");
  expect(() => validateTc3522InvocationRefusalWorkerTransition(ledger, before)).toThrow("TC-3522 worker");
  const changed = structuredClone(ledger);
  changed.tc3522InvocationRefusalKvWorker.worker.ceiling++;
  expect(() => validateTc3522InvocationRefusalWorkerTransition(before, changed)).toThrow("TC-3522 worker");
  expect(() => validateLedger(changed)).toThrow("TC-3522 worker");
});
