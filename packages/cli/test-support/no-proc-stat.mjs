// Preload (`node --import`): this process reads /proc/self/stat as if /proc
// were missing (macOS, BSD), so `tc secrets run` takes its `ps` path. The
// first blocked read prints one stderr line, so a test can see it ran.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const readFileSync = fs.readFileSync;
let reported = false;
fs.readFileSync = function (path, ...rest) {
  if (path === "/proc/self/stat") {
    if (!reported) {
      reported = true;
      process.stderr.write("no-proc-stat: blocked /proc/self/stat\n");
    }
    throw Object.assign(new Error("ENOENT: no such file or directory, open '/proc/self/stat'"), { code: "ENOENT" });
  }
  return readFileSync.call(this, path, ...rest);
};
syncBuiltinESMExports();
