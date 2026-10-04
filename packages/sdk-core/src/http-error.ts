import { ErrorCodes, serviceError } from "@tinycloud/sdk-services";
import type { ServiceError } from "@tinycloud/sdk-services";

/** Preserve the HTTP response as a typed failure without losing its diagnostic text. */
export async function httpResponseError(
  response: Pick<Response, "status" | "statusText" | "text">,
  context: string,
): Promise<Error & { status: number }> {
  const body = await response.text().catch(() => response.statusText);
  return Object.assign(new Error(`${context} (${response.status}) - ${body}`), {
    status: response.status,
  });
}

/** Keep domain-specific non-auth codes while making authorization failures recognizable. */
export async function serviceHttpError(
  response: Pick<Response, "status" | "statusText" | "text">,
  code: string,
  context: string,
  service: string,
): Promise<ServiceError> {
  const body = await response.text().catch(() => response.statusText);
  return serviceError(
    response.status === 401 || response.status === 403
      ? ErrorCodes.AUTH_UNAUTHORIZED
      : code,
    `${context}: ${response.status} - ${body}`,
    service,
    { meta: { status: response.status } },
  );
}
