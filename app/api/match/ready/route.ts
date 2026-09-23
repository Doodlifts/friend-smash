/* POST /api/match/ready — the ready-up gate. Body: { matchId }.
   Round/game 1 (and every clock) is minted only when BOTH players have
   tapped READY; an unreadied match aborts with refunds after the staging
   timeout. Idempotent per player. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { markReady, matchStateFor } from "@/lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const body = (await req.json().catch(() => null)) as { matchId?: string } | null;
  if (!body?.matchId) return NextResponse.json({ error: "Missing matchId." }, { status: 400 });
  const ok = await markReady(ctx.db, body.matchId, ctx.user.id);
  const view = await matchStateFor(ctx.db, ctx.user.id);
  return NextResponse.json({ ok, view });
}
