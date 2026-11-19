import { z } from "zod";
import { ErrorCodes, err } from "../types";
import type { Result, ServiceError } from "../types";
import type { FeedResponse } from "./types";

const timestamp = z.string().datetime({ offset: true });
export function validDispatchBefore(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && timestamp.safeParse(value).success && Number.isFinite(Date.parse(value)));
}
export function dispatchDeadlineDenied(response: FeedResponse): boolean {
  const cutoff: unknown = response.dispatchBefore;
  return cutoff !== undefined && (!validDispatchBefore(cutoff) || (typeof cutoff === "string" && Date.now() >= Date.parse(cutoff)));
}
export function dispatchDeadlineFailure(): Result<never> {
  return err({ code: ErrorCodes.PERMISSION_DENIED, service: "feed", message: "The response dispatch deadline does not permit a new handoff.", meta: { reason: "dispatch_deadline" } });
}
export function isDispatchDeadlineFailure(error: ServiceError): boolean {
  return error.service === "feed" && error.code === ErrorCodes.PERMISSION_DENIED && error.meta?.reason === "dispatch_deadline";
}
