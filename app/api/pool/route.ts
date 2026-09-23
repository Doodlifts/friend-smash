/* GET /api/pool — today's ranked prize pool (SIMULATED RF), public.

   { day, closesAt, settlesAt, pot, entries, entryFee, poolShare, burnPerEntry,
     standings[{rank, friendId, handle, score, projectedPrize}], me?, yesterday?,
     totals{burned, prizesPaid, faucetIssued} }
   Amounts are integer units (1 = 1 RF). Reading also settles any pool
   whose payout time has passed (lazy, idempotent). */

import { NextResponse } from "next/server";
import { getDb, isDbConfigured, type DrizzleDb } from "@/lib/db";
import { verifyRequest } from "@/lib/session";
import { getUserByDid } from "@/lib/users";
import { poolStatus } from "@/lib/rf/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isDbConfigured()) return NextResponse.json({ configured: false }, { status: 503 });
  const db = getDb() as DrizzleDb;
  const session = await verifyRequest(req);
  const user = session ? await getUserByDid(db, session.did) : null;
  const status = await poolStatus(db, { userId: user?.id ?? null });
  // Never leak internal user ids publicly.
  const strip = <T extends { userId: string }>(r: T) => {
    const { userId, ...rest } = r;
    return { ...rest, you: user ? userId === user.id : false };
  };
  return NextResponse.json(
    {
      ...status,
      standings: status.standings.map(strip),
      yesterday: status.yesterday ? { ...status.yesterday, winners: status.yesterday.winners.map(strip) } : null,
      simulated: true,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
