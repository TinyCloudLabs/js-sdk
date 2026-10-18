import { describe, expect, it } from "bun:test";
import {
  RegistryLookupInputError,
  classifyRegistryLookup,
  type RegistryLookupResponse,
  type RegistryVerdict,
} from "./registry-verdict";

type BodyPart = string | { repeat: string; count: number };

type VectorResponse =
  | { kind: "http"; status: number; body: string | BodyPart[] }
  | { kind: "network-error" }
  | { kind: "timeout" };

interface Vector {
  name: string;
  subject: string;
  /** Input-error vectors also carry non-numbers; they are passed through unchanged. */
  rememberedSequence: number | null;
  response: VectorResponse;
  expected: Record<string, unknown>;
}

interface VectorFile {
  vectors: Vector[];
}

// Shape fixed by the file's `rules`; a malformed file fails the assertions below.
const vectorFile = (await Bun.file(
  `${import.meta.dir}/../test-vectors/registry-verdict/registry-verdict-v1.json`,
).json()) as VectorFile;

function toResponse(response: VectorResponse): RegistryLookupResponse {
  if (response.kind !== "http") return response;
  const parts = typeof response.body === "string" ? [response.body] : response.body;
  return {
    kind: "http",
    status: response.status,
    body: parts.map((part) => (typeof part === "string" ? part : part.repeat.repeat(part.count))).join(""),
  };
}

// The contract fields; `message` is diagnostic only and `subject` is the input.
function contractFields(verdict: RegistryVerdict): Record<string, unknown> {
  switch (verdict.status) {
    case "registered":
      return { status: verdict.status, source: verdict.source, sequence: verdict.sequence, hosts: verdict.hosts };
    case "unregistered":
      return { status: verdict.status, source: verdict.source, hosts: verdict.hosts };
    case "unavailable":
      return { status: verdict.status, source: verdict.source, reason: verdict.reason, hosts: verdict.hosts };
  }
}

describe("registry verdict vectors", () => {
  for (const vector of vectorFile.vectors) {
    it(vector.name, async () => {
      const run = classifyRegistryLookup(vector.subject, toResponse(vector.response), {
        rememberedSequence: vector.rememberedSequence,
      });
      if ("error" in vector.expected) {
        const error = await run.then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(RegistryLookupInputError);
        expect((error as RegistryLookupInputError).code).toBe(vector.expected.error as RegistryLookupInputError["code"]);
        return;
      }
      const verdict = await run;
      expect(verdict.subject).toBe(vector.subject);
      expect(contractFields(verdict)).toEqual(vector.expected);
    });
  }
});
