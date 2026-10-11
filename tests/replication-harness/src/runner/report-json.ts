import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunReportSchema } from "../schemas/report";
import type { RunReport } from "../contracts/report";
import { redactValue } from "./redact";
import { renderReportMarkdown } from "./report-md";

export async function writeLegReport(report: RunReport, directory: string, secrets: readonly string[] = []): Promise<void> {
  await mkdir(directory, { recursive: true });
  const sanitized = redactValue(report, secrets);
  const validated = RunReportSchema.parse(sanitized) as RunReport;
  await writeFile(join(directory, "report.json"), `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(directory, "report.md"), renderReportMarkdown(validated, secrets), { mode: 0o600 });
}
