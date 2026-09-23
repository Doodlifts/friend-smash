/* lib/apiAuth.ts — shared guard for authenticated API routes.

   Resolves the request into { db, user } or returns the appropriate error
   Response (503 if auth/DB unconfigured, 401 if the token is missing/invalid).
   Upserts the user row on every authed request so the rest of the app can
   assume it exists. */

import { NextResponse } from "next/server";
import { isAuthConfigured, verifyRequest, type VerifiedUser } from "./session";
import { getDb, isDbConfigured, type DrizzleDb } from "./db";
import { upsertFriendUser } from "./users";
import type { User } from "@/db/schema";

export interface AuthCtx {
  db: DrizzleDb;
  user: User;
  did: string;
  /** The signed-in Friend + wallet (from the session). */
  session: VerifiedUser;
}

export async function authedContext(req: Request): Promise<AuthCtx | NextResponse> {
  if (!isAuthConfigured()) {
    return NextResponse.json({ configured: false, error: "Auth not configured." }, { status: 503 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ configured: false, error: "Database not configured." }, { status: 503 });
  }
  const verified = await verifyRequest(req);
  if (!verified) {
    return NextResponse.json({ authenticated: false, error: "Unauthorized." }, { status: 401 });
  }
  const db = getDb() as DrizzleDb;
  const user = await upsertFriendUser(db, verified);
  return { db, user, did: verified.did, session: verified };
}

export function isResponse(x: AuthCtx | NextResponse): x is NextResponse {
  return x instanceof NextResponse;
}
