import { describe, expect, it } from "bun:test";
import {
  classifyRegistryLookup,
  type RegistryLookupResponse,
  type RegistryVerdict,
} from "./registry-verdict";

type VectorResponse =
  | { kind: "http"; status: number; body: string; trailingSpaces?: number }
  | { kind: "network-error" }
  | { kind: "timeout" };

interface Vector {
  name: string;
  subject: string;
  rememberedSequence: number | null;
  response: VectorResponse;
  expected: Record<string, unknown>;
}

interface VectorFile {
  subjects: { owner: string };
  vectors: Vector[];
}

// Shape fixed by the file's `rules`; a malformed file fails the assertions below.
const vectorFile = (await Bun.file(
  `${import.meta.dir}/../test-vectors/registry-verdict/registry-verdict-v1.json`,
).json()) as VectorFile;
const vectors = vectorFile.vectors;

function toResponse(response: VectorResponse): RegistryLookupResponse {
  if (response.kind !== "http") return response;
  return {
    kind: "http",
    status: response.status,
    body: response.body + " ".repeat(response.trailingSpaces ?? 0),
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
  it("covers all three states", () => {
    const statuses = new Set(vectors.map((vector) => vector.expected.status));
    expect([...statuses].sort()).toEqual(["registered", "unavailable", "unregistered"]);
  });

  for (const vector of vectors) {
    it(vector.name, async () => {
      const verdict = await classifyRegistryLookup(vector.subject, toResponse(vector.response), {
        rememberedSequence: vector.rememberedSequence,
      });
      expect(verdict.subject).toBe(vector.subject);
      expect(contractFields(verdict)).toEqual(vector.expected);
    });
  }
});

describe("classifyRegistryLookup inputs", () => {
  const owner = vectorFile.subjects.owner;
  const notFound = { kind: "http", status: 404, body: '{"error":"location record not found"}' } as const;

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects rememberedSequence %p",
    async (rememberedSequence) => {
      await expect(classifyRegistryLookup(owner, notFound, { rememberedSequence })).rejects.toThrow(TypeError);
    },
  );

  it.each(["", "did:web:example.com", "0xabc"])("rejects subject %p", async (subject) => {
    await expect(classifyRegistryLookup(subject, notFound)).rejects.toThrow(TypeError);
  });
});
