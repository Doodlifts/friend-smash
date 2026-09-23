/* ============================================================
   lib/powerups.ts — power-up catalog + purchase/inventory (simulated RF, 100% burned).

   The catalog is defined in code (source of truth) and seeded into the
   `powerups` table so `inventory.powerup_key` FKs resolve.

   Two classes of power-up, both anti-cheat safe (see `replaySafe` below):
   • REPLAY-SAFE (slow_fall, next_peek, clean_slate): timing/info/cosmetic aids
     that don't change the authoritative score, piece sequence, or legal
     placements. They're declared in the input log; the server's replay ignores
     them for scoring and just consumes inventory.
   • BOARD/SEQUENCE-ALTERING (bomb, reroll): these DO change the replayed score,
     so the replay APPLIES their effects and the server ENFORCES entitlement —
     a run that uses more than the player owns is rejected before any score or
     reward is written (see lib/runs.ts ENFORCED_KEYS handling). Cross-validated
     against a captured live run. See PROGRESS.md.
   ============================================================ */

import { and, eq, gte, sql } from "drizzle-orm";
import { InsufficientFundsError, burnTx } from "./rf/ledger";
import { isUniqueViolation, type DrizzleDb } from "./db";
import { users, ledger, inventory, powerups } from "@/db/schema";

export type PowerupEffect = "timing" | "info" | "cosmetic" | "board" | "sequence";

export interface PowerupDef {
  key: string;
  name: string;
  description: string;
  price: number; // whole RF (simulated), 100% burned on purchase
  effect: PowerupEffect;
  active: boolean;
  /**
   * true  → no effect on score / piece sequence / legal placements; the replay
   *         ignores it and unauthorized usage is harmless (just clamped).
   * false → changes the board/sequence (and thus the replayed score); the
   *         replay APPLIES it and the server ENFORCES entitlement (a run that
   *         uses more than the player owns is rejected).
   */
  replaySafe: boolean;
}

export const CATALOG: PowerupDef[] = [
  {
    key: "slow_fall",
    name: "Nap Time",
    description: "Your Friend yawns — gravity slows way down for 15s.",
    price: 60,
    effect: "timing",
    active: true,
    replaySafe: true,
  },
  {
    key: "next_peek",
    name: "Friend Radar",
    description: "Peek at extra upcoming Friends for the rest of the run.",
    price: 40,
    effect: "info",
    active: true,
    replaySafe: true,
  },
  {
    key: "clean_slate",
    name: "Clean Slate",
    description: "Sweep the pixel shards off the board. Purely cosmetic.",
    price: 25,
    effect: "cosmetic",
    active: false, // nothing lingers to clean in the Rare Friends reskin
    replaySafe: true,
  },
  {
    key: "bomb",
    name: "Pixel Bomb",
    description: "Your next piece detonates a 3×3 blast — clear the junk around it.",
    price: 120,
    effect: "board",
    active: true,
    replaySafe: false,
  },
  {
    key: "reroll",
    name: "Swap Friend",
    description: "Don't like this piece? Swap it for the next one.",
    price: 50,
    effect: "sequence",
    active: true,
    replaySafe: false,
  },
];

/** Keys whose usage the server must verify against inventory (replay applies them). */
export const ENFORCED_KEYS = CATALOG.filter((p) => !p.replaySafe).map((p) => p.key);

export const CATALOG_BY_KEY: Record<string, PowerupDef> = Object.fromEntries(
  CATALOG.map((p) => [p.key, p]),
);

/** Upsert the code catalog into the powerups table (run from db:setup / tests). */
export async function seedPowerups(db: DrizzleDb): Promise<void> {
  for (const p of CATALOG) {
    await db
      .insert(powerups)
      .values({ key: p.key, name: p.name, description: p.description, price: p.price, active: p.active })
      .onConflictDoUpdate({
        target: powerups.key,
        set: { name: p.name, description: p.description, price: p.price, active: p.active },
      });
  }
}

export interface InventoryItem {
  key: string;
  qty: number;
}

export async function getInventory(db: DrizzleDb, userId: string): Promise<InventoryItem[]> {
  const rows = await db
    .select({ key: inventory.powerupKey, qty: inventory.qty })
    .from(inventory)
    .where(eq(inventory.userId, userId));
  return rows.map((r) => ({ key: r.key, qty: Number(r.qty) }));
}

