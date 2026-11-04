import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { assertPrivateTestEnvironment } from "./private-home.mjs";

// Every child starts with real, private HOME+TC_HOME. Negative cases only pass
// synthetic strings to the pure guard; they never change the process environment.
assertPrivateTestEnvironment();
const [mode, marker] = process.argv.slice(2);
if (!mode || !marker) throw new Error("Expected a private guard case and marker");
const realHome = execFileSync(process.env.NODE_BINARY ?? "node", ["-p", "require('node:os').userInfo().homedir"], {
  encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
}).trim();
const synthetic: Record<string, string | undefined> = { HOME: process.env.HOME, TC_HOME: process.env.TC_HOME };
if (mode === "missing-home") delete synthetic.HOME;
else if (mode === "missing-tc-home") delete synthetic.TC_HOME;
else if (mode === "real-home") synthetic.HOME = realHome;
else if (mode === "real-tc-home") synthetic.TC_HOME = realHome;
else if (mode === "both-real") synthetic.HOME = synthetic.TC_HOME = realHome;
else if (mode === "profile-root") synthetic.TC_HOME = join(realHome, ".tinycloud", "profiles", "synthetic-do-not-touch");
else if (mode !== "private") throw new Error("Unknown guard case");
try {
  assertPrivateTestEnvironment(synthetic);
} catch {
  process.stdout.write(JSON.stringify({ status: "refused" }) + "\n");
  process.exit(0);
}
// This marker is always in the caller's private temporary home. In a negative
// regression it detects crossing the I/O boundary without touching shared state.
await Bun.write(marker, "admitted\n");
if (mode !== "private") {
  process.stdout.write(JSON.stringify({ status: "admitted" }) + "\n");
  process.exit(0);
}
// Profile-writing code is imported only after the guard succeeds.
const { createAuthRuntimeFixture } = await import("./auth-runtime.js");
const fixture = await createAuthRuntimeFixture();
try {
  const profiles = join(process.env.TC_HOME!, ".tinycloud", "profiles");
  const paths = ["owner", "delegate"].flatMap((name) => ["profile.json", "session.json"].map((file) => join(profiles, name, file)));
  const present = await Promise.all(paths.map((path) => Bun.file(path).exists()));
  process.stdout.write(JSON.stringify({ status: "admitted", profileFilesPresent: present.every(Boolean) }) + "\n");
} finally { fixture.hermetic.stop(); }
