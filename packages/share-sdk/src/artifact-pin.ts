/**
 * Artifact pin verification (TC-1428). Small on purpose: this is the one place that decides whether an addressed
 * share that reads an artifact version may be trusted.
 *
 * What is signed. The owner signs the whole Policy/v3 envelope (Ed25519, `verifyEnvelopeV3SignatureOnly`). `artifactPin` is a
 * field of that envelope, so the signature covers it: artifact id, version, the sha256 of the version's
 * `manifest.json`, and the sha256 and size of the one stored file the share reads. The manifest stays an owner-side
 * record; a recipient never needs to fetch it. Policy/v3 already binds the file's ciphertext digest
 * (`contentSource.initialCiphertextDigestHex`); the pin binds that digest to an artifact identity and a version, so a
 * share cannot be re-pointed at another version or another artifact's path without breaking the signature.
 *
 * Trust model (accepted, TC-1428 finding 3): the owner is the trusted signer. The node has no write-once ACL, so the
 * owner (or whoever holds the owner's session) can overwrite `versions/<n>/<file>` afterwards. A recipient then
 * detects the substitution through the pin digest and fails closed; it cannot tell a malicious owner from a node
 * serving stale or altered bytes, and does not try to.
 *
 * Fails closed: any addressed share whose content source lies under `artifacts/` must carry a valid pin that matches
 * that source. A pin on any other path is refused. `artifacts/<id>/current/...` has no pin form in v1 and is refused.
 */
import {
  verifyEnvelopeV3SignatureOnly,
  type ArtifactPin,
  type ShareEnvelopeV3,
  type UnsignedShareEnvelopeV3,
} from "@tinycloud/share-envelope";
import { ARTIFACT_ROOT, parseArtifactVersionPath } from "./artifact-core.js";

export type ArtifactPinErrorCode =
  | "missing-pin"
  | "unsupported-artifact-path"
  | "wrong-signer"
  | "bad-signature"
  | "pin-source-mismatch"
  | "pinned-share-writable"
  | "expectation-mismatch"
  | "file-digest-mismatch"
  | "manifest-mismatch";

export class ArtifactPinError extends Error {
  readonly code: ArtifactPinErrorCode;
  /** The code is the message: stable, short, and what callers and tests match on. */
  constructor(code: ArtifactPinErrorCode) {
    super(code);
    this.name = "ArtifactPinError";
    this.code = code;
  }
}

/**
 * What the caller already knows about the share it is opening, from outside the envelope. Optional: a v1 pinned share
 * names its version in its own signed pin and nothing outside the link says which one to expect, so no production
 * caller passes it. A caller that does learn a version out of band (a listing, a "newer version" link) uses it to
 * refuse an older or different pin.
 */
export interface ExpectedArtifact {
  readonly artifactId?: string;
  readonly version?: number;
}

export interface VerifyArtifactShareOptions {
  /** The did:key the caller trusts as the sender. `signature.signerDid` is self-asserted and proves nothing alone. */
  readonly expectedOwnerDid: string;
  readonly expected?: ExpectedArtifact;
}

/**
 * The fields of an envelope (or of a share about to be built) that the pin binds. Taking a view lets the publisher run
 * the identical check before it registers anything, and the recipient run it again where it reads.
 */
export interface ArtifactBindingView {
  readonly artifactPin?: ArtifactPin;
  readonly target: { readonly spaceId: string };
  readonly contentSource: {
    readonly kvResource: string;
    readonly selector: "exact" | "prefix";
    readonly mode: "mutable" | "immutable";
    readonly initialCiphertextDigestHex?: string | undefined;
  };
  readonly resource: { readonly kind: "exact" | "prefix"; readonly path: string };
  /** Share actions (`read` | `list` | `edit`). */
  readonly actions: readonly string[];
  /** KV abilities the signed policy grants on the content source. */
  readonly policyKvActions: readonly string[];
}

