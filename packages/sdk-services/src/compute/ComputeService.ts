/**
 * ComputeService - Compute (WASM routine) service implementation.
 *
 * Platform-agnostic compute service that works with both web-sdk and
 * node-sdk. Uses dependency injection via IServiceContext for platform
 * dependencies, mirroring SQLService/DuckDbService.
 *
 * Wire format and the deploy sequence are cross-referenced against
 * tinycloud-node's specs/compute-service.md (§5.1, §6.2, §7, §8, §9.1.1) and
 * `tinycloud-node-server/src/routes/mod.rs`
 * (`handle_compute_routine_did`/`handle_compute_deploy`/`handle_compute_execute`).
 */

import { BaseService } from "../base/BaseService";
import {
  Result,
  ok,
  err,
  ErrorCodes,
  serviceError,
  type FetchResponse,
  type ServiceSession,
} from "../types";
import { authRequiredError, wrapError } from "../errors";
import {
  formatServiceResponseError,
  parseServiceErrorBody,
  responseErrorMeta,
} from "../responseErrors";
import { base64Encode } from "../encryption/canonical";
import type { IComputeService } from "./IComputeService";
import {
  ComputeAction,
  type ComputeServiceConfig,
  type ComputeDataGrant,
  type ComputeDeployOptions,
  type ComputeDeployResult,
  type ComputeExecuteOptions,
  type ComputeExecuteResult,
  type ComputeRoutineDidWireResponse,
  type ComputeDeployWireResponse,
  type ComputeExecuteWireResponse,
} from "./types";

/** CID multicodec for raw bytes (0x55) — matches the node's content-CID scheme. */
const RAW_CODEC = 0x55n;

/** Default `D_fn` lifetime: ~10 years. A deploy-time grant is meant to
 * outlive ordinary sessions; re-deploying mints a fresh one. */
const DEFAULT_DFN_LIFETIME_SECS = 10 * 365 * 24 * 60 * 60;

export class ComputeService extends BaseService implements IComputeService {
  static readonly serviceName = "compute";

  declare protected _config: ComputeServiceConfig;

  constructor(config: ComputeServiceConfig = {}) {
    super();
    this._config = config;
  }

  get config(): ComputeServiceConfig {
    return this._config;
  }

  private get host(): string {
    return this.context.hosts[0];
  }

  async deploy(
    wasm: Uint8Array,
    name: string,
    options: ComputeDeployOptions,
  ): Promise<Result<ComputeDeployResult>> {
    return this.withTelemetry("deploy", name, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("compute"));
      }
      if (!this.context.computeCid) {
        return err(
          serviceError(
            ErrorCodes.COMPUTE_BINDING_UNAVAILABLE,
            "compute deploy requires a computeCid WASM binding, which this SDK runtime does not provide",
            "compute",
          ),
        );
      }
      if (!this.context.createDelegationWithCaveat) {
        return err(
          serviceError(
            ErrorCodes.COMPUTE_BINDING_UNAVAILABLE,
            "compute deploy requires a createDelegationWithCaveat WASM binding, which this SDK runtime does not provide",
            "compute",
          ),
        );
      }
      if (!this.context.mintPrivilegedSession) {
        return err(
          serviceError(
            ErrorCodes.COMPUTE_BINDING_UNAVAILABLE,
            "compute deploy requires a mintPrivilegedSession platform binding — compute/deploy is a privileged capability never held by the ambient session",
            "compute",
          ),
        );
      }
      if (!options.dataGrants || options.dataGrants.length === 0) {
        return err(
          serviceError(
            ErrorCodes.INVALID_INPUT,
            "compute deploy requires at least one dataGrants entry for the routine's own D_fn",
            "compute",
          ),
        );
      }

