import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureShareCommandServices } from "./share.js";
import { runShareCaptured } from "./share.integration-harness.js";

const token = "outer-process-resume-token-must-never-appear";
configureShareCommandServices({
  targetAdapter: { publish: async () => ({ state: "authorization-required", method: "openkey-device", resumeToken: token, continueUrl: "https://authority.example/continue" }) },
});

const root = await mkdtemp(join(tmpdir(), "tc-share-outer-process-"));
const input = join(root, "input.md");
try {
  await writeFile(input, "outer process regression\n", "utf8");
  const result = await runShareCaptured(["share", "publish", input, "--to", "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav", "--json"]);
  if (result.exitCode !== 6 || result.stdout.includes(token) || result.stderr.includes(token)) {
    throw new Error("outer share command secrecy or exit-code regression failed");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
