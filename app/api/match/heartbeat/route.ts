/* POST /api/match/heartbeat — live score tick during a VERSUS round.

   Body: { matchId, round, score }. Display-only: the opponent's HUD shows it,
   but round outcomes use ONLY replay-verified scores. Atomic jsonb_set on the
   caller's slot — concurrent heartbeats from both players can't clobber each
   other. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { heartbeat } from "@/lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const body = (await req.json().catch(() => null)) as {
    matchId?: string;
    round?: number;
    score?: number;
  } | null;
  if (!body?.matchId || typeof body.round !== "number" || typeof body.score !== "number") {
    return NextResponse.json({ error: "Missing matchId, round, or score." }, { status: 400 });
  }
  await heartbeat(ctx.db, {
    matchId: body.matchId,
    userId: ctx.user.id,
    round: body.round,
    score: body.score,
  });
  return NextResponse.json({ ok: true });
}
