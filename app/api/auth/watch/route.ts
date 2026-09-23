/* POST /api/auth/watch — READ-ONLY sign-in with a pasted wallet address.

   Body: { address, friendId }. No wallet, no signature. FriendSDK's
   readGenerationEligibility (fresh block, Robinhood chain) must confirm the
   address holds that hardwired Friend (generation >= 1). Issues an UNVERIFIED
   session for the separate "watch:<tokenId>" account — it can play, buy and
   enter pools with SIMULATED RF, but never touches the wallet-signed
   "friend:<tokenId>" account, and it's labelled read-only on every board. */

import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { isAuthConfigured, issueSession } from "@/lib/session";
import { checkFriendEligibility } from "@/lib/rf/ownership";
import { clientIp } from "@/lib/clientIp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hits = new Map<string, number[]>();
function limited(key: string, max = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > max;
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  if (!isAuthConfigured()) return bad("Auth not configured.", 503);
  if (limited(`watch:${clientIp(req) ?? "?"}`)) return bad("Too many attempts. Try again in a minute.", 429);

  const body = (await req.json().catch(() => null)) as { address?: unknown; friendId?: unknown } | null;
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  const idRaw = typeof body?.friendId === "string" ? body.friendId : "";
  if (!isAddress(address, { strict: false })) return bad("That isn't a valid wallet address.");
  if (!/^[1-9]\d{0,77}$/.test(idRaw)) return bad("Missing Friend id.");
  const owner = getAddress(address);
  const friendId = BigInt(idRaw);

  let elig;
  try {
    elig = await checkFriendEligibility(friendId, owner, { fresh: true });
  } catch {
    return bad("Couldn't read Friend ownership from Robinhood chain. Try again.", 502);
  }
  if (!elig.eligible) {
    if (elig.exists === false) return bad(`Rare Friend #${friendId} doesn't exist on Generations.`, 403);
    return bad(
      elig.generation < 1
        ? `Friend #${friendId} isn't hardwired yet (generation 0).`
        : `That address doesn't hold Friend #${friendId}.`,
      403,
    );
  }

  const { token, exp } = issueSession({
    friendId: friendId.toString(),
    owner,
    friendWallet: elig.friendWallet,
    verified: false,
  });
  return NextResponse.json({
    token,
    exp,
    verified: false,
    friendId: friendId.toString(),
    owner,
    friendWallet: elig.friendWallet,
    generation: elig.generation,
  });
}
