/* POST /api/run/abandon — report a quit/restarted ranked run.

   Body: { runId, runToken, log? }
   No score, no leaderboard row — but power-ups USED before quitting are
   consumed (capped at owned), so abandoning a run can't refund them. Token-
   verified like finish; idempotent (only an open run abandons once). */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { verifyRunToken } from "@/lib/runToken";
import { abandonRun } from "@/lib/runs";
import { MAX_RUN_AGE_MS, isRunFinishLimited, isIpRunFinishLimited } from "@/lib/rateLimit";
import { clientIp } from "@/lib/clientIp";
import { logRateLimit } from "@/lib/log";
import type { InputEvent } from "@/lib/anticheat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;

  // Shares the finish-rate budget (abandons set finishedAt too).
  const ip = clientIp(req);
  const [userLimited, ipLimited] = await Promise.all([
    isRunFinishLimited(ctx.db, ctx.user.id),
    isIpRunFinishLimited(ctx.db, ip),
  ]);
  if (userLimited || ipLimited) {
    logRateLimit({ route: "run/abandon", userId: ctx.user.id, ip, scope: userLimited ? "user" : "ip" });
    return NextResponse.json({ error: "Slow down." }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as {
    runId?: string;
    runToken?: string;
    log?: InputEvent[];
  } | null;
  if (!body || !body.runId || !body.runToken) {
    return NextResponse.json({ error: "Missing runId or runToken." }, { status: 400 });
  }
  const payload = verifyRunToken(body.runToken, { maxAgeMs: MAX_RUN_AGE_MS });
  if (!payload || payload.runId !== body.runId || payload.userId !== ctx.user.id) {
    return NextResponse.json({ error: "Invalid or expired run token." }, { status: 403 });
  }

  const result = await abandonRun(ctx.db, { runId: body.runId, userId: ctx.user.id, log: body.log });
  return NextResponse.json(result);
}
