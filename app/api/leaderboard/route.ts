/* GET /api/leaderboard?period=all|weekly|daily&limit=&offset=

   Public, read-heavy. Returns ranked best-score-per-user rows joined to handles.
   Edge-cached briefly (read-heavy; staleness of a few seconds is fine). */

import { NextResponse } from "next/server";
import { getDb, isDbConfigured } from "@/lib/db";
import { getLeaderboard, type Period } from "@/lib/leaderboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERIODS: Period[] = ["all", "weekly", "daily"];

export async function GET(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { configured: false, rows: [], message: "Leaderboard not configured yet." },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const periodParam = url.searchParams.get("period") as Period | null;
  const period: Period = periodParam && PERIODS.includes(periodParam) ? periodParam : "all";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  try {
    const db = getDb()!;
    const rows = await getLeaderboard(db, { period, limit, offset });
    return NextResponse.json(
      { period, rows },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
    );
  } catch (e) {
    return NextResponse.json({ error: "Failed to load leaderboard.", rows: [] }, { status: 500 });
  }
}
