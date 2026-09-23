/* GET /api/user-matches — the authenticated player's versus record (per game
   mode) and finished-match history, newest first, for /stats. Read-only. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { myMatches, recordFor } from "@/lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const [record, matches] = await Promise.all([
    recordFor(ctx.db, ctx.user.id),
    myMatches(ctx.db, ctx.user.id, 15),
  ]);
  return NextResponse.json({ record, matches });
}
