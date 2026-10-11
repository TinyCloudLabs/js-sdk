import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const shell = `
set -euo pipefail
verify() {
  if [[ "\${VERIFY_FAIL}" == 1 ]]; then return 3; fi
  printf '%s' "\${VERSION}"
}
smoke() { printf '%s\\n' "$1" >> "\${SMOKE_LOG}"; }
ver=$(verify) || exit 1
node -e 'const v=process.argv[1]; const m=/^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$/.exec(v); const p=m?.[4]?.split(".")??[]; if(!m||p.some(x=>/^\\d+$/.test(x)&&x.length>1&&x[0]==="0"))process.exit(1)' "$ver" || { printf 'verify-aggregate returned a non-exact SemVer: %s\\n' "$ver" >&2; exit 1; }
smoke "$ver"
`;

async function run(verifyFail: boolean, version: string): Promise<{ status: number | null; smokeOutput: string }> {
  const dir = await mkdtemp(join(tmpdir(), "tc893-runbook-"));
  try {
    const smokeLog = join(dir, "smoke.log");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", shell], { encoding: "utf8", env: { ...process.env, VERIFY_FAIL: verifyFail ? "1" : "0", VERSION: version, SMOKE_LOG: smokeLog } });
    let smokeOutput = "";
    try { smokeOutput = await readFile(smokeLog, "utf8"); } catch { /* smoke was correctly not invoked */ }
    return { status: result.status, smokeOutput };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("D1 fail-fast runbook shell", () => {
  test("failed verification never invokes production smoke", async () => {
    const result = await run(true, "1.2.3");
    expect(result.status).not.toBe(0);
    expect(result.smokeOutput).toBe("");
  });

  test.each(["", "beta", "v1.2.3", "1.2", "1.2.3-01", "1.2.3 || true"])("rejects non-exact version %j before smoke", async (version) => {
    const result = await run(false, version);
    expect(result.status).not.toBe(0);
    expect(result.smokeOutput).toBe("");
  });

  test("invokes smoke with an exact semver only after verification succeeds", async () => {
    const result = await run(false, "1.2.3-beta.4+build.6");
    expect(result.status).toBe(0);
    expect(result.smokeOutput).toBe("1.2.3-beta.4+build.6\n");
  });
});
