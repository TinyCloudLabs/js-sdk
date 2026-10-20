/**
 * The complete set of flags the reader may attach to a queue record. Nothing else is emitted. Severity is decided by
 * the gate, not recorded here.
 */
export const FLAG_TABLE = {
  'too-long': 'text is over 2000 UTF-16 units (shared text verdict)',
  link: 'a URL-like string is present',
  instruction: 'matches the fixed instruction-phrase table',
  request: 'asks the reader or its principal to take an action (fixed verb-phrase table)',
  'secret-request': 'asks for keys, tokens, passwords or credentials',
  encoded: 'a long base64- or hex-looking run is present',
  unicode: 'shared text verdict: not-nfc, disallowed-code-point, edge-whitespace, not-string or empty',
  size: 'original text exceeded the 16 KiB queue cap and was truncated at a code-point boundary',
  rate: 'peer is over its inbound per-hour cap',
} as const;

export type Flag = keyof typeof FLAG_TABLE;
