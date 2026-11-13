// Test-only preload: reject unsafe environments before profile modules load.
import { assertPrivateTestEnvironment } from "./private-home.mjs";
import { armProductionOriginGuard, nodeOptionsWithGuard } from "./production-origin-guard.mjs";
assertPrivateTestEnvironment();
// No test may reach the production links API (a missing fetch stub or origin fails fast); see production-origin-guard.mjs.
armProductionOriginGuard();
// Node children that copy process.env (the courier CLI under test) load the same guard.
process.env.NODE_OPTIONS = nodeOptionsWithGuard(process.env.NODE_OPTIONS);
