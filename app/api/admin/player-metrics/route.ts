/* GET /api/admin/player-metrics — player health at a glance (admin-gated).

   DAU/WAU/MAU, retention, session quality, abandon rate, and $SMASH spend —
   all computed read-only from tables we already write (users/runs/ledger). */

import { NextResponse } from "next/server";
import { adminContext } from "@/lib/admin";
import { getPlayerMetrics } from "@/lib/playerMetrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await adminContext(req);
  if (ctx instanceof NextResponse) return ctx;

  const metrics = await getPlayerMetrics(ctx.db);
  return NextResponse.json({ admin: ctx.wallet, metrics });
}
