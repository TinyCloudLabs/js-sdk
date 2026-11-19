import { expect, test } from "bun:test";

import { publicJwk } from "./jwk";

test("publicJwk keeps only the public members of each asymmetric key type, plus kid", () => {
  expect(publicJwk({ kid: "session", kty: "OKP", crv: "Ed25519", x: "pub", d: "priv", alg: "EdDSA" }))
    .toEqual({ kid: "session", kty: "OKP", crv: "Ed25519", x: "pub" });
  expect(publicJwk({ kty: "EC", crv: "P-256", x: "px", y: "py", d: "priv", use: "sig" }))
    .toEqual({ kty: "EC", crv: "P-256", x: "px", y: "py" });
  expect(publicJwk({ kty: "RSA", n: "mod", e: "AQAB", d: "a", p: "b", q: "c", dp: "d", dq: "e", qi: "f", oth: [] }))
    .toEqual({ kty: "RSA", n: "mod", e: "AQAB" });
});

test("publicJwk refuses keys without a public form or with a missing public member", () => {
  expect(() => publicJwk({ kty: "oct", k: "secret" })).toThrow("has no public form");
  expect(() => publicJwk({ kty: "constructor", x: "pub" })).toThrow("has no public form");
  expect(() => publicJwk({ crv: "Ed25519", x: "pub", d: "priv" })).toThrow("has no public form");
  expect(() => publicJwk({ kty: "OKP", crv: "Ed25519", d: "priv" })).toThrow('public "x" member');
  expect(() => publicJwk({ kty: "EC", crv: "P-256", x: "px", d: "priv" })).toThrow('public "y" member');
  expect(() => publicJwk(Object.create({ kty: "OKP", crv: "Ed25519", x: "inherited" }))).toThrow("has no public form");
  expect(() => publicJwk(null)).toThrow("must be an object");
});
