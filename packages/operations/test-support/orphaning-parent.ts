// The intermediate parent of parent-watch.test.ts: starts the command it is
// given, prints that child's PID and lives until the child exits. The test
// SIGKILLs it to orphan the child. Helper stderr goes to this process's own.
import { exitWithParent } from "../src/test-support/parent-watch.js";

exitWithParent();

const command = process.argv.slice(2);
if (command.length === 0) throw new Error("Expected a command to start.");

const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
process.stdout.write(`${child.pid}\n`);
process.exit(await child.exited);
