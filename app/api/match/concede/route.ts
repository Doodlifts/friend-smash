/* POST /api/match/concede — quit the match. The opponent wins and the
   MOCK-$SMASH escrow pays out to them immediately. Idempotent: a non-active
   match is a no-op. Body: { matchId }. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { concedeMatch } from "@/lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;
  const body = (await req.json().catch(() => null)) as { matchId?: string } | null;
  if (!body?.matchId) return NextResponse.json({ error: "Missing matchId." }, { status: 400 });
  const ok = await concedeMatch(ctx.db, body.matchId, ctx.user.id);
  return NextResponse.json({ ok });
}
