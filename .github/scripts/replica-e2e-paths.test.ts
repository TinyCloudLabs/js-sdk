import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Guards replica-e2e-skip.yml (the no-op twin) against drifting from replica-e2e.yml.
const workflowsDir = new URL("../workflows/", import.meta.url);
const real = loadWorkflow("replica-e2e.yml");
const twin = loadWorkflow("replica-e2e-skip.yml");

type Matrix = Record<string, unknown[]>;
type Workflow = {
  on?: Record<string, any>;
  jobs: Record<string, { name?: string; strategy?: { matrix?: Matrix } }>;
};

function loadWorkflow(file: string): Workflow {
  const text = readFileSync(new URL(file, workflowsDir), "utf8");
  return Bun.YAML.parse(text) as Workflow;
}

function triggers(workflow: Workflow): Record<string, any> {
  // YAML 1.1 parsers read a bare `on` key as boolean true.
  const on = workflow.on ?? (workflow as Record<string | boolean, any>)[true];
  if (!on) throw new Error("workflow has no `on` triggers");
  return on;
}

// Expands `${{ matrix.KEY }}` in every job name, one name per matrix combination.
function jobNames(workflow: Workflow): string[] {
  return Object.values(workflow.jobs).flatMap((job) => {
    const matrix = job.strategy?.matrix ?? {};
    const combinations = Object.entries(matrix).reduce<Record<string, string>[]>(
      (acc, [key, values]) =>
        acc.flatMap((combo) => values.map((value) => ({ ...combo, [key]: String(value) }))),
      [{}],
    );
    return combinations.map((combo) =>
      (job.name ?? "").replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key: string) => {
        if (!(key in combo)) throw new Error(`job name references unknown matrix.${key}`);
        return combo[key] as string;
      }),
    );
  }).sort();
}

describe("replica e2e twin", () => {
  test("twin runs on pull_request only", () => {
    expect(Object.keys(triggers(twin))).toEqual(["pull_request"]);
  });

  test("twin paths-ignore equals the real workflow's pull_request paths, in order", () => {
    const realPaths = triggers(real).pull_request?.paths;
    const twinIgnore = triggers(twin).pull_request?.["paths-ignore"];
    expect(Array.isArray(realPaths)).toBe(true);
    expect(realPaths.length).toBeGreaterThan(0);
    expect(triggers(twin).pull_request?.paths).toBeUndefined();
    expect(twinIgnore).toEqual(realPaths);
  });

  test("twin job names equal the real workflow's job names, matrix expanded", () => {
    expect(jobNames(real).length).toBeGreaterThan(0);
    expect(jobNames(twin)).toEqual(jobNames(real));
  });
});
