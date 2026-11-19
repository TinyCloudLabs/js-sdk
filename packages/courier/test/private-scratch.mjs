import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Test identities and broker fixtures always stay below scratch, including on fresh CI runners. */
export function privateScratch(prefix) {
  const scratch = path.join(os.userInfo().homedir, 'scratch');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(scratch, prefix));
}
