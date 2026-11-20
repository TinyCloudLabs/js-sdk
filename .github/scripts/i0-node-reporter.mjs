// Second Node reporter: only runner-observed test results, never the planned argv.
// The TAP reporter still streams the full human-readable results to stdout.
export default async function* executedFiles(events) {
  const files = new Set();
  for await (const { type, data } of events) {
    const skipped = Boolean(data.skip || data.todo);
    const key = `${data.file}:${skipped}`;
    if ((type === "test:pass" || type === "test:fail") && data.file && !files.has(key)) {
      files.add(key);
      yield `${JSON.stringify({ file: data.file, skipped })}\n`;
    }
  }
}
