/**
 * SignStrategy types for TinyCloud authorization.
 *
 * These types define how sign requests are handled across different
 * SDK implementations (web-sdk, node-sdk). The pattern allows for
 * automatic signing, rejection, callback-based approval, or event-driven
 * workflows.
 *
 * @packageDocumentation
 */

/**
 * Sign request passed to callback or event handlers.
 */
export interface SignRequest {
  /** Ethereum address of the signer */
  address: string;
  /** Chain ID for the signing context */
  chainId: number;
  /** Message to be signed */
  message: string;
  /** Type of sign operation */
  type: "siwe" | "message";
}

/**
 * Sign response from callback or event handlers.
 */
export interface SignResponse {
  /** Whether the sign request was approved */
  approved: boolean;
  /** The signature if approved */
  signature?: string;
  /** Reason for rejection if not approved */
  reason?: string;
}

/**
 * Callback handler type for sign requests.
 */
export type SignCallback = (request: SignRequest) => Promise<SignResponse>;

export interface OpenKeySigningStrategyOptions {
  /**
   * OpenKey signing endpoint URL.
   *
   * The SDK sends `POST endpoint` with JSON:
   * `{ address, chainId, message, type, keyId? }`.
   *
   * Expected successful response shape:
   * `{ signature: "0x..." }` or `{ approved: true, signature: "0x..." }`.
   *
   * Explicit-approval-needed response shape:
   * `{ approved: false, reason?: string }` or
   * `{ needsApproval: true, reason?: string, approvalUrl?: string }`.
   */
  endpoint: string;
  /** Optional OpenKey managed key id. */
  keyId?: string;
  /** Optional bearer token or async token supplier. */
  token?: string | (() => string | Promise<string | undefined>) | undefined;
  /** Extra headers to include on every request. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Request credentials mode for browser integrations. */
  credentials?: "include" | "omit" | "same-origin";
}

export interface OpenKeySigningRequestBody extends SignRequest {
  keyId?: string;
}

export interface OpenKeySigningResponseBody {
  approved?: boolean;
  signature?: string;
  reason?: string;
  error?: string;
  needsApproval?: boolean;
  approvalUrl?: string;
}

export interface OpenKeyCallbackStrategy extends CallbackStrategy {
  /** Marker used by SDK runtimes to choose the bootstrap-safe initial SIWE. */
  openKeyAutoSign: true;
}

async function resolveOpenKeyToken(
  token: OpenKeySigningStrategyOptions["token"],
): Promise<string | undefined> {
  return typeof token === "function" ? token() : token;
}

async function resolveOpenKeyHeaders(
  headers: OpenKeySigningStrategyOptions["headers"],
): Promise<Record<string, string>> {
  return typeof headers === "function" ? headers() : headers ?? {};
}

function openKeyApprovalReason(body: OpenKeySigningResponseBody): string {
  if (body.reason) return body.reason;
  if (body.error) return body.error;
  if (body.approvalUrl) {
    return `OpenKey explicit approval required: ${body.approvalUrl}`;
  }
  return "OpenKey explicit approval required";
}

/**
 * Create a callback signing strategy that delegates message signing to OpenKey.
 *
 * The helper deliberately returns the existing `CallbackStrategy` shape. When
 * OpenKey's policy gate says a request needs explicit approval, the callback
 * returns `{ approved: false, reason }`; `NodeUserAuthorization` then surfaces
 * that reason as the sign-in/signing error.
 */
export function createOpenKeyCallbackSigningStrategy(
  options: OpenKeySigningStrategyOptions,
): OpenKeyCallbackStrategy {
  return {
    type: "callback",
    openKeyAutoSign: true,
    handler: async (request) => {
      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (!fetchImpl) {
        throw new Error("OpenKey signing strategy requires a fetch implementation");
      }

      const token = await resolveOpenKeyToken(options.token);
      const extraHeaders = await resolveOpenKeyHeaders(options.headers);
      const body: OpenKeySigningRequestBody = {
        ...request,
        ...(options.keyId ? { keyId: options.keyId } : {}),
      };

      const response = await fetchImpl(options.endpoint, {
        method: "POST",
        credentials: options.credentials,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });

      let parsed: OpenKeySigningResponseBody | undefined;
      try {
        parsed = (await response.json()) as OpenKeySigningResponseBody;
      } catch {
        parsed = undefined;
      }

      if (!response.ok) {
        return {
          approved: false,
          reason:
            parsed?.reason ??
            parsed?.error ??
            `OpenKey signing failed with HTTP ${response.status}`,
        };
      }

      if (parsed?.needsApproval || parsed?.approved === false) {
        return {
          approved: false,
          reason: openKeyApprovalReason(parsed),
        };
      }

      if (typeof parsed?.signature === "string" && parsed.signature.length > 0) {
        return {
          approved: true,
          signature: parsed.signature,
        };
      }

      return {
        approved: false,
        reason: "OpenKey signing response did not include a signature",
      };
    },
  };
}

/**
 * Auto-sign strategy: automatically signs all requests.
 *
 * Use cases:
 * - Trusted backend services
 * - Automated scripts
 * - CI/CD pipelines
 *
 * @example
 * ```typescript
 * const strategy: AutoSignStrategy = { type: 'auto-sign' };
 * ```
 */
export interface AutoSignStrategy {
  type: "auto-sign";
}

/**
 * Auto-reject strategy: rejects all sign requests.
 *
 * Use cases:
 * - Read-only applications
 * - Testing rejection flows
 *
 * @example
 * ```typescript
 * const strategy: AutoRejectStrategy = { type: 'auto-reject' };
 * ```
 */
export interface AutoRejectStrategy {
  type: "auto-reject";
}

/**
 * Callback strategy: delegates sign decisions to a callback function.
 *
 * Use cases:
 * - CLI applications with user prompts
 * - Custom approval workflows
 * - Interactive sign flows
 *
 * @example
 * ```typescript
 * const strategy: CallbackStrategy = {
 *   type: 'callback',
 *   handler: async (req) => {
 *     const approved = await promptUser(`Sign message for ${req.address}?`);
 *     return { approved, signature: approved ? await signer.sign(req.message) : undefined };
 *   }
 * };
 * ```
 */
export interface CallbackStrategy {
  type: "callback";
  handler: SignCallback;
}

/**
 * Event emitter strategy: emits sign requests as events.
 *
 * Uses EventTarget for cross-platform compatibility (browser + Node.js).
 *
 * Events emitted:
 * - 'sign-request': When a sign request is received
 *
 * Use cases:
 * - Async approval workflows
 * - External signing services
 * - Multi-step authorization flows
 *
 * @example
 * ```typescript
 * const emitter = new EventTarget();
 * const strategy: EventEmitterStrategy = { type: 'event-emitter', emitter };
 *
 * emitter.addEventListener('sign-request', async (event) => {
 *   const { request, respond } = (event as CustomEvent).detail;
 *   const approved = await externalApprovalService.check(request);
 *   respond({ approved, signature: approved ? await sign(request.message) : undefined });
 * });
 * ```
 */
export interface EventEmitterStrategy {
  type: "event-emitter";
  emitter: EventTarget;
  /** Timeout in milliseconds for waiting on event response (default: 60000) */
  timeout?: number;
}

/**
 * Sign strategy union type.
 *
 * Determines how sign requests are handled in UserAuthorization implementations.
 */
export type SignStrategy =
  | AutoSignStrategy
  | AutoRejectStrategy
  | CallbackStrategy
  | EventEmitterStrategy;

/**
 * Default sign strategy is auto-sign for convenience.
 */
export const defaultSignStrategy: SignStrategy = { type: "auto-sign" };
