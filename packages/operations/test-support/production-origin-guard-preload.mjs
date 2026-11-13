// Loaded with `node --import` (see nodeOptionsWithGuard): arms the production links guard in a spawned Node process.
import { armProductionOriginGuard } from "./production-origin-guard.mjs";
armProductionOriginGuard();
