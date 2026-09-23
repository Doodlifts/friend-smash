/* GET /api/auth/nonce — a fresh SIWE nonce plus an HMAC-signed token binding it
   to a 5-minute expiry. Stateless: /api/auth/verify checks the token instead
   of a nonce table. */

import { NextResponse } from "next/server";
import { generateSiweNonce } from "viem/siwe";
import { isAuthConfigured, NONCE_TTL_MS } from "@/lib/session";
import { signToken } from "@/lib/signedToken";
import { RF_CHAIN_ID } from "@/lib/rf/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAuthConfigured()) {
    return NextResponse.json({ configured: false, error: "Auth not configured." }, { status: 503 });
  }
  const nonce = generateSiweNonce();
  const exp = Date.now() + NONCE_TTL_MS;
  return NextResponse.json(
    { nonce, nonceToken: signToken("siwe-nonce", { nonce, exp }), chainId: RF_CHAIN_ID, exp },
    { headers: { "Cache-Control": "no-store" } },
  );
}
