// Test-only. Advances the built CLI's clock after an atomic additional-grant
// write, exposing expiry that occurs while auth import persists the grant.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

let now = Number(process.env.TC_TEST_NOW_MS);
const advanceTo = Number(process.env.TC_TEST_ADVANCE_TO_MS);
if (!Number.isSafeInteger(now) || !Number.isSafeInteger(advanceTo)) {
  throw new Error("TC_TEST_NOW_MS and TC_TEST_ADVANCE_TO_MS must be integer epoch milliseconds");
}
Date.now = () => now;

const originalRename = fs.promises.rename;
let advanced = false;
fs.promises.rename = async function (source, destination) {
  const result = await originalRename.call(this, source, destination);
  if (!advanced && String(destination).endsWith("/additional-delegations.json")) {
    advanced = true;
    now = advanceTo;
  }
  return result;
};
syncBuiltinESMExports();
