import type { Tier } from './peers.js';

/**
 * The complete set of flags the reader may attach to a queue record. Nothing else is emitted; the `Flag` type is derived
 * from these keys, so an unlisted flag does not compile. `severity` is `hard`, `soft`, or `tiered`. A `tiered` flag is soft
 * for the trusted tier and hard for every other tier; `severityFor` resolves it. The reader records the flags; the gate
 * decides what each severity means.
 */
export const FLAG_TABLE = {
  'too-long': { severity: 'tiered', description: 'text is over 8000 UTF-16 units; the text is still queued' },
  link: { severity: 'soft', description: 'a URL-like string is present' },
  instruction: { severity: 'soft', description: 'matches the fixed instruction-phrase table' },
  request: { severity: 'soft', description: 'asks the reader or its principal to take an action (fixed verb-phrase table)' },
  'secret-request': { severity: 'hard', description: 'asks for keys, tokens, passwords or credentials' },
  encoded: { severity: 'hard', description: 'a long base64- or hex-looking run is present' },
  unicode: { severity: 'hard', description: 'shared text verdict: not-nfc, disallowed-code-point, edge-whitespace, not-string or empty' },
  size: { severity: 'hard', description: 'original text exceeded the 16 KiB queue cap and was cut at a code-point boundary' },
  rate: { severity: 'hard', description: 'peer is over its inbound per-hour cap' },
} as const satisfies Record<string, { severity: 'hard' | 'soft' | 'tiered'; description: string }>;

export type Flag = keyof typeof FLAG_TABLE;

/** The severity a flag has for a peer's tier. `tiered` flags are soft for `trusted` and hard otherwise. */
export function severityFor(flag: Flag, tier: Tier): 'hard' | 'soft' {
  const severity = FLAG_TABLE[flag].severity;
  if (severity !== 'tiered') return severity;
  return tier === 'trusted' ? 'soft' : 'hard';
}
