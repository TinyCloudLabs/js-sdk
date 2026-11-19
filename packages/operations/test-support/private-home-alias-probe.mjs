import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The parent supplies an owned temporary HOME+TC_HOME before this Node starts.
// Creating a symlink records its target string; it never opens the target.
const home = process.env.TC_HOME;
if (!home || home !== process.env.HOME) throw new Error("Expected matching private probe homes");
const mode = process.argv[2];
const systemHome = resolve(userInfo().homedir);
const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const alias = join(home, "home-alias");
const unsafeAliases = [];
let candidate = alias;
const role = mode.startsWith("home-") ? "HOME" : mode.startsWith("root-") ? "root" : "TC_HOME";
const link = (target, path = alias, unsafe = true) => {
  fs.symlinkSync(target, path, "dir");
  if (unsafe) unsafeAliases.push(path);
};
if (["home-direct", "tc-home-direct", "root-direct"].includes(mode)) {
  link(systemHome);
} else if (["home-ancestor", "tc-home-ancestor", "root-ancestor"].includes(mode)) {
  link(dirname(systemHome));
  candidate = join(alias, basename(systemHome));
} else if (mode === "profile-target") {
  link(join(systemHome, ".tinycloud", "profiles", "synthetic-do-not-touch"));
} else if (mode === "relative-chain") {
  const second = join(home, "second-alias");
  link(systemHome, second);
  link(basename(second));
} else if (mode === "parent-component") {
  link(systemHome);
  // Do not use join/resolve here: they would erase the symlink's ".." boundary.
  candidate = `${alias}${sep}..${sep}${basename(systemHome)}`;
} else if (mode === "link-loop") {
  link(basename(alias), alias, false);
} else if (mode === "private-direct") {
  const target = join(home, "private-target");
  fs.mkdirSync(target);
  link(target, alias, false);
} else if (mode === "private-ancestor") {
  // Models an OS temporary-directory alias, with a not-yet-created private tail.
  link(dirname(home), alias, false);
  candidate = join(alias, basename(home), "not-created", "yet");
} else {
  throw new Error("Unknown alias guard probe");
}

// A regression must fail the test WITHOUT reaching any shared target. These
// tripwires run before native filesystem calls; they are not a profile mock.
let forbiddenProbes = 0;
const checkProbe = (value, followsLeaf) => {
  const path = String(value);
  const normalized = resolve(path);
  const sharedHome = normalized === systemHome ||
    (normalized.startsWith(`${systemHome}${sep}`) && !normalized.startsWith(sourceRoot));
  const throughAlias = unsafeAliases.some((unsafe) => path.startsWith(`${unsafe}${sep}`) ||
    (followsLeaf && path === unsafe));
  if (sharedHome || throughAlias) {
    forbiddenProbes++;
    throw new Error("Refused shared-target filesystem probe in isolation test");
  }
};
for (const [name, followsLeaf] of [["lstatSync", false], ["readlinkSync", false], ["statSync", true], ["realpathSync", true]]) {
  const original = fs[name];
  const guarded = (...args) => { checkProbe(args[0], followsLeaf); return original(...args); };
  if (original.native) guarded.native = (...args) => { checkProbe(args[0], followsLeaf); return original.native(...args); };
  fs[name] = guarded;
}
syncBuiltinESMExports();
const { assertPrivateTestEnvironment } = await import("./private-home.mjs");
assertPrivateTestEnvironment();
const synthetic = { HOME: home, TC_HOME: home };
if (role !== "root") synthetic[role] = candidate;
let status;
try {
  assertPrivateTestEnvironment(synthetic, role === "root" ? candidate : undefined);
  status = "admitted";
} catch {
  status = "refused";
}
process.stdout.write(JSON.stringify({ status, forbiddenProbes }) + "\n");
