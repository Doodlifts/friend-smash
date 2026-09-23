/* POST /api/pool/enter — pay the ranked entry for an open run.

   Body: { runId }. Auth required. Re-verifies on Robinhood chain (FriendSDK
   readGenerationEligibility) that the signed-in wallet STILL owns the Friend
   before charging: 0.40 RF → today's pool, 0.10 RF → burned (SIMULATED).
   Idempotent per run. 402 if the Friend can't afford it. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { enterPool } from "@/lib/rf/pool";
import { checkFriendEligibility } from "@/lib/rf/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const body = (await req.json().catch(() => null)) as { runId?: unknown } | null;
  const runId = typeof body?.runId === "string" ? body.runId : "";
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return NextResponse.json({ error: "Missing runId." }, { status: 400 });

  try {
    const elig = await checkFriendEligibility(ctx.session.friendId, ctx.session.owner);
    if (!elig.eligible) {
      return NextResponse.json({ error: "This wallet no longer owns that Friend." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Couldn't verify Friend ownership on Robinhood chain. Try again." }, { status: 502 });
  }

  const r = await enterPool(ctx.db, { userId: ctx.user.id, runId });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, day: r.day, balance: r.balance, duplicate: r.duplicate, simulated: true });
}
