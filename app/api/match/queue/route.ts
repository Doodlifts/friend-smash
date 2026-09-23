/* /api/match/queue — VERSUS matchmaking queue.

   POST { wager } → join (or retier) the queue at a MOCK-$SMASH wager tier and
   attempt an immediate pairing. DELETE → leave the queue. Wager escrow happens
   only at pairing time, so leaving the queue never needs a refund. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { isSigningConfigured } from "@/lib/runToken";
import { joinQueue, leaveQueue } from "@/lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  if (!isSigningConfigured()) {
    return NextResponse.json({ error: "Versus not configured." }, { status: 503 });
  }
  const body = (await req.json().catch(() => null)) as { wager?: number; mode?: string } | null;
  const wager = Math.trunc(Number(body?.wager ?? 0)) || 0;
  const mode = body?.mode === "turf" ? "turf" : "speed";
  const res = await joinQueue(ctx.db, ctx.user.id, wager, mode);
  if (res.state === "error") return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res);
}

export async function DELETE(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  await leaveQueue(ctx.db, ctx.user.id);
  return NextResponse.json({ ok: true });
}
