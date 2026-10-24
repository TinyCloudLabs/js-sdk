// The Phase 1 checker reads failures from the junit report and the unhandled-error scan. Neither
// sees a `bun test` run that exits non-zero for another reason (a crashed runner, a truncated
// report, a signal), so the checker also fails on the run's exit status. The baseline is empty:
// any non-zero exit fails.
export const webSdkTestExitFailure = (status: number | null, signal: string | null): string | undefined => {
  if (signal !== null) return `web-sdk test run was killed by ${signal}`;
  if (status !== 0) return `web-sdk test run exited with status ${status ?? "null"}`;
  return undefined;
};
