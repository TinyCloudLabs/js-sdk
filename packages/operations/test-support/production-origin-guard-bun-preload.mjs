// Preloaded by the repository's root bunfig.toml into every `bun` started from the repository root. It does nothing
// unless the test bootstrap's marker is in the environment, so ordinary `bun run` use is untouched; under test it arms
// the production links fetch refusal in the Bun child (`bun -e`, `bun script.ts`), which ignores NODE_OPTIONS=--import.
import { GUARD_MARKER, armProductionFetchGuard } from "./production-origin-guard.mjs";
if (process.env[GUARD_MARKER] === "1") armProductionFetchGuard();
