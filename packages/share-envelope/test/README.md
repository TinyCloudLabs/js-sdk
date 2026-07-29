# Frozen interop vectors

`end-to-end.json` is the byte-level contract for the TinyCloud share-envelope
bearer slice. A future implementation in another language (specifically the
planned Rust verifier) MUST reproduce every derived field byte-for-byte from
the inputs. Do not regenerate these values casually: a change here is a
breaking wire-format change.

## Inputs (chosen, deterministic)

- `ed25519SeedHex` — 32-byte ed25519 seed (`0x07` × 32; the test key).
- `envelope` (minus `signature`) — the envelope body.
- `key32Hex` — 32-byte AES-256-GCM key (`00 01 … 1f`).
- `nonceHex` — 12-byte GCM nonce (`00 01 … 0b`). Production nonces are
  random; this one is fixed only so the vector is reproducible.
- `aadLabel` — fixed protocol-label AAD, authenticated on every envelope.

## Derived outputs (the contract)

- `signingJcsHex` — UTF-8 bytes of the canonical envelope signing domain
  (`xyz.tinycloud.share/envelope/v1\0`) followed by the RFC 8785 (JCS)
  canonical bytes of the envelope body (everything except `signature`). This
  is the ed25519 message.
- `signatureHex` / `envelope.signature` — deterministic RFC 8032 ed25519
  signature over `signingJcsHex`; `signerDid` is the did:key of the seed's
  public key. Verification is STRICT RFC 8032 (no ZIP-215 malleability).
- `plaintextJcsHex` — JCS bytes of the full signed envelope; this is the
  AEAD plaintext.
- `sealedBlobHex` — the canonical stored block:
  `version(0x01) || nonce(12) || AES-256-GCM ciphertext+tag`, with the
  `aadLabel` UTF-8 bytes as additional authenticated data.
- `cid` — CIDv1 / codec raw (0x55) / multihash sha2-256 (0x12), canonical
  lowercase base32, computed over the WHOLE sealed blob.
- `url` — `${origin}/s/${cid}#k=${base64url(key32)}` (unpadded base64url;
  key only ever in the fragment).

## Verification status

- JS side: `test/vectors.test.ts` recomputes every derived field from the
  inputs and asserts byte equality, then drives the recipient flow
  (parse URL → verify CID → open blob → strict-parse → verify signature
  against `expectedSignerDid`) from the frozen artifacts alone.
- Rust side: **deferred** — no Rust implementation exists yet. When it does,
  its test suite must consume this JSON file and reproduce/verify the same
  bytes. That cross-check is an explicit open item, not covered by CI today.
