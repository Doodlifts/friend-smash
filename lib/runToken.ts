/* ============================================================
   lib/runToken.ts — HMAC-signed run tokens (anti-cheat layer 1).

   SERVER ONLY. /api/run/start issues a token binding {runId, userId, seed,
   issuedAt}; /api/run/finish verifies it. The client cannot fabricate a run the
   server didn't sanction, replay a finished run, or tamper with the seed.

   Token format:  base64url(JSON payload) + "." + base64url(HMAC-SHA256)
   The secret is SCORE_SIGNING_SECRET — read at call time so it's never baked in.
   ============================================================ */

import { createHmac, timingSafeEqual } from "crypto";

export interface RunTokenPayload {
  runId: string;
  userId: string;
  seed: number;
  issuedAt: number; // epoch ms
}

export function isSigningConfigured(): boolean {
  return Boolean(process.env.SCORE_SIGNING_SECRET);
}

function secret(): string {
  const s = process.env.SCORE_SIGNING_SECRET;
  if (!s) throw new Error("SCORE_SIGNING_SECRET is not set");
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBuf(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmac(body: string): string {
  return b64url(createHmac("sha256", secret()).update(body).digest());
}

export function signRunToken(payload: RunTokenPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${hmac(body)}`;
}

export interface VerifyOptions {
  /** Reject tokens older than this many ms (run-token expiry, Phase 3). */
  maxAgeMs?: number;
  /** "Now" override for testing. Defaults to Date.now(). */
  now?: number;
}

/**
 * Verify a run token. Returns the payload if the signature is valid (and, if
 * maxAgeMs is given, not expired); otherwise null. Uses a constant-time
 * comparison to avoid signature-timing leaks.
 */
export function verifyRunToken(token: string, opts: VerifyOptions = {}): RunTokenPayload | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected: string;
  try {
    expected = hmac(body);
  } catch {
    return null; // secret not configured
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: RunTokenPayload;
  try {
    payload = JSON.parse(b64urlToBuf(body).toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload.runId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.seed !== "number" ||
    typeof payload.issuedAt !== "number"
  ) {
    return null;
  }
  if (opts.maxAgeMs != null) {
    const now = opts.now ?? Date.now();
    if (now - payload.issuedAt > opts.maxAgeMs) return null;
  }
  return payload;
}
