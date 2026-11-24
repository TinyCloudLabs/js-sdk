// Verify a Sigstore bundle (stdin, JSON) against the pinned offline trust root, with the `sigstore` modules the CLI
// pins, and print the signer identity as JSON. Tests run this under Node, the CLI's runtime: Bun before 1.4 can't
// verify ECDSA signatures without a named digest, so sigstore's Rekor SET check fails there (TC-4276).
"use strict";
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");

const fromSigstore = createRequire(require.resolve("sigstore"));
const { Verifier, toTrustMaterial, toSignedEntity } = fromSigstore("@sigstore/verify");
const { bundleFromJSON } = fromSigstore("@sigstore/bundle");
const { TrustedRoot } = fromSigstore("@sigstore/protobuf-specs");

const trustedRoot = JSON.parse(readFileSync(join(__dirname, "fixtures", "sigstore", "trusted_root.json"), "utf8"));
const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trustedRoot)));
const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
try {
  const { identity } = verifier.verify(toSignedEntity(bundleFromJSON(JSON.parse(readFileSync(0, "utf8")))), {});
  process.stdout.write(JSON.stringify({
    runtime,
    identity: {
      subjectAlternativeName: identity.subjectAlternativeName,
      extensions: identity.extensions,
      oids: (identity.oids ?? []).map((entry) => ({ oid: entry.oid, value: Buffer.from(entry.value).toString("base64") })),
    },
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({ runtime, error: `${error.code ?? error.name}: ${error.message}` }));
}
