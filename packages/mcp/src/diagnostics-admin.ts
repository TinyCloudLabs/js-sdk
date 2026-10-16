import { isAbsolute } from "node:path";

import {
  DiagnosticStore,
  exportDiagnosticBundle,
  readDiagnosticJsonFile,
  resolveDiagnosticTenant,
  validateDiagnosticSelection,
} from "@tinycloud/operations/diagnostics";

const ACTIONS: Readonly<Record<string, true>> = { status: true, enable: true, pause: true, resume: true, disable: true, history: true, export: true, delete: true };
const FLAGS: Readonly<Record<string, true>> = { "--service": true, "--owner-request": true, "--external": true, "--pause-after": true, "--keep-enabled": true };
const VALUES: Readonly<Record<string, true>> = { "--root": true, "--tenant": true, "--selection": true, "--out": true, "--expires": true };

/** OS/operator authority only. Invoked before OAuth discovery, profiles or listening. */
export async function diagnosticsAdmin(arguments_: readonly string[]): Promise<unknown> {
  const [action, ...args] = arguments_;
  if (action === undefined || !Object.hasOwn(ACTIONS, action)) throw new Error("Invalid diagnostic action.");
  const options: Record<string, string | true> = Object.create(null);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (Object.hasOwn(options, name)) throw new Error("Duplicate diagnostic option.");
    if (Object.hasOwn(FLAGS, name)) options[name] = true;
    else if (Object.hasOwn(VALUES, name)) {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error("Missing diagnostic option.");
      options[name] = value;
    } else throw new Error("Invalid diagnostic option.");
  }
  const root = options["--root"];
  const tenant = options["--tenant"];
  const service = options["--service"] === true;
  if (typeof root !== "string" || !isAbsolute(root) || service === (tenant !== undefined)) throw new Error("Explicit diagnostic root and partition are required.");
  if (!service && (typeof tenant !== "string" || !/^[a-f0-9]{64}$/.test(tenant) || options["--owner-request"] !== true)) {
    throw new Error("A verified tenant mapping and owner request are required.");
  }
  const partition = await resolveDiagnosticTenant(root, service ? "service" : tenant as string, { create: service && action === "enable" });
  if (partition === undefined) throw new Error("Diagnostic partition is unavailable.");
  const store = new DiagnosticStore(root, partition);
  if (action === "status") return store.inspect();
  if (action === "enable" || action === "pause" || action === "resume" || action === "disable") {
    return store.control(action, action === "enable" ? { scope: "tc-apps" } : undefined);
  }
  const selectionPath = options["--selection"];
  if (typeof selectionPath !== "string") throw new Error("An explicit diagnostic selection is required.");
  const selection = validateDiagnosticSelection(await readDiagnosticJsonFile(selectionPath));
  if (selection === undefined) throw new Error("Invalid diagnostic selection.");
  if (action === "history") return store.snapshot(selection);
  if (action === "delete") {
    if ((options["--pause-after"] === true) === (options["--keep-enabled"] === true)) {
      throw new Error("An explicit post-deletion capture decision is required.");
    }
    return store.delete(selection, { pause_after: options["--pause-after"] === true });
  }
  const out = options["--out"];
  const expires = options["--expires"];
  if (typeof out !== "string" || typeof expires !== "string") throw new Error("Export destination and expiry are required.");
  return exportDiagnosticBundle(store, { selection, out, expires_at: expires, external: options["--external"] === true });
}
