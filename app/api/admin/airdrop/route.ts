/* POST /api/admin/airdrop — grant simulated RF to EVERY current user.

   Admin-gated. MOCK ledger only (same rail as the shop; on-chain stays
   deferred — CLAUDE.md money rule). Idempotent by construction: one ledger
   row per (user, 'grant', ref) via the unique guard, so re-clicking the
   button or retrying a timeout can never double-pay anyone. A new ref
   (e.g. a new date) is a new airdrop. */

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { adminContext } from "@/lib/admin";
import { users } from "@/db/schema";
import { airdropAll } from "@/lib/economy";
import { logInfo } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AIRDROP = 100_000;

export async function POST(req: Request) {
  const ctx = await adminContext(req);
  if (ctx instanceof NextResponse) return ctx;

  const body = (await req.json().catch(() => null)) as { amount?: number; ref?: string } | null;
  const amount = Math.floor(Number(body?.amount));
  if (!Number.isFinite(amount) || amount < 1 || amount > MAX_AIRDROP) {
    return NextResponse.json({ error: `Amount must be 1–${MAX_AIRDROP.toLocaleString()}.` }, { status: 400 });
  }
  const refRaw = (typeof body?.ref === "string" && body.ref.trim() ? body.ref : new Date().toISOString().slice(0, 10)).trim();
  if (!/^[\w.:-]{1,64}$/.test(refRaw)) {
    return NextResponse.json({ error: "Ref must be 1–64 chars: letters, digits, . : _ -" }, { status: 400 });
  }
  const refId = `airdrop:${refRaw}`;

  // One atomic CTE in lib/economy.airdropAll — the SAME function verify-db
  // exercises, so the tested SQL is the shipped SQL (review catch).
  const grantedN = await airdropAll(ctx.db, amount, refId);

  const [total] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users);
  logInfo("admin.airdrop", { admin: ctx.wallet, amount, refId, granted: grantedN });
  return NextResponse.json({
    ok: true,
    granted: grantedN,
    skipped: (Number(total?.n) || 0) - grantedN,
    totalUsers: Number(total?.n) || 0,
    refId,
    message:
      grantedN > 0
        ? `Granted ${amount.toLocaleString()} RF to ${grantedN} user${grantedN === 1 ? "" : "s"}` +
          (grantedN < (Number(total?.n) || 0) ? ` (${(Number(total?.n) || 0) - grantedN} already had ref ${refId})` : "") + "."
        : `Nobody granted — every user already received ref ${refId}. Use a new ref for a fresh airdrop.`,
  });
}
