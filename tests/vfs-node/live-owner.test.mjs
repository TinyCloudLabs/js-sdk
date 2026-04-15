import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTinyCloudVfsFromNode } from "@tinycloud/vfs";
import {
  OWNER_PRIVATE_KEY,
  checkServerHealth,
  cleanupKeys,
  createClient,
  createMountPath,
  createRunId,
} from "./setup.mjs";

const runId = createRunId();
const mountPath = createMountPath(runId, "owner");
const fileKey = "notes/welcome.txt";
const renamedKey = "notes/renamed.txt";

test("owner mount supports read, write, stat, list, rename, unlink, and rmdir", async (t) => {
  await checkServerHealth();

  const owner = createClient(`owner-${runId}`, OWNER_PRIVATE_KEY);
  await owner.signIn();

  const { provider, vfs } = createTinyCloudVfsFromNode(owner);
  vfs.mount(mountPath);
  t.after(() => {
    try {
      vfs.unmount();
    } catch {
      // ignore
    }
    try {
      provider.close();
    } catch {
      // ignore
    }
  });

  fs.mkdirSync(`${mountPath}/notes`, { recursive: true });
  fs.writeFileSync(`${mountPath}/notes/welcome.txt`, "hello from owner");
  assert.equal(fs.existsSync(`${mountPath}/notes/welcome.txt`), true);

  assert.equal(fs.readFileSync(`${mountPath}/notes/welcome.txt`, "utf8"), "hello from owner");

  const stat = fs.statSync(`${mountPath}/notes/welcome.txt`);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.size, "hello from owner".length);

  const entries = fs.readdirSync(`${mountPath}/notes`, { withFileTypes: true });
  assert.deepEqual(
    entries.map((entry) => ({ name: entry.name, file: entry.isFile(), dir: entry.isDirectory() })),
    [{ name: "welcome.txt", file: true, dir: false }],
  );

  fs.renameSync(`${mountPath}/notes/welcome.txt`, `${mountPath}/notes/renamed.txt`);
  assert.equal(fs.existsSync(`${mountPath}/notes/welcome.txt`), false);
  assert.equal(fs.readFileSync(`${mountPath}/notes/renamed.txt`, "utf8"), "hello from owner");

  fs.unlinkSync(`${mountPath}/notes/renamed.txt`);
  assert.equal(fs.existsSync(`${mountPath}/notes/renamed.txt`), false);

  fs.rmdirSync(`${mountPath}/notes`);
  assert.equal(fs.existsSync(`${mountPath}/notes`), false);

  await cleanupKeys(owner, [fileKey, renamedKey]);
});
