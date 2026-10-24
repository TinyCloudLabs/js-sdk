import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The 0-column regression is an unbounded loop inside ora, so those tests stub
// ora and assert it is never constructed: a regression fails at once instead
// of hanging. The normal-terminal test runs the real ora.
const realOra = (await import("ora")).default;
// Dynamic imports on purpose: mock.module must be registered before formatter
// loads, and a static ora binding would be rewritten to the stub.
const oraLabels: string[] = [];
let useRealOra = false;
const stubSpinner = { start: () => stubSpinner, succeed: () => stubSpinner, fail: () => stubSpinner };
mock.module("ora", () => ({
  default: (label: string) => {
    oraLabels.push(label);
    return useRealOra ? realOra(label) : stubSpinner;
  },
}));
const { setJsonOutputRequested, withSpinner } = await import("./formatter.js");

type Overridable = "isTTY" | "columns";
const savedDescriptors: Record<string, PropertyDescriptor | undefined> = {};
const savedEnv = { CI: process.env.CI, TERM: process.env.TERM };
const savedWrite = process.stderr.write;
let stderrWrites: string[] = [];

function setStream(name: "stdout" | "stderr", key: Overridable, value: boolean | number): void {
  const stream = process[name];
  const id = `${name}.${key}`;
  if (!(id in savedDescriptors)) savedDescriptors[id] = Object.getOwnPropertyDescriptor(stream, key);
  Object.defineProperty(stream, key, { value, configurable: true, writable: true });
}

function terminal(stdoutColumns: number, stderrColumns: number = stdoutColumns, tty = true): void {
  setStream("stdout", "isTTY", tty);
  setStream("stdout", "columns", stdoutColumns);
  setStream("stderr", "isTTY", tty);
  setStream("stderr", "columns", stderrColumns);
}

// ora animates from a real setInterval, so the real-ora step must span real frames.
async function realDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

beforeEach(() => {
  stderrWrites = [];
  oraLabels.length = 0;
  useRealOra = false;
  setJsonOutputRequested(false);
  delete process.env.CI;
  process.env.TERM = "xterm";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = savedWrite;
  for (const [id, descriptor] of Object.entries(savedDescriptors)) {
    const [name, key] = id.split(".") as ["stdout" | "stderr", Overridable];
    if (descriptor) Object.defineProperty(process[name], key, descriptor);
    else delete (process[name] as unknown as Record<string, unknown>)[key];
    delete savedDescriptors[id];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setJsonOutputRequested(false);
});

describe("withSpinner", () => {
  test("animates on a normal terminal", async () => {
    terminal(80);
    useRealOra = true;
    const result = await withSpinner("Generating key...", async () => {
      await realDelay(300);
      return 7;
    });
    expect(result).toBe(7);
    expect(oraLabels).toEqual(["Generating key..."]);
    // start frame + several 80 ms frames + final line, each with cursor control.
    expect(stderrWrites.length).toBeGreaterThan(4);
    expect(stderrWrites.join("")).toContain("\x1b[");
  });

  test.each([
    ["both streams report 0", 0, 0],
    ["only stdout reports 0", 0, 80],
    ["only stderr reports 0", 80, 0],
  ])("%s: one plain line, ora never constructed", async (_name, stdoutColumns, stderrColumns) => {
    terminal(stdoutColumns, stderrColumns);
    const result = await withSpinner("Generating key...", async () => 7);
    expect(result).toBe(7);
    expect(oraLabels).toEqual([]);
    expect(stderrWrites).toEqual(["Generating key...\n"]);
  });

  test("a failing step on a 0-column terminal writes one line and rethrows", async () => {
    terminal(0);
    await expect(withSpinner("Generating key...", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(oraLabels).toEqual([]);
    expect(stderrWrites).toEqual(["Generating key... failed\n"]);
  });

  test("a non-TTY stdout writes nothing and never constructs ora", async () => {
    terminal(80, 80, false);
    await withSpinner("Generating key...", async () => 7);
    expect(oraLabels).toEqual([]);
    expect(stderrWrites).toEqual([]);
  });
});
