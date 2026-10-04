// Preloaded with `node -r`: every hard link fails the way it does on a
// filesystem without hard links (Linux FAT/exFAT report EPERM). Node's
// syncBuiltinESMExports() makes ES-module imports of node:fs see the change.
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const failure = (existing) => Object.assign(
  new Error(`EPERM: operation not permitted, link '${existing}'`),
  { code: "EPERM", errno: -1, syscall: "link" },
);
fsp.link = async (existing) => {
  throw failure(existing);
};
fs.link = (existing, _path, callback) => process.nextTick(callback, failure(existing));
fs.linkSync = (existing) => {
  throw failure(existing);
};
require("node:module").syncBuiltinESMExports();
