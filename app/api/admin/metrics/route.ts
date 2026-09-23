/* GET /api/admin/metrics — read-only economy snapshot for the admin dashboard.

   Admin-gated (Privy email allowlist). Returns circulation, the simulated
   4-leg revenue split, and daily/weekly leaderboard pool previews — all mock,
   computed from the ledger. No fund movement. */

import { NextResponse } from "next/server";
import { adminContext } from "@/lib/admin";
import { getEconomyMetrics } from "@/lib/economyMetrics";
import { settlementMode } from "@/lib/rf/settlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await adminContext(req);
  if (ctx instanceof NextResponse) return ctx;

  const m = getEconomyMetrics();
  const [circulation, splitDaily, splitWeekly, splitAll, poolDaily, poolWeekly] = await Promise.all([
    m.circulation(ctx.db),
    m.splitPreview(ctx.db, "daily"),
    m.splitPreview(ctx.db, "weekly"),
    m.splitPreview(ctx.db, "all"),
    m.poolPreview(ctx.db, "daily", 10),
    m.poolPreview(ctx.db, "weekly", 25),
  ]);

  return NextResponse.json({
    source: m.source, // always "mock": RF is simulated in this build
    admin: ctx.wallet,
    circulation,
    split: { daily: splitDaily, weekly: splitWeekly, all: splitAll },
    pools: { daily: poolDaily, weekly: poolWeekly },
    onchain: {
      chain: "robinhood-4663",
      configured: false,
      settlement: settlementMode(), // "simulated" — see lib/rf/settlement.ts
    },
    mock: m.source === "mock",
  });
}
