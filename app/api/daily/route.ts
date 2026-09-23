/* /api/daily — the once-per-day play bonus (simulated RF).

   GET  -> { claimedToday, streak, amount, balance } (read-only status)
   POST -> claim today's bonus. Idempotent by UTC date (a second POST the same
           day returns awarded:false). { awarded, amount, streak, balance }

   RF is a MOCKED, server-tracked balance — no on-chain anything. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { getDailyStatus, claimDaily } from "@/lib/daily";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const status = await getDailyStatus(ctx.db, ctx.user.id);
  return NextResponse.json({ ...status, mock: true });
}

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const claim = await claimDaily(ctx.db, ctx.user.id);
  return NextResponse.json({ ...claim, mock: true });
}
