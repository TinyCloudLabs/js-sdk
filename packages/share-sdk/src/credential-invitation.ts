import { parseSealedInlineShareUrl } from "@tinycloud/share-envelope";

/** The signed, app-neutral receipt accepted by OpenCredentials' invitation endpoint. */
export interface CredentialInvitationReceipt {
  readonly request: {
    readonly returnLink: string;
    readonly [field: string]: unknown;
  };
  readonly admission: Record<string, unknown>;
  readonly proof: Record<string, unknown>;
}

export interface CredentialInvitationResult {
  readonly status: "accepted";
}

export type CredentialInvitationErrorCode =
  | "invalid-origin"
  | "invalid-receipt"
  | "rejected"
  | "invalid-response"
  | "transport";

/** A detail-free boundary error; it never embeds signed invitation material. */
export class CredentialInvitationError extends Error {
  constructor(
    readonly code: CredentialInvitationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CredentialInvitationError";
  }
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CredentialInvitationError(
      "invalid-origin",
      "credential invitation origin is invalid",
    );
  }
  if (
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.protocol !== "https:"
  )
    throw new CredentialInvitationError(
      "invalid-origin",
      "credential invitation origin is invalid",
    );
  return url.origin;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function validateReceipt(
  receipt: CredentialInvitationReceipt,
  shareUrl: string,
): Promise<void> {
  if (
    !object(receipt) ||
    !object(receipt.request) ||
    !object(receipt.admission) ||
    !object(receipt.proof)
  ) {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation receipt is invalid",
    );
  }
  if (receipt.request.returnLink !== shareUrl) {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation is not bound to the share link",
    );
  }
  let link: URL;
  try {
    link = new URL(shareUrl);
  } catch {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation share link is invalid",
    );
  }
  if (link.search !== "" || link.pathname !== "/s/inline") {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation share link must be sealed inline",
    );
  }
  try {
    await parseSealedInlineShareUrl(shareUrl);
  } catch {
    throw new CredentialInvitationError(
      "invalid-receipt",
      "credential invitation share link is invalid",
    );
  }
}

/**
 * Submit a Node-authorized credential invitation without involving the Share
 * application. Other TinyCloud applications can use this same boundary.
 */
export async function deliverCredentialInvitation(input: {
  readonly credentialsOrigin: string;
  readonly receipt: CredentialInvitationReceipt;
  readonly shareUrl: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<CredentialInvitationResult> {
  const credentialsOrigin = canonicalOrigin(input.credentialsOrigin);
  await validateReceipt(input.receipt, input.shareUrl);
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(`${credentialsOrigin}/v1/credential-invitations`, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(input.receipt),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    throw new CredentialInvitationError(
      "transport",
      "credential invitation delivery is unavailable",
    );
  }
  if (response.status !== 202) {
    throw new CredentialInvitationError(
      "rejected",
      "credential invitation delivery was not accepted",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CredentialInvitationError(
      "invalid-response",
      "credential invitation response is invalid",
    );
  }
  if (
    !object(body) ||
    Object.keys(body).length !== 1 ||
    body.status !== "accepted"
  ) {
    throw new CredentialInvitationError(
      "invalid-response",
      "credential invitation response is invalid",
    );
  }
  return { status: "accepted" };
}
