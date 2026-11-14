// Test-only preload: reject unsafe environments before profile modules load.
import { assertPrivateTestEnvironment } from "./private-home.mjs";
import { GUARD_MARKER, armProductionOriginGuard, nodeOptionsWithGuard } from "./production-origin-guard.mjs";
assertPrivateTestEnvironment();
// No test may reach the production links API (a missing fetch stub or origin fails fast); see production-origin-guard.mjs.
armProductionOriginGuard();
// Node children that copy process.env (the courier CLI under test) load the same guard, and Bun children started from the
// repository root pick it up from the root bunfig.toml preload once the marker is inherited.
process.env.NODE_OPTIONS = nodeOptionsWithGuard(process.env.NODE_OPTIONS);
process.env[GUARD_MARKER] = "1";
