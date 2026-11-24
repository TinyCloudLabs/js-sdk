import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const { version: installed, bin } = JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf-8")) as {
  version: string;
  bin: Record<string, string>;
};

// A resolver that never answers, like a DNS server that times out: the pending lookup keeps the event loop alive
// for 60 s, after the registry request's own 3 s abort.
const STALLED_DNS = `import dns from "node:dns";
dns.lookup = () => { setTimeout(() => {}, 60_000); };
`;

test("an update check stuck in DNS does not hold a finished command open", () => {
  const home = mkdtempSync(join(tmpdir(), "tc-update-deadline-"));
  const preload = join(home, "stalled-dns.mjs");
  writeFileSync(preload, STALLED_DNS);
  const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
  const run = (args: string[]) => {
    const started = Date.now();
    const result = spawnSync("node", [resolve(PACKAGE_DIR, bin.tinycloud), ...args], {
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...ambient,
        CI: "",
        TC_NO_AUTO_UPDATE: "",
        HOME: home,
        TC_HOME: join(home, "state"),
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      },
    });
    return { ...result, elapsed: Date.now() - started };
  };
  try {
    const succeeded = run(["--version"]);
    expect(succeeded.status).toBe(0);
    expect(succeeded.stdout).toContain(installed);
    expect(succeeded.elapsed).toBeLessThan(15_000);

    const failed = run(["no-such-command"]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("unknown command 'no-such-command'");
    expect(failed.elapsed).toBeLessThan(15_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);
