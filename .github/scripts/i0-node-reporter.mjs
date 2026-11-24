// One Node test file per invocation. Attribute helper-defined test results to
// the runtime's completed file wrapper, never to planned argv or helper paths.
export default async function* executedFiles(events) {
  let file;
  let executed = false;
  let skipped = false;
  for await (const { type, data } of events) {
    if (type === "test:complete" && data.file && data.name === data.file) {
      file = data.file;
    }
    if ((type === "test:pass" || type === "test:fail") &&
        data.name !== data.file && data.details?.type !== "suite") {
      if (data.skip || data.todo) skipped = true;
      else executed = true;
    }
  }
  if (file && executed) yield `${JSON.stringify({ file, skipped: false })}\n`;
  if (file && skipped) yield `${JSON.stringify({ file, skipped: true })}\n`;
}
