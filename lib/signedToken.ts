/* ============================================================
   lib/signedToken.ts — purpose-scoped HMAC tokens (sessions, sign-in nonces).

   SERVER ONLY. Same format as lib/runToken.ts:
     base64url(JSON payload) + "." + base64url(HMAC-SHA256(purpose + "." + body))
   The purpose is mixed into the MAC, so a nonce token can never be replayed as
   a session token (or a run token) even though they share SCORE_SIGNING_SECRET.
   ============================================================ */

import { createHmac, timingSafeEqual } from "crypto";

export type TokenPurpose = "session" | "siwe-nonce";

function secret(): string {
  const s = process.env.SCORE_SIGNING_SECRET;
  if (!s) throw new Error("SCORE_SIGNING_SECRET is not set");
  return s;
}

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4), "base64");

function mac(purpose: TokenPurpose, body: string): string {
  return b64url(createHmac("sha256", secret()).update(`${purpose}.${body}`).digest());
}

/** Sign a payload; `exp` (epoch ms) is required so every token expires. */
export function signToken<T extends { exp: number }>(purpose: TokenPurpose, payload: T): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${mac(purpose, body)}`;
}

/** Verify signature + expiry. Returns the payload or null (never throws). */
export function verifyToken<T extends { exp: number }>(
  purpose: TokenPurpose,
  token: unknown,
  now: number = Date.now(),
): T | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  let expected: string;
  try {
    expected = mac(purpose, body);
  } catch {
    return null;
  }
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as T;
    if (typeof payload?.exp !== "number" || now > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
