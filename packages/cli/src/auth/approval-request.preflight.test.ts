import { afterAll, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";

// TC-3278: a sign-in approval makes a link at the links API (a per-address daily quota) and then writes the
// pending entry into the profile folder. When that folder cannot be written the command stops first, so no
// link is made and spent.
const home = mkdtempSync("/var/tmp/TC3278-approval-preflight-");
const original = { HOME: process.env.HOME, TC_HOME: process.env.TC_HOME, TC_LINKS_API_ORIGIN: process.env.TC_LINKS_API_ORIGIN };
Object.assign(process.env, { HOME: home, TC_HOME: home });
const { ProfileManager } = await import("../config/profiles.js");
const { acquireApprovalRequest } = await import("./approval-request.js");
const { CLIError } = await import("../output/errors.js");

let linkRequests = 0;
const links = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { linkRequests += 1; return new Response("{}", { status: 500 }); } });
process.env.TC_LINKS_API_ORIGIN = `http://127.0.0.1:${links.port}`;

afterAll(async () => {
  links.stop(true);
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(home, { recursive: true, force: true });
});

test("an unwritable profile folder stops the approval before any link request is made", async () => {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as Ed25519PrivateJwk;
  const refused = new CLIError("STATE_FOLDER_NOT_WRITABLE", "TinyCloud can't write its folder", 1);
  const spy = spyOn(ProfileManager, "ensureProfileDir").mockRejectedValue(refused);
  try {
    await expect(acquireApprovalRequest(signerFromJwk(jwk).did, {
      profileName: "preflight-3278",
      jwk,
      host: "https://node.example",
      permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }],
    })).rejects.toBe(refused);
    expect(spy).toHaveBeenCalledWith("preflight-3278");
    expect(linkRequests).toBe(0);
  } finally {
    spy.mockRestore();
  }
});
