import { test } from "bun:test";
import { runPackedDiagnostics } from "./diagnostics.js";

test("installed diagnostics isolate ESM/CJS scopes and acknowledge complete writes across direct and natural exit", async () => {
  await runPackedDiagnostics();
}, 60_000);