      try {
        const session = this.context.session!;
        const functionCid = this.context.computeCid(wasm, RAW_CODEC);

        // compute/deploy is deliberately excluded from the ambient session
        // (compute-service.md §12.1 F9) — mint a short-lived session scoped
        // to ONLY this privileged ability, on ONLY this function's resource
        // path, for the two deploy-path invocations below (the RoutineDid
        // handshake needs no path coverage — §7.1 select_compute_scope — but
        // the deploy submission's resource IS `<space>/compute/<name>`, so
        // scoping to `name` covers both with least privilege). The D_fn mint
        // (step 2) stays on the AMBIENT session: D_fn's proof chain must
        // resolve to a delegation that actually grants the data abilities
        // being handed to the routine (kv/*, sql/*, ...), which the
        // compute/deploy-only session does not carry.
        const deploySession = await this.context.mintPrivilegedSession({
          service: "compute",
          path: name,
          ability: ComputeAction.DEPLOY,
        });

        // Step 1: the RoutineDid handshake (§6.2/F2) — learn the routine
        // identity the node derives for (space, functionCid). The deployer
        // cannot compute this client-side (it's a TEE/node-derived seed).
        const handshake = await this.invokeCompute(
          deploySession,
          functionCid,
          ComputeAction.DEPLOY,
          { action: "routine_did", content_cid: functionCid },
          options.signal,
        );
        if (!handshake.ok) {
          return this.handleErrorResponse(handshake, "deploy (routine_did handshake)");
        }
        const routineDidResponse =
          (await handshake.json()) as ComputeRoutineDidWireResponse;
        const routineDid = routineDidResponse.routine_did;

        // Step 2: mint D_fn — a delegation to the routine DID carrying the
        // computeFunctionBinding caveat on every granted row (§5.1/§6.2, D2).
        const abilities = buildAbilitiesMap(options.dataGrants);
        const caveat = { computeFunctionBinding: { functionCid } };
        const expirationSecs =
          options.expirationSecs ?? nowSecs() + DEFAULT_DFN_LIFETIME_SECS;
        const dFn = this.context.createDelegationWithCaveat(
          session,
          routineDid,
          session.spaceId,
          abilities,
          expirationSecs,
          options.notBeforeSecs,
          caveat,
        );

        // Step 3: submit the deploy (wasm bytes + D_fn), processed atomically
        // by the node (§5.1/F4). Still the privileged deploySession.
        const deployResponse = await this.invokeCompute(
          deploySession,
          name,
          ComputeAction.DEPLOY,
          {
            action: "deploy",
            function: name,
            wasm_b64: base64Encode(wasm),
            grant: dFn.delegation,
          },
          options.signal,
        );
        if (!deployResponse.ok) {
          return this.handleErrorResponse(deployResponse, "deploy");
        }
        const data = (await deployResponse.json()) as ComputeDeployWireResponse;
        return ok({
          functionCid: data.content_cid,
          routineDid: data.routine_did,
          function: data.function,
          revision: data.revision,
          supersededContentCid: data.superseded_content_cid,
          supersededGrant: data.superseded_grant,
        });
      } catch (error) {
        return err(wrapError("compute", error));
      }
    });
  }

  async execute<T = unknown>(
    name: string,
    input: unknown,
    options?: ComputeExecuteOptions,
  ): Promise<Result<ComputeExecuteResult<T>>> {
    return this.withTelemetry("execute", name, async () => {
      if (!this.requireAuth()) {
        return err(authRequiredError("compute"));
      }

      try {
        const body: Record<string, unknown> = {
          action: "execute",
          function: name,
          input: input ?? null,
        };
        if (options?.contentCid !== undefined) body.content_cid = options.contentCid;
        if (options?.outputRef !== undefined) body.output_ref = options.outputRef;

        const response = await this.invokeCompute(
          this.context.session!,
          name,
          ComputeAction.EXECUTE,
          body,
          options?.signal,
        );
        if (!response.ok) {
          return this.handleErrorResponse(response, "execute");
        }

        const data = (await response.json()) as ComputeExecuteWireResponse;
        return ok<ComputeExecuteResult<T>>({
          functionCid: data.content_cid,
          result: data.result as T,
          manifest: data.manifest,
          grantedButUnexercised: data.grantedButUnexercised,
          outputDestination: data.output_destination,
          verification: data.verification,
        });
      } catch (error) {
        return err(wrapError("compute", error));
      }
    });
  }

  // === Private helpers ===

  private async invokeCompute(
    session: ServiceSession,
    path: string,
    action: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<FetchResponse> {
    const headers = this.context.invoke(session, "compute", path, action);

    return this.context.fetch(`${this.host}/invoke`, {
      method: "POST",
      headers: {
        ...(headers as Record<string, string>),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body) as any,
      signal: this.combineSignals(signal),
    });
  }

  private async handleErrorResponse(
    response: FetchResponse,
    operation: string,
  ): Promise<Result<never>> {
    const errorText = await response.text();
    const errorBody = parseServiceErrorBody(errorText);
    const errorCode = this.mapHttpStatusToErrorCode(response.status);
    const message = formatServiceResponseError(
      "Compute",
      operation,
      response.status,
      errorText,
      errorBody,
    );
    const meta = responseErrorMeta(response.status, response.statusText, errorText);

    return err(serviceError(errorCode, message, "compute", { meta }));
  }

  private mapHttpStatusToErrorCode(status: number): string {
    switch (status) {
      case 400:
        return ErrorCodes.COMPUTE_ERROR;
      case 401:
        return ErrorCodes.AUTH_UNAUTHORIZED;
      case 403:
        return ErrorCodes.COMPUTE_PERMISSION_DENIED;
      case 404:
        return ErrorCodes.COMPUTE_FUNCTION_NOT_FOUND;
      case 402:
      case 429:
        return ErrorCodes.COMPUTE_QUOTA_EXCEEDED;
      case 409:
        return ErrorCodes.COMPUTE_GRANT_UNAVAILABLE;
      default:
        return ErrorCodes.NETWORK_ERROR;
    }
  }
}

/**
 * Group flat (service, path, ability) grant lines into the
 * `{ [service]: { [path]: [ability, ...] } }` map `createDelegationWithCaveat`
 * expects (same shape `createDelegation` uses).
 */
function buildAbilitiesMap(
  grants: ComputeDataGrant[],
): Record<string, Record<string, string[]>> {
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const grant of grants) {
    const byPath = abilities[grant.service] ?? (abilities[grant.service] = {});
    const actions = byPath[grant.path] ?? (byPath[grant.path] = []);
    if (!actions.includes(grant.ability)) {
      actions.push(grant.ability);
    }
  }
  return abilities;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
