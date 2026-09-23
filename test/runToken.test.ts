import { test } from "node:test";
import assert from "node:assert/strict";

// Set before importing — runToken reads the secret at call time, so a static
// import is fine (and top-level await isn't supported under tsx's CJS output).
process.env.SCORE_SIGNING_SECRET = "test-secret-do-not-use-in-prod";
import { signRunToken, verifyRunToken, isSigningConfigured } from "../lib/runToken";

const payload = { runId: "run-1", userId: "user-1", seed: 12345, issuedAt: 1_000_000 };

test("isSigningConfigured reflects env", () => {
  assert.equal(isSigningConfigured(), true);
});

test("sign + verify round-trips", () => {
  const token = signRunToken(payload);
  const out = verifyRunToken(token);
  assert.deepEqual(out, payload);
});

test("a tampered body is rejected", () => {
  const token = signRunToken(payload);
  const [body, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ ...payload, seed: 99999 }),
    "utf8",
  ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(verifyRunToken(`${forged}.${sig}`), null);
  assert.ok(body); // body referenced
});

test("a tampered signature is rejected", () => {
  const token = signRunToken(payload);
  const [body] = token.split(".");
  assert.equal(verifyRunToken(`${body}.AAAA`), null);
});

test("malformed tokens are rejected, not thrown", () => {
  assert.equal(verifyRunToken(""), null);
  assert.equal(verifyRunToken("noseparator"), null);
  assert.equal(verifyRunToken(".sig"), null);
});

test("expiry: maxAgeMs rejects old tokens", () => {
  const token = signRunToken(payload);
  // not expired
  assert.ok(verifyRunToken(token, { maxAgeMs: 10_000, now: payload.issuedAt + 5_000 }));
  // expired
  assert.equal(verifyRunToken(token, { maxAgeMs: 10_000, now: payload.issuedAt + 20_000 }), null);
});

test("a token signed with a different secret fails", () => {
  const token = signRunToken(payload);
  const prev = process.env.SCORE_SIGNING_SECRET;
  process.env.SCORE_SIGNING_SECRET = "a-different-secret";
  assert.equal(verifyRunToken(token), null);
  process.env.SCORE_SIGNING_SECRET = prev;
});
