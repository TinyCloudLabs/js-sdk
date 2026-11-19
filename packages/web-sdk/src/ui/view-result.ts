import type { PermissionAbility, ViewResult } from "./data";

// Constructors for the read states in `data.ts`. Views build their results
// through these so every state carries the same shape.

export function viewLoading<T>(): ViewResult<T> {
  return { state: "loading" };
}

export function viewReady<T>(data: T): ViewResult<T> {
  return { state: "ready", data };
}

export function viewNeedsPermission<T>(ability: PermissionAbility): ViewResult<T> {
  return { state: "needs-permission", ability };
}

export function viewError<T>(code: string): ViewResult<T> {
  return { state: "error", code };
}
