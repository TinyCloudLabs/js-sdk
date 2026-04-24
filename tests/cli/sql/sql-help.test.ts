import { describe, expect, test } from "bun:test";
import { TC_BIN } from "../setup";

async function tcHelp(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", TC_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TC_HIDE_BANNER: "1", NODE_ENV: "test" },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

describe("tc sql help", () => {
  test("explains SQL workflows and subcommands", async () => {
    const result = await tcHelp("sql", "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("SQLite database operations for your TinyCloud space");
    expect(result.stdout).toContain("TinyCloud SQL gives each space isolated SQLite databases");
    expect(result.stdout).toContain("tc sql execute \"CREATE TABLE IF NOT EXISTS notes");
    expect(result.stdout).toContain("--params accepts a JSON array");
    expect(result.stdout).toContain("export    Download the raw SQLite database file");
  });

  test("explains query parameters and output", async () => {
    const result = await tcHelp("sql", "query", "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Run a read-only SELECT query");
    expect(result.stdout).toContain("Bind parameters as a JSON array for ? placeholders");
    expect(result.stdout).toContain("{ \"columns\": string[], \"rows\": unknown[][], \"rowCount\": number }");
  });

  test("explains execute examples", async () => {
    const result = await tcHelp("sql", "execute", "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Run a write or schema statement");
    expect(result.stdout).toContain("INSERT INTO notes (body) VALUES (?)");
    expect(result.stdout).toContain("Returns JSON with the changed row count");
  });
});
