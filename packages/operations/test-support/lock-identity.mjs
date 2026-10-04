// Simulate records from a prior incarnation of this PID or a live peer in a
// different namespace. Docker's default hostname stays fixed across a
// restart and differs between containers. No PID namespace privileges needed.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

os.hostname = () => "abcdef012345";
syncBuiltinESMExports();
const { profileLockMetadataPath, profileLockPath, profileTurnLockPath, withProfileLock } =
  await import("@tinycloud/operations/state");
const [mode, profile, output] = process.argv.slice(2);
if (!mode || !profile || !output) throw new Error("Expected mode, profile and output path.");
const options = { timeoutMs: 350, retryMs: 5, staleAfterMs: 1 };
const lockPath = profileLockPath(profile);
const turnPath = profileTurnLockPath(profile);
const ownerPath = profileLockMetadataPath(profile);
const readOwner = async (path) => JSON.parse(await readFile(path, "utf8"));
const turnOwnerPath = async () => {
  const slot = Math.max(...(await readdir(turnPath)).filter((name) => /^\d+$/.test(name)).map(Number));
  return join(turnPath, String(slot), "owner.json");
};
const foreignRecord = (record, sameHostname) => ({
  ...record,
  instanceId: "00000000-0000-4000-8000-000000000001",
  hostname: sameHostname ? "abcdef012345" : "fedcba987654",
  pidNamespace: `pid:[${BigInt(record.pidNamespace?.match(/\d+/)?.[0] ?? "0") + 1n}]`,
  processStartTime: String(BigInt(record.processStartTime ?? "100") - 1n),
  createdAt: new Date(Date.now() - 60_000).toISOString(),
});
const legacyRecord = (record) => {
  const { instanceId, hostname, bootId, pidNamespace, processStartTime, ...legacy } = record;
  return { ...legacy, createdAt: new Date(Date.now() - 60_000).toISOString() };
};

if (mode === "foreign" || mode === "foreign-lock") {
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const holding = withProfileLock(profile, async () => {
    entered();
    await finished;
  });
  await inside;
  try {
    const turnOwner = await turnOwnerPath();
    const turn = await readOwner(turnOwner);
    const lock = await readOwner(ownerPath);
    if (mode === "foreign") {
      await writeFile(turnOwner, JSON.stringify(foreignRecord(turn, false)));
    } else {
      // Model a legacy writer: it holds .lock without holding our turn.
      await writeFile(join(dirname(turnOwner), `${turn.token}.done`), "");
    }
    await writeFile(ownerPath, JSON.stringify(foreignRecord(lock, false)));
    const outcome = await withProfileLock(profile, async () => "entered", options)
      .catch((error) => error.code ?? String(error));
    await writeFile(output, JSON.stringify({ outcome }));
  } finally {
    finish();
    await holding;
  }
} else {
  let ownOwner;
  await withProfileLock(profile, async () => { ownOwner = await readOwner(ownerPath); });
  const turnOwner = await turnOwnerPath();
  const turn = await readOwner(turnOwner);
  const legacy = mode.startsWith("legacy");
  const abandoned = legacy ? legacyRecord : (record) => ({
    ...foreignRecord(record, true),
    ...(mode === "reuse-in-namespace" ? { pidNamespace: record.pidNamespace } : {}),
    ...(mode === "wrong-boot" ? { bootId: "00000000-0000-0000-0000-000000000000" } : {}),
  });
  if (mode !== "restart-lock" && mode !== "legacy-lock") {
    await writeFile(turnOwner, JSON.stringify(abandoned(turn)));
    await rm(join(dirname(turnOwner), `${turn.token}.done`));
  }
  if (mode !== "restart-turn" && mode !== "legacy-turn") {
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify(abandoned(ownOwner)));
  }
  const outcome = await withProfileLock(profile, async () => "entered", options)
    .catch((error) => error.code ?? String(error));
  await writeFile(output, JSON.stringify({ outcome, recordedFields: {
    instanceId: ownOwner.instanceId,
    hostname: ownOwner.hostname,
    bootId: ownOwner.bootId,
    pidNamespace: ownOwner.pidNamespace,
    processStartTime: ownOwner.processStartTime,
  } }));
}
