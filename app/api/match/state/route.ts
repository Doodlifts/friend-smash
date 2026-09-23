/* GET /api/match/state — the VERSUS poll. Returns the caller's queue/match
   view and, as a side effect, advances liveness (expired-round forfeits,
   dead-match aborts). Either player's poll moves the match forward — there is
   no cron. Polled every ~2s by clients in the lobby or a match. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { matchStateFor } from "@/lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const view = await matchStateFor(ctx.db, ctx.user.id);
  return NextResponse.json(view);
}
