// Preload (`node --require`) that reports Node.js 20, which has no built-in
// SQLite, so the `tc replica` runtime guard can be exercised on newer Node.
Object.defineProperty(process, "versions", { value: { ...process.versions, node: "20.18.0" } });
