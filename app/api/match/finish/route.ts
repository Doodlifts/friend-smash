/* POST /api/match/finish — submit my side of the current VERSUS round.

   Body: { matchId, runId, runToken, summary, log }
   Same trust model as /api/run/finish: the signed run token binds
   {runId, userId, seed}; the score is RE-COMPUTED by deterministic replay.
   Versus extras: power-ups in the log reject the round, the duration must fit
   the 60s window, and a rejected replay scores 0 (the match continues — the
   cheat just loses the round). Uses the run-finish rate limiter. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { verifyRunToken } from "@/lib/runToken";
import { finishVersusRound } from "@/lib/match";
import { MAX_RUN_AGE_MS, isRunFinishLimited, isIpRunFinishLimited } from "@/lib/rateLimit";
import { clientIp } from "@/lib/clientIp";
import { logRateLimit } from "@/lib/log";
import type { RunSummary, InputEvent } from "@/lib/anticheat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;

  const ip = clientIp(req);
  const [userLimited, ipLimited] = await Promise.all([
    isRunFinishLimited(ctx.db, ctx.user.id),
    isIpRunFinishLimited(ctx.db, ip),
  ]);
  if (userLimited || ipLimited) {
    logRateLimit({ route: "match/finish", userId: ctx.user.id, ip, scope: userLimited ? "user" : "ip" });
    return NextResponse.json({ error: "Slow down — too many submissions." }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as {
    matchId?: string;
    runId?: string;
    runToken?: string;
    summary?: RunSummary;
    log?: InputEvent[];
  } | null;
  if (!body?.matchId || !body.runId || !body.runToken || !body.summary) {
    return NextResponse.json({ error: "Missing matchId, runId, runToken, or summary." }, { status: 400 });
  }

  const payload = verifyRunToken(body.runToken, { maxAgeMs: MAX_RUN_AGE_MS });
  if (!payload || payload.runId !== body.runId || payload.userId !== ctx.user.id) {
    return NextResponse.json({ error: "Invalid or expired run token." }, { status: 403 });
  }

  const result = await finishVersusRound(ctx.db, {
    matchId: body.matchId,
    userId: ctx.user.id,
    runId: body.runId,
    summary: body.summary,
    log: body.log,
  });
  return NextResponse.json(result);
}
