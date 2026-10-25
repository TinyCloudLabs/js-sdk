import { freshnessCopy, type FreshnessCode } from "./freshness-copy";
import type { Freshness, ViewResult } from "../data";
import type { HostContext } from "../slots";
import { viewError, viewLoading } from "../view-result";

/** Status word for each non-ready state. Ready shows no line, so it has no entry. */
const STATE_WORD: Record<Exclude<ViewResult<unknown>["state"], "ready">, string> = {
  loading: "view.loading",
  "needs-permission": "view.permission",
  error: "view.error",
};

/** One status line and one retry, shared by a data-backed section. */
export interface StateLine {
  readonly status: HTMLParagraphElement;
  readonly retry: HTMLButtonElement;
}

/** A paragraph with one class and text. Sections use it for every text line. */
export function textLine(className: string, value: string): HTMLParagraphElement {
  const line = document.createElement("p");
  line.className = className;
  line.textContent = value;
  return line;
}

export function createStateLine(ctx: HostContext, onRetry: () => void): StateLine {
  const status = textLine("busy", "");
  status.setAttribute("role", "status");
  status.hidden = true;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "action";
  retry.textContent = ctx.text("view.retry");
  retry.hidden = true;
  retry.addEventListener("click", () => onRetry());

  return { status, retry };
}

/** Chip text for a ready result: updating, updated, or failed-with-age. */
function freshnessText(freshness: Freshness): string {
  if (freshness.refreshing) return freshnessCopy("freshness.updating");
  const age = formatAge(Date.now() - freshness.updatedAt);
  const code: FreshnessCode = freshness.lastError ? "freshness.failed" : "freshness.updated";
  return freshnessCopy(code).replace("{age}", age);
}

/** Relative age in the panel's own words. Minutes, hours, and days only. */
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return freshnessCopy("freshness.age.now");
  if (minutes < 60) return freshnessCopy("freshness.age.minutes").replace("{n}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return freshnessCopy("freshness.age.hours").replace("{n}", String(hours));
  return freshnessCopy("freshness.age.days").replace("{n}", String(Math.floor(hours / 24)));
}

/**
 * Shows the loading, permission, or error word for a non-ready result, and the
 * retry button for errors only. Returns the data when the result is ready.
 */
export function applyResult<T>(
  line: StateLine,
  ctx: HostContext,
  result: ViewResult<T>,
): T | undefined {
  if (result.state === "ready") {
    line.retry.hidden = true;
    const chip = result.freshness ? freshnessText(result.freshness) : undefined;
    line.status.hidden = chip === undefined;
    line.status.textContent = chip ?? "";
    return result.data;
  }
  line.status.hidden = false;
  line.status.textContent = ctx.text(STATE_WORD[result.state]);
  line.retry.hidden = result.state !== "error";
  return undefined;
}

/** The loading state, for the first paint before any read resolves. */
export function startLoading(line: StateLine, ctx: HostContext): void {
  applyResult(line, ctx, viewLoading());
}

/**
 * Runs a data read. A rejected or throwing read becomes an error result, so one
 * failing source cannot break the panel.
 */
export function settle<T>(read: () => Promise<ViewResult<T>>): Promise<ViewResult<T>> {
  return Promise.resolve()
    .then(read)
    .catch(() => viewError<T>("unknown"));
}
