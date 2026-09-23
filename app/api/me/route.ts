/* /api/me — the authenticated user's profile.

   GET  -> { authenticated, did, friendId, owner, friendWallet, handle, rfBalance }
   POST -> set handle. Body: { handle }. Re-validated + profanity-checked
           server-side; 409 if taken.

   503 if auth or the DB isn't configured; 401 if the token is missing/invalid.
   The RF balance is a SIMULATED, server-tracked value (no on-chain anything). */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { setHandle, getUserById } from "@/lib/users";
import { getInventory } from "@/lib/powerups";
import { grantFromFaucet } from "@/lib/rf/ledger";
import { STARTER_GRANT } from "@/lib/rf/economy-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  // One-time SIMULATED starter grant per Friend (idempotent), standing in for
  // "bought some RF" so ranked entries and upgrades are playable in the demo.
  const starter = await grantFromFaucet(ctx.db, ctx.user.id, STARTER_GRANT, "starter_grant", "starter");
  const inventory = await getInventory(ctx.db, ctx.user.id);
  return NextResponse.json({
    authenticated: true,
    did: ctx.did,
    handle: ctx.user.handle,
    rfBalance: starter.applied ? starter.toBalance : ctx.user.rfBalance,
    starterGranted: starter.applied,
    friendId: ctx.user.friendId,
    owner: ctx.user.ownerAddress,
    friendWallet: ctx.user.friendWallet,
    inventory,
    mock: true,
  });
}

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;

  const body = (await req.json().catch(() => null)) as
    | { handle?: string }
    | null;
  if (!body || typeof body.handle !== "string") {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  {
    const result = await setHandle(ctx.db, ctx.user.id, body.handle);
    if (!result.ok) {
      const status = result.tooSoon ? 429 : result.error === "That name is taken." ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
  }

  const fresh = await getUserById(ctx.db, ctx.user.id);
  return NextResponse.json({
    authenticated: true,
    did: ctx.did,
    handle: fresh?.handle ?? null,
    rfBalance: fresh?.rfBalance ?? 0,
    friendId: fresh?.friendId ?? null,
    owner: fresh?.ownerAddress ?? null,
    friendWallet: fresh?.friendWallet ?? null,
    mock: true,
  });
}
