// Test-only. Freezes Date.now() at TC_TEST_NOW_MS (integer epoch ms) for a CLI
// subprocess, so a test can place it exactly at, or 1 ms before, a signed
// expiry. Every expiry decision on these paths reads Date.now(): node-sdk
// restore, the CLI import check, activation, and the WASM verifier through
// js_sys::Date::now. Never loaded outside tests.
const now = Number(process.env.TC_TEST_NOW_MS);
if (!Number.isSafeInteger(now)) throw new Error("TC_TEST_NOW_MS must be integer epoch milliseconds");
Date.now = () => now;
