import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setJsonOutputRequested, withSpinner } from "./formatter.js";

type Overridable = "isTTY" | "columns";
const streams = [process.stdout, process.stderr] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const savedEnv = { CI: process.env.CI, TERM: process.env.TERM };
const savedWrite = process.stderr.write;
let stderrWrites: string[] = [];

// ora animates from a real setInterval, so the step has to span real frames.
async function realDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function setStream(stream: NodeJS.WriteStream, name: "stdout" | "stderr", key: Overridable, value: boolean | number): void {
  const id = `${name}.${key}`;
  if (!saved.has(id)) saved.set(id, Object.getOwnPropertyDescriptor(stream, key));
  Object.defineProperty(stream, key, { value, configurable: true, writable: true });
}

function terminal(columns: number, tty = true): void {
  setStream(process.stdout, "stdout", "isTTY", tty);
  setStream(process.stdout, "stdout", "columns", columns);
  setStream(process.stderr, "stderr", "isTTY", tty);
  setStream(process.stderr, "stderr", "columns", columns);
}

beforeEach(() => {
  stderrWrites = [];
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
  for (const [id, descriptor] of saved) {
    const [name, key] = id.split(".") as ["stdout" | "stderr", Overridable];
    const stream = name === "stdout" ? streams[0] : streams[1];
    if (descriptor) Object.defineProperty(stream, key, descriptor);
    else delete (stream as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setJsonOutputRequested(false);
});

describe("withSpinner", () => {
  test("animates on a normal terminal", async () => {
    terminal(80);
    const result = await withSpinner("Generating key...", async () => {
      await realDelay(300);
      return 7;
    });
    expect(result).toBe(7);
    // start frame + several 80 ms frames + final line, each with cursor control.
    expect(stderrWrites.length).toBeGreaterThan(4);
    expect(stderrWrites.join("")).toContain("\x1b[");
  });

  test("a terminal reporting 0 columns gets one plain line and no escape codes", async () => {
    terminal(0);
    const result = await withSpinner("Generating key...", async () => {
      await realDelay(300);
      return 7;
    });
    expect(result).toBe(7);
    expect(stderrWrites).toEqual(["Generating key...\n"]);
  });

  test("a failing step on a 0-column terminal writes one line and rethrows", async () => {
    terminal(0);
    await expect(withSpinner("Generating key...", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(stderrWrites).toEqual(["Generating key... failed\n"]);
  });

  test("a non-TTY stdout writes nothing", async () => {
    terminal(80, false);
    await withSpinner("Generating key...", async () => {
      await realDelay(300);
    });
    expect(stderrWrites).toEqual([]);
  });
});
