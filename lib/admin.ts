/* lib/admin.ts — admin gating for the ops dashboard.

   SERVER ONLY. Admins are an env allowlist of WALLET addresses (ADMIN_WALLETS,
   comma-separated). A request is admin iff its session verifies and the wallet
   that signed in is on the allowlist. Returns the appropriate error Response
   otherwise (503 unconfigured / 401 unauthed / 403 not admin). */

import { NextResponse } from "next/server";
import { verifyRequest, isAuthConfigured } from "./session";
import { getDb, isDbConfigured, type DrizzleDb } from "./db";

/** Parsed ADMIN_WALLETS allowlist (lowercased). Read at call time. */
export function adminWallets(): string[] {
  return (process.env.ADMIN_WALLETS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminWallet(address: string | null | undefined): boolean {
  if (!address) return false;
  return adminWallets().includes(address.trim().toLowerCase());
}

export interface AdminCtx {
  db: DrizzleDb;
  did: string;
  wallet: string;
}

/** Guard for admin-only routes. Returns AdminCtx or an error NextResponse. */
export async function adminContext(req: Request): Promise<AdminCtx | NextResponse> {
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
  // Pasted-address (read-only) sessions never prove control of a wallet, so
  // they can never be admin — only wallet-SIGNED sessions count.
  if (!verified.verified || !isAdminWallet(verified.owner)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  return { db: getDb() as DrizzleDb, did: verified.did, wallet: verified.owner };
}
