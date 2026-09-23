/* /api/powerups

   GET  -> { catalog, balance?, inventory? }
           Catalog is always available (static). Balance + inventory are added
           when the request is authenticated and the DB is configured.
   POST -> purchase one power-up. Body: { key, purchaseId }.
           Transactional + idempotent on purchaseId. 402 on insufficient funds.

   RF here is SIMULATED (server-tracked ledger) — see lib/rf/ledger.ts. */

import { NextResponse } from "next/server";
import { authedContext, isResponse } from "@/lib/apiAuth";
import { verifyRequest } from "@/lib/session";
import { getDb, isDbConfigured } from "@/lib/db";
import { getBalance } from "@/lib/economy";
import { CATALOG, getInventory, purchasePowerup } from "@/lib/powerups";
import { upsertFriendUser } from "@/lib/users";
import { isPurchaseLimited } from "@/lib/rateLimit";
import { logRateLimit } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const publicCatalog = CATALOG.filter((p) => p.active).map((p) => ({
  key: p.key,
  name: p.name,
  description: p.description,
  price: p.price,
  effect: p.effect,
}));

export async function GET(req: Request) {
  const base = { catalog: publicCatalog, mock: true };
  // Best-effort enrich with the user's balance + inventory when possible.
  if (isDbConfigured()) {
    const verified = await verifyRequest(req);
    if (verified) {
      const db = getDb()!;
      const user = await upsertFriendUser(db, verified);
      const [balance, inventory] = await Promise.all([
        getBalance(db, user.id),
        getInventory(db, user.id),
      ]);
      return NextResponse.json({ ...base, balance, inventory });
    }
  }
  return NextResponse.json(base);
}

export async function POST(req: Request) {
  const ctx = await authedContext(req);
  if (isResponse(ctx)) return ctx;

  if (await isPurchaseLimited(ctx.db, ctx.user.id)) {
    logRateLimit({ route: "powerups", userId: ctx.user.id, scope: "user" });
    return NextResponse.json(
      { error: "Slow down — too many purchases. Try again in a moment." },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as { key?: string; purchaseId?: string } | null;
  if (!body || typeof body.key !== "string" || typeof body.purchaseId !== "string") {
    return NextResponse.json({ error: "Missing key or purchaseId." }, { status: 400 });
  }

  const result = await purchasePowerup(ctx.db, {
    userId: ctx.user.id,
    key: body.key,
    purchaseId: body.purchaseId,
  });

  if (!result.ok) {
    const insufficient = /enough/i.test(result.error || "");
    return NextResponse.json({ error: result.error }, { status: insufficient ? 402 : 400 });
  }
  return NextResponse.json(result);
}
