/* POST /api/run/powerup — settle a power-up USE the moment it happens.

   Body: { runId, runToken, key, n }  (n = cumulative uses of `key` this run)
   Decrements inventory immediately so a reload / killed tab can never refund a
   spent power-up. Idempotent on n (retries and out-of-order reports are
   no-ops); finish/abandon reconcile against what was settled here. Token-
   verified like finish/abandon; only an OPEN run owned by the caller settles.

   No dedicated rate limiter (deliberate): every call is Bearer-authed +
   token-bound to the caller's OWN open run, n is capped, and the row lock it
   takes is on the caller's own run row — flooding it burns the attacker's
   auth quota without touching anyone else. Revisit if abuse shows up in logs. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { verifyRunToken } from "@/lib/runToken";
import { consumePowerupUse } from "@/lib/runs";
import { MAX_RUN_AGE_MS } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;

  const body = (await req.json().catch(() => null)) as {
    runId?: string;
    runToken?: string;
    key?: string;
    n?: number;
  } | null;
  if (!body || !body.runId || !body.runToken || !body.key || typeof body.n !== "number") {
    return NextResponse.json({ error: "Missing runId, runToken, key or n." }, { status: 400 });
  }
  const payload = verifyRunToken(body.runToken, { maxAgeMs: MAX_RUN_AGE_MS });
  if (!payload || payload.runId !== body.runId || payload.userId !== ctx.user.id) {
    return NextResponse.json({ error: "Invalid or expired run token." }, { status: 403 });
  }

  const result = await consumePowerupUse(ctx.db, {
    runId: body.runId,
    userId: ctx.user.id,
    key: body.key,
    n: body.n,
  });
  return NextResponse.json(result);
}
