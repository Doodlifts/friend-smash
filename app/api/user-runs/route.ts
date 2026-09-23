/* GET /api/user-runs — the authenticated player's recent verified runs, newest
   first, for the run-history page (/stats). Read-only. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { recentRuns } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const runs = await recentRuns(ctx.db, ctx.user.id, 20);
  return NextResponse.json({ runs });
}
