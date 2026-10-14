/** Only code-owned tool names/codes and numeric counters reach this sink. */
export function logToolCall(
  tool: string,
  code: string,
  startedAt: number,
  replayedGrants: number,
): void {
  process.stderr.write(`${JSON.stringify({
    tool,
    code,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    replayedGrants,
  })}\n`);
}
