/* ============================================================
   lib/session.ts — wallet sessions for Rare Friends (replaces Privy).

   SERVER ONLY. Sign-in is EIP-4361 (Sign-In with Ethereum) on Robinhood chain:
     1. GET  /api/auth/nonce   -> a short-lived, HMAC-signed nonce token
     2. the wallet signs a SIWE message naming the chosen Friend (requestId)
     3. POST /api/auth/verify  -> signature verified (EOA or ERC-1271 smart
        wallet, via viem), then FriendSDK's readGenerationEligibility must say
        the signer owns that hardwired Friend. Issues a session token.

   The PLAYER IDENTITY IS THE FRIEND ("friend:<tokenId>"), not the wallet: per
   FriendSDK, items and rewards belong to the NFT, so a sold Friend takes its
   (mock) RF balance, inventory and leaderboard history with it.

   Bearer header ONLY (never cookies) — same CSRF reasoning as before: a bearer
   token isn't auto-attached cross-site.
   ============================================================ */

import type { Address } from "viem";
import { signToken, verifyToken } from "./signedToken";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const NONCE_TTL_MS = 5 * 60 * 1000;

export interface SessionPayload {
  did: string; // "friend:<tokenId>"
  friendId: string; // decimal token id
  owner: Address; // wallet that signed in
  friendWallet: Address | null; // canonical token-bound account
  exp: number;
}

export interface VerifiedUser {
  did: string;
  friendId: bigint;
  owner: Address;
  friendWallet: Address | null;
}

export const friendDid = (friendId: bigint | string) => `friend:${BigInt(friendId).toString()}`;

/** Auth works whenever the signing secret is present (no third-party service). */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.SCORE_SIGNING_SECRET);
}

export function issueSession(p: Omit<SessionPayload, "exp" | "did">, now = Date.now()): {
  token: string;
  exp: number;
} {
  const exp = now + SESSION_TTL_MS;
  const token = signToken<SessionPayload>("session", { ...p, did: friendDid(p.friendId), exp });
  return { token, exp };
}

export function getAccessToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

/** Resolve the request's session, or null if missing/invalid/expired. */
export async function verifyRequest(req: Request): Promise<VerifiedUser | null> {
  const p = verifyToken<SessionPayload>("session", getAccessToken(req));
  if (!p || typeof p.friendId !== "string" || !/^[1-9]\d{0,77}$/.test(p.friendId)) return null;
  if (p.did !== friendDid(p.friendId)) return null;
  return { did: p.did, friendId: BigInt(p.friendId), owner: p.owner, friendWallet: p.friendWallet };
}
