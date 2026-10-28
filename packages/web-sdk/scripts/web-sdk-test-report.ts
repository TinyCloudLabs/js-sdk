// Pure parsing and merging for the Phase 1 checker's `bun test` runs. The web-sdk tests run as two
// Bun processes (the directory run, plus the DecryptExpiry file on its own: TC-2113), so the
// checker merges their junit cases, failures and unhandled-error signatures before it compares
// them with the baseline.

export type WebSdkRunReport = {
  caseCount: number;
  failedNames: string[];
  unhandledSignatures: string[];
  unhandledErrors: number;
};

const decode = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

export const parseWebSdkRun = (xml: string, output: string): WebSdkRunReport => {
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
  const failedNames = cases.flatMap(([, attributes, body]) => {
    if (!/<(?:failure|error)\b/.test(body ?? "")) return [];
    const name = attributes.match(/\bname="([^"]*)"/)?.[1];
    const file = attributes.match(/\bfile="([^"]*)"/)?.[1];
    return [decode(`${file ?? "unknown test file"}::${name ?? "unnamed test"}`)];
  });
  const unhandledSignatures = [...output.matchAll(/# Unhandled error between tests\n-{20,}\n([\s\S]*?)(?=\n-{20,}\n)/g)].map(([, block]) => {
    if (block.includes("ReferenceError: HTMLElement is not defined")) return "ReferenceError: HTMLElement is not defined";
    const message = block.match(/error:\s*(.+)/)?.[1] ?? "unidentified unhandled test error";
    if (message.includes("Cannot find package 'eth-testing'")) return "Cannot find package 'eth-testing'";
    if (message.includes("paired OpenCredentials worktree not found")) return "paired OpenCredentials worktree not found";
    return `unrecognized: ${message}`;
  });
  const unhandledErrors = Math.max(Number(output.match(/\b(\d+) errors?\b/i)?.[1] ?? 0), unhandledSignatures.length);
  return { caseCount: cases.length, failedNames, unhandledSignatures, unhandledErrors };
};

export const mergeWebSdkRuns = (runs: readonly WebSdkRunReport[]): WebSdkRunReport => ({
  caseCount: runs.reduce((total, run) => total + run.caseCount, 0),
  failedNames: runs.flatMap((run) => run.failedNames),
  unhandledSignatures: runs.flatMap((run) => run.unhandledSignatures),
  unhandledErrors: runs.reduce((total, run) => total + run.unhandledErrors, 0),
});

// The isolated file left the directory run, so a report with no cases means it did not run at all.
export const isolatedRunFailure = (label: string, caseCount: number): string | undefined =>
  caseCount === 0 ? `${label} run reported 0 test cases; the isolated file must really run` : undefined;
