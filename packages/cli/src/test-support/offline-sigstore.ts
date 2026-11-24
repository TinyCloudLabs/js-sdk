/**
 * Real npm provenance verified offline, with sigstore's own verifier and a pinned trust root (TC-4276).
 *
 * Sigstore runs in a Node child, the CLI's runtime (`bin/tinycloud` is `#!/usr/bin/env node`): Bun before 1.4 has no
 * default digest for ECDSA, so sigstore's Rekor SET check fails under it and a genuine release would not verify.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BundleVerifier } from "../lib/provenance.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/sigstore/${name}`, import.meta.url), "utf8"));

/** @tinycloud/courier 0.8.2, published by the Release workflow on master, and its registry integrity. */
export const COURIER = { name: "@tinycloud/courier", version: "0.8.2", integrity: "sha512-LU2djD/HkQiNZECfRVUoCkvGqqQILKkwV4yAO4WovFI9iJg3+0H1R7Uiw6CVWllNdLOcMyR9ThcJgHUsM88MZA==" };
/** @tinycloud/courier 0.8.1, published with valid provenance by another js-sdk workflow (courier-stable-stage.yml). */
export const COURIER_STAGE = { name: "@tinycloud/courier", version: "0.8.1", integrity: "sha512-6qrSxzUTCakW/DwcXNwWOF6z+rW8L6nSHaUHiYNH9vdWNXgh5RPWYmddYSy1TFPDW6P5H2VWSFwZSNo8YqhKJA==" };
/** sigstore 4.1.1, published with valid provenance by another project's release workflow. */
export const SIGSTORE = { name: "sigstore", version: "4.1.1", integrity: "sha512-endqECJkfhozrXMK5ngu/UAA0xVcVEFdnHJCElGaExypjW+HK5i6zu3NteLoaX/iFbRUbC3+DjttQs0GARr+5w==" };
/** Their npm provenance bundles, by "name@version". */
export const BUNDLES = new Map<string, unknown>([
  [`${COURIER.name}@${COURIER.version}`, fixture("courier-0.8.2.provenance.json")],
  [`${COURIER_STAGE.name}@${COURIER_STAGE.version}`, fixture("courier-0.8.1.provenance.json")],
  [`${SIGSTORE.name}@${SIGSTORE.version}`, fixture("sigstore-4.1.1.provenance.json")],
]);

/** sigstore's verifier (the modules the pinned `sigstore` uses), with no identity policy and an offline trust root. */
export const offlineVerifier: BundleVerifier = async (bundle) => {
  const helper = fileURLToPath(new URL("./sigstore-verify.cjs", import.meta.url));
  const child = spawnSync(process.env.NODE_BINARY ?? "node", [helper], { input: JSON.stringify(bundle), encoding: "utf8", timeout: 60_000 });
  if (child.status !== 0) throw new Error(`sigstore-verify.cjs exited ${child.status}: ${child.stderr}`);
  const result = JSON.parse(child.stdout) as {
    runtime: string;
    error?: string;
    identity?: { subjectAlternativeName?: string; extensions?: { issuer?: string }; oids: { oid?: { id: number[] }; value: string }[] };
  };
  if (!result.runtime.startsWith("node ")) throw new Error(`sigstore ran under ${result.runtime}, not Node`);
  if (result.error !== undefined) throw new Error(`${result.error} (${result.runtime})`);
  const identity = result.identity!;
  return { ...identity, oids: identity.oids.map((entry) => ({ oid: entry.oid, value: new Uint8Array(Buffer.from(entry.value, "base64")) })) };
};
