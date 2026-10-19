// The intermediate parent of parent-watch.test.ts: starts the command it is
// given, prints that child's PID and lives until the child exits. The test
// SIGKILLs it to orphan the child. The child's stderr is this process's own,
// and its stdin a pipe only this process writes, so it ends with this process.
import { PROFILE_LOCK_HELPER_DEADLINE_MS } from "../src/test-support/profile-lock-protocol.js";
import { exitWithParent } from "../src/test-support/parent-watch.mjs";

exitWithParent(PROFILE_LOCK_HELPER_DEADLINE_MS);

const command = process.argv.slice(2);
if (command.length === 0) throw new Error("Expected a command to start.");

const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
process.stdout.write(`${child.pid}\n`);
process.exit(await child.exited);