export function artifactBindingView(envelope: UnsignedShareEnvelopeV3 | ShareEnvelopeV3): ArtifactBindingView {
  return {
    ...(envelope.artifactPin === undefined ? {} : { artifactPin: envelope.artifactPin }),
    target: envelope.target,
    contentSource: envelope.contentSource,
    resource: envelope.resource,
    actions: envelope.actions,
    policyKvActions: envelope.policy.capabilityCeiling.flatMap((capability) => capability.kind === "kv" ? capability.actions : []),
  };
}

function sourcePath(view: ArtifactBindingView): string {
  const resource = view.contentSource.kvResource;
  const marker = "/kv/";
  const at = resource.indexOf(marker);
  if (at <= 0 || resource.slice(0, at) !== view.target.spaceId) {
    throw new ArtifactPinError("pin-source-mismatch");
  }
  return resource.slice(at + marker.length);
}

/**
 * The pin and the content source must say the same thing, and a pinned share must be read-only. Synchronous and
 * signature-free, so the publisher can run it before registering anything and the recipient can re-run it at the
 * point of reading. Returns the pin for an artifact share and `undefined` for any other share.
 */
export function assertArtifactBinding(view: ArtifactBindingView, expected: ExpectedArtifact = {}): ArtifactPin | undefined {
  const pin = view.artifactPin;
  const path = sourcePath(view);
  const inArtifacts = path === ARTIFACT_ROOT || path.startsWith(`${ARTIFACT_ROOT}/`);
  if (!inArtifacts) {
    if (pin !== undefined) throw new ArtifactPinError("pin-source-mismatch");
    return undefined;
  }
  if (pin === undefined) throw new ArtifactPinError("missing-pin");
  const parsed = parseArtifactVersionPath(path);
  if (parsed === undefined) throw new ArtifactPinError("unsupported-artifact-path");
  const file = pin.files[0]!;
  const source = view.contentSource;
  if (
    // The stored ciphertext of one file: bounded like content (100 MiB) plus the envelope's own framing.
    file.bytes > 128 * 1024 * 1024
    || pin.artifactId !== parsed.artifactId
    || pin.version !== parsed.version
    || file.path !== parsed.file
    || view.resource.kind !== "exact"
    || view.resource.path !== path
    || source.selector !== "exact"
    || source.mode !== "immutable"
    || source.initialCiphertextDigestHex !== file.sha256
  ) {
    throw new ArtifactPinError("pin-source-mismatch");
  }
  // A pinned path is immutable: neither the envelope nor the signed policy may grant a write on it.
  if (view.actions.includes("edit") || view.policyKvActions.includes("tinycloud.kv/put")) {
    throw new ArtifactPinError("pinned-share-writable");
  }
  if (
    (expected.artifactId !== undefined && expected.artifactId !== pin.artifactId)
    || (expected.version !== undefined && expected.version !== pin.version)
  ) {
    throw new ArtifactPinError("expectation-mismatch");
  }
  return pin;
}

/**
 * Check that the trusted owner signed this envelope (and so its pin), then the pin binding. Throws `ArtifactPinError`;
 * never returns a partial answer. Only the owner's Ed25519 signature over the envelope is checked here, because that
 * is what authenticates the pin. The rest of the envelope (policy signature, owner roots, enforcer binding) is
 * `verifyEnvelopeV3`'s job, and `resolvePolicyShare` runs both before it trusts a link. (Folding the two into one
 * call was measured: +911 gzip bytes in the canonical ESM bundle, for a saved ed25519 verify.)
 */
export function verifyArtifactShare(envelope: ShareEnvelopeV3, options: VerifyArtifactShareOptions): ArtifactPin | undefined {
  if (envelope.signature.signerDid !== options.expectedOwnerDid) {
    throw new ArtifactPinError("wrong-signer");
  }
  let valid: boolean;
  try { valid = verifyEnvelopeV3SignatureOnly(envelope) && envelope.policy.ownerDid === options.expectedOwnerDid; }
  catch { valid = false; }
  if (!valid) throw new ArtifactPinError("bad-signature");
  return assertArtifactBinding(artifactBindingView(envelope), options.expected);
}
