import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTinyCloudVfsFromNode } from "@tinycloud/vfs";
import {
  SERVER_URL,
  checkServerHealth,
  cleanupKeys,
  createClient,
  createMountPath,
  createRunId,
  freshPrivateKey,
} from "./setup.mjs";

// Caps the space through the node's admin API, so it needs that node's
// TINYCLOUD_ADMIN_SECRET; a shared node must never be capped from a test.
const ADMIN_SECRET = process.env.TC_TEST_ADMIN_SECRET;

const runId = createRunId();
const mountPath = createMountPath(runId, "full");

async function setSpaceLimit(spaceId, limitBytes) {
  const url = `${SERVER_URL}/admin/quota/${encodeURIComponent(spaceId)}`;
  const headers = { authorization: `Bearer ${ADMIN_SECRET}` };
  const response = limitBytes === undefined
    ? await fetch(url, { method: "DELETE", headers })
    : await fetch(url, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ limit_bytes: limitBytes }) });
  assert.equal(response.ok, true, `admin quota request failed: ${response.status}`);
}

test("a full space refuses VFS writes with ENOSPC and keeps reads and deletes working", { skip: ADMIN_SECRET ? false : "set TC_TEST_ADMIN_SECRET to the local node's admin secret" }, async (t) => {
  await checkServerHealth();

  const owner = createClient(`full-${runId}`, freshPrivateKey());
  await owner.signIn();
  const spaceId = owner.spaceId;

  const { provider, vfs } = createTinyCloudVfsFromNode(owner);
  vfs.mount(mountPath);
  t.after(async () => {
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
    await setSpaceLimit(spaceId, undefined);
    await cleanupKeys(owner, ["kept.txt", "refused.txt"]);
  });

  fs.writeFileSync(`${mountPath}/kept.txt`, "written before the cap");
  await setSpaceLimit(spaceId, 1);

  assert.throws(
    () => fs.writeFileSync(`${mountPath}/refused.txt`, "written after the cap"),
    (error) => error.code === "ENOSPC" && error.errno === -28,
  );
  assert.equal(fs.readFileSync(`${mountPath}/kept.txt`, "utf8"), "written before the cap");
  fs.unlinkSync(`${mountPath}/kept.txt`);
  assert.equal(fs.existsSync(`${mountPath}/kept.txt`), false);
});
