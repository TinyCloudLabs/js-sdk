// Simulated same-PID records exercise the built Node ESM without namespace privileges.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { profileLockMetadataPath, profileLockPath, profileTurnLockPath, withProfileLock } from "@tinycloud/operations/state";
import { exitWithParent } from "../src/test-support/parent-watch.mjs";

exitWithParent();
// Listener processes still running: killed whenever this fixture exits, the
// parent watch's exit included (a SIGKILL of this fixture skips this).
const listeners = new Set();
process.on("exit", () => {
  for (const listening of listeners) listening.kill("SIGKILL");
});

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
const foreign = (record, liveness) => ({
  ...record,
  instanceId: "00000000-0000-4000-8000-000000000001",
  pidNamespace: `pid:[${BigInt(record.pidNamespace.match(/\d+/)[0]) + 1n}]`,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  ...(liveness ? { liveness } : { liveness: undefined }),
});
const legacy = (record) => {
  const { instanceId, bootId, pidNamespace, processStartTime, liveness, ...rest } = record;
  return { ...rest, createdAt: new Date(Date.now() - 60_000).toISOString() };
};
// Liveness socket names carry their turn directory's dev and ino (hex); an
// offset names a different directory.
const socketName = async (inoOffset = 0n) => {
  const { dev, ino } = await stat(turnPath, { bigint: true });
  return `.live-${dev.toString(16)}-${(ino + inoOffset).toString(16)}-${crypto.randomUUID()}`;
};
const killed = async (socket) => {
  socket.child.kill("SIGKILL");
  await once(socket.child, "exit");
};
const listener = async (name) => {
  const path = join(turnPath, name);
  // Bound relative to the turn directory: the full path can exceed sun_path.
  const child = spawn(process.execPath, ["-e", `require('node:net').createServer(c => c.destroy()).listen(${JSON.stringify(name)}, () => console.log('ready'))`], { cwd: turnPath, stdio: ["ignore", "pipe", "pipe"] });
  listeners.add(child);
  child.once("exit", () => listeners.delete(child));
  try {
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Listener exited before ready"); })]);
    const stats = await lstat(path, { bigint: true });
    return { child, path, record: { socket: name, dev: String(stats.dev), ino: String(stats.ino) } };
  } catch (error) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
    throw error;
  }
};
const outcome = () => withProfileLock(profile, async () => "entered", options).catch((error) => error.code ?? String(error));
let result;
let child;
try {
  if (mode === "foreign-live" || mode === "foreign-live-lock") {
    let entered, finish;
    const inside = new Promise((resolve) => { entered = resolve; });
    const finished = new Promise((resolve) => { finish = resolve; });
    const holding = withProfileLock(profile, async () => { entered(); await finished; });
    await inside;
    try {
      const turnPathOwner = await turnOwnerPath();
      const turn = await readOwner(turnPathOwner);
      const lock = await readOwner(ownerPath);
      if (mode === "foreign-live") await writeFile(turnPathOwner, JSON.stringify(foreign(turn, turn.liveness)));
      else await writeFile(join(dirname(turnPathOwner), `${turn.token}.done`), "");
      await writeFile(ownerPath, JSON.stringify(foreign(lock, lock.liveness)));
      result = { outcome: await outcome() };
    } finally {
      finish();
      await holding;
    }
  } else if (mode === "orphans") {
    await withProfileLock(profile, async () => undefined);
    const deadName = await socketName();
    await killed(await listener(deadName));
    const deadNew = `${await socketName()}.new`;
    await killed(await listener(deadNew));
    const live = await listener(await socketName());
    child = live.child;
    const entered = await outcome();
    const names = await readdir(turnPath);
    result = { outcome: entered, deadRemoved: !names.includes(deadName) && !names.includes(deadNew), liveKept: names.includes(live.record.socket) };
  } else {
    let ownLock;
    await withProfileLock(profile, async () => { ownLock = await readOwner(ownerPath); });
    const turnPathOwner = await turnOwnerPath();
    const turn = await readOwner(turnPathOwner);
    let liveness;
    if (["restart-refused", "restart-refused-turn", "restart-refused-lock", "foreign-other-inode", "wrong-boot", "stage", "foreign-paused"].includes(mode)) {
      const socket = await listener(await socketName());
      child = socket.child;
      liveness = socket.record;
      if (mode === "foreign-paused") child.kill("SIGSTOP");
      else {
        await killed(socket);
        child = undefined;
      }
    } else if (mode === "restart-gone") {
      liveness = { socket: await socketName(), dev: "1", ino: "1" };
    } else if (mode === "foreign-other-directory") {
      // Bound in another directory: a separate turn lock sharing profiles/,
      // or this one before it was removed and recreated.
      liveness = { socket: await socketName(1n), dev: "1", ino: "1" };
    } else if (mode === "foreign-not-socket") {
      const socket = await socketName();
      await writeFile(join(turnPath, socket), "not a socket");
      const stats = await lstat(join(turnPath, socket), { bigint: true });
      liveness = { socket, dev: String(stats.dev), ino: String(stats.ino) };
    }
    const abandoned = (record) => mode.startsWith("legacy") ? legacy(record) : {
      ...foreign(record, liveness),
      ...(mode === "reuse-in-namespace" || mode === "same-start" ? {
        pidNamespace: record.pidNamespace,
        processStartTime: mode === "same-start" ? record.processStartTime : String(BigInt(record.processStartTime) - 1n),
      } : {}),
      ...(mode === "wrong-boot" ? { bootId: "00000000-0000-0000-0000-000000000000" } : {}),
      ...(mode === "foreign-other-inode" ? { liveness: { ...liveness, ino: String(BigInt(liveness.ino) + 1n) } } : {}),
    };
    if (mode === "stage") {
      const dead = join(turnPath, `.stage-${process.pid}-dead`);
      const live = join(turnPath, `.stage-${process.pid}-live`);
      const invalid = join(turnPath, `.stage-${process.pid}-invalid`);
      const liveSocket = await listener(await socketName());
      try {
        for (const path of [dead, live, invalid]) await mkdir(path);
        await writeFile(join(dead, "owner.json"), JSON.stringify(abandoned(turn)));
        await writeFile(join(live, "owner.json"), JSON.stringify(foreign(turn, liveSocket.record)));
        await writeFile(join(invalid, "owner.json"), "not json");
        const entered = await outcome();
        const names = await readdir(turnPath);
        result = { outcome: entered, deadRemoved: !names.includes('.stage-' + process.pid + '-dead') && !names.includes(liveness.socket), liveKept: names.includes(`.stage-${process.pid}-live`) && names.includes(liveSocket.record.socket), invalidKept: names.includes(`.stage-${process.pid}-invalid`) };
      } finally {
        liveSocket.child.kill("SIGKILL");
        await once(liveSocket.child, "exit").catch(() => undefined);
      }
    } else {
      if (mode !== "restart-refused-lock" && mode !== "legacy-lock") {
        await writeFile(turnPathOwner, JSON.stringify(abandoned(turn)));
        await rm(join(dirname(turnPathOwner), `${turn.token}.done`));
      }
      if (mode === "restart-refused-lock") {
        // A completed predecessor turn also carries the dead acquisition's socket.
        await writeFile(turnPathOwner, JSON.stringify(abandoned(turn)));
      }
      if (mode !== "restart-refused-turn" && mode !== "legacy-turn") {
        await mkdir(lockPath);
        await writeFile(ownerPath, JSON.stringify(abandoned(ownLock)));
      }
      result = { outcome: await outcome(), socketGone: liveness ? !(await readdir(turnPath)).includes(liveness.socket) : undefined };
    }
  }
} finally {
  if (child) {
    child.kill("SIGCONT");
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
}
await writeFile(output, JSON.stringify(result));
