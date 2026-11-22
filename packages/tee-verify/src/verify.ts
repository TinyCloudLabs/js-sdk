import { getCollateral, verify as verifyQuote, type Collateral, type TcbStatus } from "@phala/dcap-qvl";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { refuse } from "./errors.js";
import { replayRtmr3 } from "./replay.js";
import { checkTrust, PUBLISHED_TRUST, type ServiceName, type Trust } from "./trust.js";

/** Phala's PCCS, the collateral source the dstack stack itself uses. */
export const PCCS_URL = "https://pccs.phala.network";

/** The `/attestation` response (tinycloud-node docs/attestation.md). */
export interface AttestationResponse {
  mode: string;
  quote: string;
  event_log: string;
  compose_hash: string;
  app_id: string;
  enforcer_did: string;
  key_binding: string;
  key_binding_sha256: string;
  timestamp?: string;
}

/** Key-binding domain per service. `null`: the service's route shape is not pinned yet. */
const BINDING_DOMAIN: Record<ServiceName, string | null> = {
  "tinycloud-node": "xyz.tinycloud.share/tee-key/v1",
  // OpenKey's public route is TC-3842; its shape is pinned here once that PR is.
  openkey: null,
};

/** The service's key-binding domain; refuses a service whose route shape is not pinned. */
export function bindingDomain(service: ServiceName): string {
  const domain = BINDING_DOMAIN[service];
  if (domain === undefined) refuse("service", `unknown service ${JSON.stringify(service)}`);
  if (domain === null) refuse("service", `${service}: route shape not pinned`);
  return domain;
}

/** 1-64 characters of A-Z a-z 0-9 - _ (the node's rule); at least 16 so it can't be guessed. */
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export interface VerifyOptions {
  service: ServiceName;
  /** The nonce you sent. Choose it fresh and unpredictable for every request. */
  nonce: string;
  /** The signer you expect the service to use, e.g. the node's `did:key`. */
  identity: string;
  /** Published lists by default. */
  trust?: Trust;
  /** Verification clock; defaults to now. */
  now?: Date;
  /** Collateral to verify against; fetched from `pccsUrl` when absent. Its signatures are still checked. */
  collateral?: Collateral;
  pccsUrl?: string;
}

export interface Verified {
  service: ServiceName;
  version: string;
  osImage: { name: string; hash: string };
  appId: string;
  composeHash: string;
  /** The signer the quote binds. */
  identity: string;
  tcbStatus: TcbStatus;
}

function field(response: Record<string, unknown>, name: keyof AttestationResponse): string {
  const value = response[name];
  if (typeof value !== "string") refuse("response", `response has no ${name}`);
  return value;
}

const short = (hex: string) => `${hex.slice(0, 8)}…`;

/**
 * Verifies a service's `/attestation` response, failing closed. In order:
 * the binding of `identity` and `nonce`; Intel's signature over the quote and
 * TCB status UpToDate; REPORTDATA; the TD debug bit; the RTMR3 event-log
 * replay; the OS image against the published production list; and the app ID
 * and compose hash against the published releases. Throws `TeeVerifyRefused`
 * saying which check failed.
 */