export interface PurchaseResult {
  ok: boolean;
  balance: number;
  qty: number;
  duplicate?: boolean;
  error?: string;
}

/**
 * Buy one of a power-up. Atomic + idempotent on the client-supplied purchaseId
 * (a retry never double-charges). Rejects when funds are insufficient or the key
 * is unknown/inactive.
 */
export async function purchasePowerup(
  db: DrizzleDb,
  params: { userId: string; key: string; purchaseId: string },
): Promise<PurchaseResult> {
  const { userId, key, purchaseId } = params;
  const def = CATALOG_BY_KEY[key];
  if (!def || !def.active) return { ok: false, balance: 0, qty: 0, error: "Unknown power-up." };
  if (!purchaseId) return { ok: false, balance: 0, qty: 0, error: "Missing purchase id." };

  try {
    return await db.transaction(async (tx) => {
      const locked = await tx
        .select({ b: users.rfBalance })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      const u = locked[0];
      if (!u) return { ok: false, balance: 0, qty: 0, error: "User not found." };
      const balance = Number(u.b);

      const qtyOf = async () => {
        const inv = await tx
          .select({ q: inventory.qty })
          .from(inventory)
          .where(and(eq(inventory.userId, userId), eq(inventory.powerupKey, key)));
        return Number(inv[0]?.q ?? 0);
      };

      // 100% of the price is BURNED (simulated RF). Idempotent on purchaseId:
      // a retry is a no-op; insufficient funds throws and rolls back.
      const r = await burnTx(tx as unknown as DrizzleDb, userId, def.price, `purchase:${key}`, purchaseId);
      if (!r.applied) return { ok: true, balance, qty: await qtyOf(), duplicate: true };
      const newBalance = r.fromBalance;
      await tx
        .insert(inventory)
        .values({ userId, powerupKey: key, qty: 1 })
        .onConflictDoUpdate({
          target: [inventory.userId, inventory.powerupKey],
          set: { qty: sql`${inventory.qty} + 1` },
        });
      return { ok: true, balance: newBalance, qty: await qtyOf() };
    });
  } catch (e) {
    if (e instanceof InsufficientFundsError) {
      return { ok: false, balance: 0, qty: 0, error: "Not enough RF (simulated)." };
    }
    throw e;
  }
}

/**
 * Consume power-ups used during a run (from the input log's 'powerup' events),
 * within an existing transaction. Decrements inventory by what the player owns
 * (never below 0). Because these power-ups are replay-safe (no score effect),
 * unauthorized usage simply has no effect rather than rejecting the run.
 * Returns the usage actually applied. Must be called inside a tx.
 */
export async function consumePowerups(
  tx: DrizzleDb,
  userId: string,
  usage: Record<string, number>,
): Promise<Record<string, number>> {
  const applied: Record<string, number> = {};
  // Keys are consumed in SORTED order so two concurrent runs of the same user
  // always take inventory row locks in the same order — otherwise
  // {bomb, reroll} vs {reroll, bomb} could deadlock.
  for (const [key, want] of Object.entries(usage).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!CATALOG_BY_KEY[key] || want <= 0) continue;
    // LOCK the inventory row. Callers only lock their OWN run row, so two
    // parallel runs of one user did not serialize here: both plain-read
    // qty=1, both wrote the absolute value 0, and ONE purchased power-up got
    // consumed (and replay-applied) by BOTH runs — a real, client-reachable
    // duplication (concurrency audit, 2026-07-29). The lock makes the
    // read-modify-write below atomic per (user, key).
    const inv = await tx
      .select({ q: inventory.qty })
      .from(inventory)
      .where(and(eq(inventory.userId, userId), eq(inventory.powerupKey, key)))
      .for("update");
    const owned = Number(inv[0]?.q ?? 0);
    const take = Math.min(owned, want);
    if (take > 0) {
      // Relative write, guarded on the amount actually being there: correct
      // even if the lock above ever fails to hold.
      const dec = await tx
        .update(inventory)
        .set({ qty: sql`${inventory.qty} - ${take}` })
        .where(
          and(
            eq(inventory.userId, userId),
            eq(inventory.powerupKey, key),
            gte(inventory.qty, take),
          ),
        )
        .returning({ qty: inventory.qty });
      if (dec.length) applied[key] = take;
    }
  }
  return applied;
}
