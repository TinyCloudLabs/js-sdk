import type { PublishedShare } from "@tinycloud/share-sdk";
import type { ShareInspection, ShareReceiveResult } from "@tinycloud/share-sdk";

type AuthorizationRequired = {
  readonly state: "authorization-required";
  readonly method: string;
};

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Serialize only the non-secret continuation contract for authorization. */
export function authorizationRequiredJson(result: AuthorizationRequired): AuthorizationRequired & { readonly next: string } {
  return {
    state: "authorization-required",
    method: result.method,
    next: "complete authorization through the configured authority adapter, then retry with the required proof",
  };
}

export function publishHuman(result: PublishedShare): void {
  process.stdout.write(`${result.url}\n`);
}

export function inspectHuman(result: ShareInspection): void {
  const metadata = result.metadata;
  process.stdout.write([
    `Share ${metadata.shareId}`,
    `File: ${metadata.display.filename ?? "unnamed"}`,
    `Target: ${metadata.target.kind === "bearer" ? "bearer (anyone with the complete link can read)" : metadata.target.kind}`,
    `Expires: ${metadata.expiresAt}`,
    `Resource: ${metadata.resource.path}`,
    `Link format: ${result.link.kind}`,
  ].join("\n") + "\n");
}

export function receiveHuman(path: string): void {
  process.stdout.write(`${path}\n`);
}

export function receiveJson(result: ShareReceiveResult, path: string): void {
  writeJson({ protocol: "tinycloud-share", version: 1, path, metadata: result.metadata });
}
