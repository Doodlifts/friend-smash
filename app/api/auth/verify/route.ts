/* POST /api/auth/verify — finish Sign-In with Ethereum for one Rare Friend.

   Body: { message, signature, nonceToken }
   The SIWE message must: be for THIS host, chain 4663, carry the nonce from
   nonceToken, and name the Friend as `Request ID: friend-<tokenId>`.
   Then (1) the signature is verified on Robinhood chain (EOA or ERC-1271), and
   (2) FriendSDK's readGenerationEligibility must confirm, at a fresh block,
   that the signer owns that Friend and it is hardwired (generation >= 1).
   Only then is a session issued. Nothing here signs, spends, or transfers. */

import { NextResponse } from "next/server";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { isAddress, type Hex } from "viem";
import { isAuthConfigured, issueSession } from "@/lib/session";
import { verifyToken } from "@/lib/signedToken";
import { rfPublicClient, RF_CHAIN_ID } from "@/lib/rf/chain";
import { checkFriendEligibility } from "@/lib/rf/ownership";
import { clientIp } from "@/lib/clientIp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Best-effort per-instance limiter (signature checks hit the public RPC).
const hits = new Map<string, number[]>();
function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length <= max;
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  if (!isAuthConfigured()) return bad("Auth not configured.", 503);
  if (!rateLimit(`auth:${clientIp(req) ?? "?"}`, 20, 60_000)) return bad("Too many sign-in attempts. Try again in a minute.", 429);

  const body = (await req.json().catch(() => null)) as
    | { message?: unknown; signature?: unknown; nonceToken?: unknown }
    | null;
  if (!body || typeof body.message !== "string" || typeof body.signature !== "string") {
    return bad("Missing message or signature.");
  }
  if (body.message.length > 2_000 || !/^0x[0-9a-fA-F]+$/.test(body.signature)) return bad("Malformed sign-in.");

  const nonce = verifyToken<{ nonce: string; exp: number }>("siwe-nonce", body.nonceToken);
  if (!nonce) return bad("Sign-in expired. Please try again.", 401);

  const msg = parseSiweMessage(body.message);
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const friendMatch = /^friend-([1-9]\d{0,77})$/.exec(msg.requestId ?? "");
  if (
    !msg.address ||
    !isAddress(msg.address) ||
    msg.chainId !== RF_CHAIN_ID ||
    !friendMatch ||
    !validateSiweMessage({ message: msg, domain: host, nonce: nonce.nonce })
  ) {
    return bad("This sign-in message isn't valid for this site.", 401);
  }

  const client = rfPublicClient();
  let sigOk = false;
  try {
    sigOk = await client.verifyMessage({ address: msg.address, message: body.message, signature: body.signature as Hex });
  } catch {
    return bad("Couldn't reach Robinhood chain to verify your signature. Try again.", 502);
  }
  if (!sigOk) return bad("Signature doesn't match that wallet.", 401);

  const friendId = BigInt(friendMatch[1]);
  let elig;
  try {
    elig = await checkFriendEligibility(friendId, msg.address, { fresh: true });
  } catch {
    return bad("Couldn't read Friend ownership from Robinhood chain. Try again.", 502);
  }
  if (!elig.eligible) {
    if (elig.exists === false) return bad(`Rare Friend #${friendId} doesn't exist on Generations.`, 403);
    return bad(
      elig.generation < 1
        ? `Friend #${friendId} isn't hardwired yet (generation 0). Hardwire it to play.`
        : `This wallet doesn't own Friend #${friendId}.`,
      403,
    );
  }

  const { token, exp } = issueSession({
    friendId: friendId.toString(),
    owner: msg.address,
    friendWallet: elig.friendWallet,
  });
  return NextResponse.json({
    token,
    exp,
    friendId: friendId.toString(),
    owner: msg.address,
    friendWallet: elig.friendWallet,
    generation: elig.generation,
  });
}
