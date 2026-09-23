/* POST /api/match/place — play my TURF WAR turn.

   Body: { matchId, moveN, t, r, x }
   No run token needed: the server holds the entire game state and referees
   the move under the match row lock (turn, deadline, piece, geometry).
   moveN makes retries idempotent. Returns the fresh view so the client can
   render the result without waiting for the next poll. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { placeTurfMove, matchStateFor } from "@/lib/match";
import { TURF_RULES_V } from "@/lib/turf";
import type { PieceType } from "@/lib/rng";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const body = (await req.json().catch(() => null)) as {
    matchId?: string;
    moveN?: number;
    t?: string;
    r?: number;
    x?: number;
    y?: number;
    rulesV?: number;
  } | null;
  if (!body?.matchId || typeof body.moveN !== "number" || typeof body.t !== "string" ||
      typeof body.r !== "number" || typeof body.x !== "number" || typeof body.y !== "number") {
    return NextResponse.json({ error: "Missing matchId, moveN, t, r, x, or y." }, { status: 400 });
  }
  // Deploy-skew guard: a stale bundle playing by old rules must not fumble
  // moves into shot-clock forfeits — tell it to reload itself instead.
  if (body.rulesV !== TURF_RULES_V) {
    return NextResponse.json({ ok: false, stale: true, error: "rules updated — reload" });
  }
  const result = await placeTurfMove(ctx.db, {
    matchId: body.matchId,
    userId: ctx.user.id,
    moveN: Math.trunc(body.moveN),
    t: body.t as PieceType,
    r: Math.trunc(body.r),
    x: Math.trunc(body.x),
    y: Math.trunc(body.y),
  });
  const view = await matchStateFor(ctx.db, ctx.user.id);
  return NextResponse.json({ ...result, view });
}
