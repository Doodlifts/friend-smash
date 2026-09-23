/* POST /api/run/finish — submit a run for server-authoritative scoring.

   Body: { runId, runToken, summary, log? }
   The server verifies the signed run token, RE-COMPUTES the score (never trusts
   the client's number), runs sanity checks, records the run + leaderboard row,
   and returns the verified score + the player's rank. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { verifyRunToken } from "@/lib/runToken";
import { finishRun } from "@/lib/runs";
import { getUserRank } from "@/lib/leaderboard";
import { poolRank } from "@/lib/rf/pool";
import { MAX_RUN_AGE_MS, isRunFinishLimited, isIpRunFinishLimited } from "@/lib/rateLimit";
import { clientIp } from "@/lib/clientIp";
import { logRateLimit } from "@/lib/log";
import type { RunSummary, InputEvent } from "@/lib/anticheat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;

  // Rate limit submissions (per-user + per-IP) to reject floods before the
  // expensive replay. Best-effort (count-then-act): a concurrent burst may
  // exceed the cap briefly — fine here, since finishes are idempotent per run
  // and bounded upstream by the run-start limiter (see lib/rateLimit.ts).
  const ip = clientIp(req);
  const [userLimited, ipLimited] = await Promise.all([
    isRunFinishLimited(ctx.db, ctx.user.id),
    isIpRunFinishLimited(ctx.db, ip),
  ]);
  if (userLimited || ipLimited) {
    logRateLimit({ route: "run/finish", userId: ctx.user.id, ip, scope: userLimited ? "user" : "ip" });
    return NextResponse.json(
      { error: "Slow down — too many submissions. Try again in a moment." },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    runId?: string;
    runToken?: string;
    summary?: RunSummary;
    log?: InputEvent[];
  } | null;

  if (!body || !body.runId || !body.runToken || !body.summary) {
    return NextResponse.json({ error: "Missing runId, runToken, or summary." }, { status: 400 });
  }

  // Verify the run token binds to this run + user, isn't forged/tampered, and
  // hasn't expired (a game can't plausibly run longer than MAX_RUN_AGE_MS).
  const payload = verifyRunToken(body.runToken, { maxAgeMs: MAX_RUN_AGE_MS });
  if (!payload || payload.runId !== body.runId || payload.userId !== ctx.user.id) {
    return NextResponse.json({ error: "Invalid or expired run token." }, { status: 403 });
  }

  const result = await finishRun(ctx.db, {
    runId: body.runId,
    userId: ctx.user.id,
    summary: body.summary,
    log: body.log,
  });

  let rank: number | null = null;
  let poolRankNow: number | null = null;
  if (result.ok) {
    const r = await getUserRank(ctx.db, ctx.user.id, "all");
    rank = r?.rank ?? null;
    if (result.ranked && result.poolDay) {
      poolRankNow = (await poolRank(ctx.db, ctx.user.id, result.poolDay))?.rank ?? null;
    }
  }

  return NextResponse.json({ ...result, rank, poolRank: poolRankNow });
}
