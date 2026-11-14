// Loaded with `node --import` (see nodeOptionsWithGuard): arms the production links fetch refusal in a spawned Node
// process. Fetch only: the explicit-production-origin refusal stays in the test process (see production-origin-guard.mjs).
import { armProductionFetchGuard } from "./production-origin-guard.mjs";
armProductionFetchGuard();
