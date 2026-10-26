import { randomBytes } from "node:crypto";
import { SiweMessage } from "siwe";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { canonicalOwnerDid } from "./owner-did.js";
import {
  startOwnerRevocationHandoff,
  type OpenKeyHandoff,
  type OwnerRevocationRequest,
  type OwnerRevocationResponse,
} from "../auth/prepared-openkey.js";

export type OwnerSignatureTransport = (options: {
  request: OwnerRevocationRequest;
  openKeyHost: string;
}) => Promise<OpenKeyHandoff<OwnerRevocationResponse>>;

function refused(): CLIError {
  return new CLIError("OWNER_REVOCATION_SIGNATURE_INVALID",
    "OpenKey returned a revocation signature that does not match this owner and delegation. No node request was sent.",
    ExitCode.PERMISSION_DENIED);
}

/** Verify the exact SIWE and signature before making them a node Authorization header. */
export async function verifyOwnerRevocationResponse(
  request: OwnerRevocationRequest,
  response: OwnerRevocationResponse,
  now = new Date(),
): Promise<string> {
  try {
    const ownerDid = canonicalOwnerDid(request.ownerDid);
    const [, , , chain, address] = ownerDid.split(":");
    const message = new SiweMessage(response.siwe);
    const issuedAt = Date.parse(message.issuedAt ?? "");
    const expiration = Date.parse(message.expirationTime ?? "");
    const limit = Date.parse(request.expiresAt);
    if (message.address !== address || message.chainId !== Number(chain) ||
        message.uri !== `ucan:${request.cid}` || message.nonce !== request.nonce ||
        message.version !== "1" || !message.domain || message.scheme || message.requestId ||
        message.statement || message.notBefore || message.resources !== undefined ||
        !Number.isFinite(issuedAt) || !Number.isFinite(expiration) || !Number.isFinite(limit) ||
        expiration <= now.getTime() || expiration > limit || expiration <= issuedAt ||
        expiration - issuedAt > 600_000 || issuedAt > now.getTime() ||
        message.prepareMessage() !== response.siwe) throw refused();
    const verified = await message.verify({ signature: response.signature, nonce: request.nonce, time: now.toISOString() });
    if (!verified.success || verified.data.address !== address) throw refused();
    const authorization = new NodeWasmBindings().siweToDelegationHeaders(response).Authorization;
    if (typeof authorization !== "string" || !authorization) throw refused();
    return authorization;
  } catch {
    throw refused();
  }
}

export async function requestOwnerSignature(options: {
  ownerDid: string;
  cid: string;
  openKeyHost: string;
  transport?: OwnerSignatureTransport;
  now?: Date;
}): Promise<{ authorization: string; complete(accepted: boolean): Promise<void> }> {
  const now = options.now ?? new Date();
  const request: OwnerRevocationRequest = {
    kind: "owner-revocation", ownerDid: canonicalOwnerDid(options.ownerDid), cid: options.cid,
    nonce: randomBytes(16).toString("hex"), expiresAt: new Date(now.getTime() + 570_000).toISOString(),
  };
  const handoff = await (options.transport ?? startOwnerRevocationHandoff)({ request, openKeyHost: options.openKeyHost });
  try {
    const response = await handoff.result;
    const authorization = await verifyOwnerRevocationResponse(request, response);
    return { authorization, complete: handoff.complete };
  } catch (error) {
    await handoff.complete(false);
    throw error;
  }
}

/** The owner-signed node path shared by logout and delegation revoke. */
export async function revokeOwnerCid(options: {
  ownerDid: string;
  cid: string;
  host: string;
  openKeyHost: string;
  transport?: OwnerSignatureTransport;
  fetchFn?: typeof fetch;
}): Promise<void> {
  let signed: Awaited<ReturnType<typeof requestOwnerSignature>>;
  try {
    signed = await requestOwnerSignature(options);
  } catch (error) {
    if (error instanceof CLIError && error.code === "OWNER_REVOCATION_SIGNATURE_INVALID") throw error;
    throw new CLIError("REVOCATION_AUTHORITY_UNAVAILABLE",
      "OpenKey owner CID revocation requires a verified owner signature. No CID was revoked; session, key and replica files remain for retry, while local replica reads stay denied.",
      ExitCode.AUTH_REQUIRED, { hint: `This sign-in can't be revoked from the CLI yet. Revoke it at https://account.tinycloud.xyz/delegations. To sign out on this computer only, run \`${CLI_NAME} auth logout\`.` });
  }
  try {
    const response = await (options.fetchFn ?? fetch)(`${options.host.replace(/\/$/, "")}/revoke`, {
      method: "POST", headers: { Authorization: signed.authorization },
    });
    if (!response.ok) {
      throw new CLIError(response.status === 403 ? "REVOKE_UNAUTHORIZED" : "REVOCATION_FAILED",
        `The node refused revocation of ${options.cid} (HTTP ${response.status}).`,
        response.status === 403 ? ExitCode.PERMISSION_DENIED : ExitCode.ERROR, { status: response.status, cid: options.cid });
    }
    const receipt: unknown = await response.json();
    if (!receipt || typeof receipt !== "object" || !('revoked' in receipt) || receipt.revoked !== true ||
        !('cid' in receipt) || receipt.cid !== options.cid) {
      throw new CLIError("REVOCATION_FAILED", `The node did not confirm revocation of ${options.cid}.`, ExitCode.ERROR, { cid: options.cid });
    }
    await signed.complete(true);
  } catch (error) {
    await signed.complete(false);
    if (error instanceof CLIError) throw error;
    throw new CLIError("REVOCATION_FAILED", `Revocation of ${options.cid} could not be confirmed by the node.`, ExitCode.ERROR, { cid: options.cid });
  }
}