export async function verifyAttestation(response: unknown, options: VerifyOptions): Promise<Verified> {
  const trust = options.trust ? checkTrust(options.trust) : PUBLISHED_TRUST;
  // Copy before any await so the caller can't change what was checked.
  if (!response || typeof response !== "object") refuse("response", "response is not a JSON object");
  const r = structuredClone(response) as Record<string, unknown>;

  const domain = bindingDomain(options.service);

  const mode = field(r, "mode");
  if (mode !== "dstack") refuse("mode", `service is not attesting from a TEE (mode ${JSON.stringify(mode)})`);

  // Steps 1-3 of docs/attestation.md: rebuild the binding from our own nonce and expected signer.
  if (!NONCE.test(options.nonce)) refuse("nonce", "nonce must be 16-64 characters of A-Z, a-z, 0-9, '-' or '_'");
  const preimage = `${domain}\\0:${options.identity}:${options.nonce}`;
  if (field(r, "key_binding") !== preimage) refuse("binding", "key binding is not for this nonce and signer");
  if (field(r, "enforcer_did") !== options.identity) refuse("identity", `service signs as ${String(r.enforcer_did)}, not ${options.identity}`);
  const digest = sha256(utf8ToBytes(preimage));
  if (field(r, "key_binding_sha256") !== bytesToHex(digest)) refuse("binding", "key_binding_sha256 is not the binding's SHA-256");

  // Step 4: Intel DCAP signature, certificate chain, collateral and TCB.
  const quoteHex = field(r, "quote");
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(quoteHex)) refuse("quote", "quote is not hex");
  const quote = hexToBytes(quoteHex);
  const now = options.now ?? new Date();
  let verified;
  try {
    const collateral = options.collateral ?? (await getCollateral(options.pccsUrl ?? PCCS_URL, quote));
    verified = verifyQuote(quote, collateral, Math.floor(now.getTime() / 1000));
  } catch (error) {
    refuse("quote", `quote did not verify: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (verified.status !== "UpToDate") refuse("tcb", `TCB status is ${verified.status}, not UpToDate`);
  const td = verified.report.asTd10() ?? verified.report.asTd15()?.base;
  if (!td) refuse("quote", "quote is not a TDX quote");
  const expectedReportData = new Uint8Array(64);
  expectedReportData.set(digest);
  if (bytesToHex(td.reportData) !== bytesToHex(expectedReportData)) refuse("report-data", "quote REPORTDATA is not the binding digest");

  // Step 5: TDATTRIBUTES bit 0 (TUD.DEBUG) must be clear.
  if ((td.tdAttributes[0]! & 1) !== 0) refuse("debug", "TD runs in debug mode; the host can read its memory");

  // Step 6: identity from the replayed event log, never from the JSON fields.
  let events: unknown;
  try {
    events = JSON.parse(field(r, "event_log"));
  } catch {
    refuse("event-log", "event log is not JSON");
  }
  const measured = replayRtmr3(events);
  if (measured.rtmr3 !== bytesToHex(td.rtMr3)) refuse("event-log", "event log does not replay to the quote's RTMR3");
  if (field(r, "app_id").toLowerCase() !== measured.appId || field(r, "compose_hash").toLowerCase() !== measured.composeHash) {
    refuse("response", "app_id or compose_hash in the response differ from the measured ones");
  }

  const refused = trust.refusedOsImages.find((p) => p.osImageHash === measured.osImageHash);
  if (refused) refuse("os", `OS image ${refused.name} (${short(refused.osImageHash)}) is not a production image: ${refused.why}`);
  const sameImage = trust.osImages.filter((p) => p.osImageHash === measured.osImageHash);
  if (sameImage.length === 0) refuse("os", `OS image ${short(measured.osImageHash)} is not a published production image`);
  const mrs = [td.mrTd, td.rtMr0, td.rtMr1, td.rtMr2].map(bytesToHex);
  const os = sameImage.find((p) => [p.mrtd, p.rtmr0, p.rtmr1, p.rtmr2].every((m, i) => m === mrs[i]));
  if (!os) refuse("os", `OS image ${sameImage[0]!.name} measurements (MRTD, RTMR0-2) differ from the published ones`);

  const release = trust.releases.find(
    (p) => p.service === options.service && p.appId === measured.appId && p.composeHash === measured.composeHash,
  );
  if (!release) {
    refuse("release", `compose hash ${short(measured.composeHash)} of app ${measured.appId} is not a released ${options.service} version`);
  }

  return {
    service: options.service,
    version: release.version,
    osImage: { name: os.name, hash: os.osImageHash },
    appId: measured.appId,
    composeHash: measured.composeHash,
    identity: options.identity,
    tcbStatus: verified.status,
  };
}
