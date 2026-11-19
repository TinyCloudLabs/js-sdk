import { afterEach, describe, expect, test } from "bun:test";
import { configureShareCommandServices } from "./share.js";
import { runShareCaptured } from "./share.integration-harness.js";

afterEach(() => configureShareCommandServices({}));

async function runRefusal(args: readonly string[]) {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
  try {
    const result = await runShareCaptured(["share", "publish", ...args, "--json"]);
    return { ...result, exitCode: exitCode ?? result.exitCode, error: JSON.parse(result.stderr).error as { code: string; message: string } };
  } finally { process.exit = originalExit; }
}

function expectUnavailable(result: Awaited<ReturnType<typeof runRefusal>>): void {
  expect(result.error.code).toBe("UNAVAILABLE");
  expect(result.exitCode).toBe(4);
  expect(result.error.message).toMatch(/unavailable|not available/i);
}

describe("exact-email publication release refusal", () => {
  test.each(["person@example.com", "email:person@example.com"])("refuses %s before missing input or credential files are read", async (target) => {
    let creates = 0;
    configureShareCommandServices({ targetAdapter: { publish: async () => { creates++; throw new Error("publisher must not be reached"); } } });
    const result = await runRefusal([
      "/nonexistent/tc2202-never-read-source", "--to", target,
      "--credential-descriptor", "/nonexistent/tc2202-never-read-descriptor.json",
      "--issuer-did", "did:web:issuer.credentials.org", "--issuer-kid", "did:web:issuer.credentials.org#controller",
    ]);
    expectUnavailable(result);
    expect(creates).toBe(0);
  });

  test("refuses no-flags exact email before stdin is consumed", async () => {
    let creates = 0;
    let read = false;
    configureShareCommandServices({ targetAdapter: { publish: async () => { creates++; throw new Error("publisher must not be reached"); } } });
    const stdin = process.stdin as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> };
    const original = stdin[Symbol.asyncIterator];
    stdin[Symbol.asyncIterator] = () => { read = true; throw new Error("stdin must not be read"); };
    try {
      expectUnavailable(await runRefusal(["-", "--name", "note.md", "--to", "person@example.com", "--notify"]));
    } finally { stdin[Symbol.asyncIterator] = original; }
    expect(read).toBe(false);
    expect(creates).toBe(0);
  });

  test.each(["anyone", "domain:example.com", "did:key:z6MkggtHVWQUGJ3FVjJKXeb5oZThQvLmJVMV8hfNUz4ezcav"])("keeps credential-option refusal for %s", async (target) => {
    let creates = 0;
    configureShareCommandServices({ targetAdapter: { publish: async () => { creates++; throw new Error("publisher must not be reached"); } } });
    const result = await runRefusal(["/nonexistent/tc2202-never-read-source", "--to", target,
      "--credential-descriptor", "/nonexistent/tc2202-never-read-descriptor.json"]);
    expect(result.error.code).toBe("INVALID_ARGUMENT");
    expect(result.exitCode).toBe(2);
    expect(creates).toBe(0);
  });
});
