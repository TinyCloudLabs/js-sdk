import type { RunReport, ScenarioResult } from "../contracts/report";
import { redactText } from "./redact";

function safe(value: string, secrets: readonly string[]): string {
  return redactText(value, secrets).replaceAll("|", "\\|").replaceAll("\n", " ");
}
function rowLink(result: ScenarioResult, secrets: readonly string[]): string {
  const failed = result.assertions.find((assertion) => !assertion.ok);
  const detail = failed ? ` — ${safe(failed.name, secrets)}${failed.detail === undefined ? "" : `: ${safe(JSON.stringify(failed.detail), secrets)}`}; artefacts: \`${safe(result.artefactDir, secrets)}\`` : "";
  return `| ${safe(result.key, secrets)} | ${result.status} | ${result.durationMs.toFixed(1)} | ${safe(result.reason ?? "", secrets)}${detail} |`;
}
export function renderReportMarkdown(report: RunReport, secrets: readonly string[] = []): string {
  const out = [
    `# Replication harness ${safe(report.kind, secrets)} report`,
    "",
    `- Run: \`${safe(report.runId, secrets)}\``,
    `- Subject: \`${safe(report.subject.sha, secrets)}\` (harness \`${safe(report.harnessSha, secrets)}\`)`,
    `- SUT: CLI ${safe(report.sut.cli.version, secrets)} (${safe(report.sut.cli.integrity ?? "integrity unavailable", secrets)}); node-sdk ${safe(report.sut.nodeSdk.version, secrets)} (${safe(report.sut.nodeSdk.integrity ?? "integrity unavailable", secrets)})`,
    `- Image: \`${safe(report.image.pinned, secrets)}\``,
    `- Backends: ${report.invocation.backends.join(", ")}`,
    "",
    "| Scenario | Status | Duration ms | Reason / first failure |",
    "|---|---:|---:|---|",
    ...report.results.map((result) => rowLink(result, secrets)),
    "",
    "## Metrics",
    "",
  ];
  for (const result of report.results) for (const metric of result.metrics) {
    out.push(`- ${safe(result.key, secrets)} / ${safe(metric.id, secrets)}: p50=${metric.p50} ${metric.unit}, p95=${metric.p95} ${metric.unit} (n=${metric.n})`);
  }
  if (report.baseline) {
    out.push("", "## Baseline regressions", "", ...report.baseline.regressions.map((r) => `- ${safe(r.metric, secrets)} ${r.stat}: ${r.observed} vs limit ${r.limit}`));
    out.push(...report.baseline.gaFailures.map((failure) => `- GA failure: ${safe(failure, secrets)}`));
  }
  return `${out.join("\n")}\n`;
}
