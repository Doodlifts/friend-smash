/* ============================================================
   lib/economy.ts — balance helpers over the SIMULATED RF ledger.

   ⚠️  SIMULATED RF ONLY (1 unit = 1 RF). All movements are double-entry
   transfers — see lib/rf/ledger.ts (accounts, invariants) and
   lib/rf/settlement.ts (the on-chain swap-in point). earn() now draws from
   the simulated faucet and spend() burns; nothing is minted from thin air.

   The `ledger` table is the source of truth (append-only). `users.rf_balance`
   is a cached sum kept in step with each ledger insert INSIDE a transaction.
   Every mutation is idempotent on (userId, reason, refId). Money is integers.
   ============================================================ */

import { eq, sql } from "drizzle-orm";
import { isUniqueViolation, type DrizzleDb } from "./db";
import { users, ledger } from "@/db/schema";
import { InsufficientFundsError, grantFromFaucet, burnTx } from "./rf/ledger";

export { InsufficientFundsError };

export interface LedgerResult {
  /** true if this delta was newly applied; false if it was a duplicate (idempotent). */
  applied: boolean;
  balance: number;
}

export async function getBalance(db: DrizzleDb, userId: string): Promise<number> {
  const [u] = await db.select({ b: users.rfBalance }).from(users).where(eq(users.id, userId)).limit(1);
  return Number(u?.b ?? 0);
}

/**
 * Apply a signed delta to a user's balance, recorded in the ledger. Atomic and
 * idempotent: a repeat of the same (userId, reason, refId) is a no-op. Rejects
 * (throws InsufficientFundsError) if a debit would drive the balance negative.
 */
export async function applyLedger(
  db: DrizzleDb,
  params: { userId: string; delta: number; reason: string; refId?: string | null },
): Promise<LedgerResult> {
  const { userId, delta, reason } = params;
  const refId = params.refId ?? null;
  if (!Number.isInteger(delta)) throw new Error("ledger delta must be an integer");

  return db.transaction(async (tx) => {
    // Lock the user row to serialize concurrent balance changes.
    const locked = await tx
      .select({ b: users.rfBalance })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    const u = locked[0];
    if (!u) throw new Error("user not found");
    const current = Number(u.b);

    if (delta < 0 && current + delta < 0) throw new InsufficientFundsError();

    // Idempotency guard: unique (userId, reason, refId). On conflict, no-op.
    let inserted;
    try {
      inserted = await tx
        .insert(ledger)
        .values({ userId, delta, reason, refId })
        .onConflictDoNothing({ target: [ledger.userId, ledger.reason, ledger.refId] })
        .returning();
    } catch (e) {
      if (isUniqueViolation(e)) return { applied: false, balance: current };
      throw e;
    }
    if (!inserted.length) return { applied: false, balance: current };

    const newBalance = current + delta;
    await tx.update(users).set({ rfBalance: newBalance }).where(eq(users.id, userId));
    return { applied: true, balance: newBalance };
  });
}

/**
 * ADMIN TEST TOOL: grant `amount` simulated RF to EVERY Friend (not system accounts), idempotent per refId: one atomic
 * CTE writes the ledger row (ON CONFLICT (user,reason,ref) DO NOTHING) and
 * bumps the denormalized users.rf_balance for exactly the granted rows.
 * Returns how many users were granted (0 = everyone already had this ref).
 *
 * Known, accepted edges (mock rail, admin-gated, self-healing):
 *  - a deadlock with a two-user wager escrow tx aborts one side; both are
 *    retry-safe (escrow re-attempts via polls, the airdrop is idempotent);
 *  - callers must pass a STABLE refId per intended airdrop — a per-request
 *    date default can double-grant across a UTC midnight re-click.
 */
export async function airdropAll(db: DrizzleDb, amount: number, refId: string): Promise<number> {
  const res = (await db.execute(sql`
    WITH granted AS (
      INSERT INTO ledger (user_id, delta, reason, ref_id)
      SELECT id, ${amount}, 'grant', ${refId} FROM users WHERE did NOT LIKE 'system:%'
      ON CONFLICT ON CONSTRAINT ledger_user_reason_ref_uniq DO NOTHING
      RETURNING user_id
    )
    UPDATE users SET rf_balance = rf_balance + ${amount}
    WHERE id IN (SELECT user_id FROM granted)
    RETURNING id
  `)) as unknown as { rows?: unknown[] } | unknown[];
  return (Array.isArray(res) ? res : (res.rows ?? [])).length;
}

/** Credit simulated RF from the faucet (e.g. daily claim). Idempotent on refId. */
export async function earn(
  db: DrizzleDb,
  userId: string,
  amount: number,
  reason: string,
  refId?: string | null,
): Promise<LedgerResult> {
  const r = await grantFromFaucet(db, userId, Math.abs(Math.trunc(amount)), reason, refId ?? reason);
  return { applied: r.applied, balance: r.toBalance };
}

/** Burn RF from a Friend. Throws InsufficientFundsError if too low. */
export async function spend(
  db: DrizzleDb,
  userId: string,
  amount: number,
  reason: string,
  refId?: string | null,
): Promise<LedgerResult> {
  const r = await db.transaction((tx) =>
    burnTx(tx as unknown as DrizzleDb, userId, Math.abs(Math.trunc(amount)), reason, refId ?? reason),
  );
  return { applied: r.applied, balance: r.fromBalance };
}

/**
 * Per-run rewards are GATED OFF by default. Per the RF economy, GAMEPLAY DOES
 * NOT MINT the token — players acquire RF by buying it and win it from daily/
 * weekly leaderboard pools, then SPEND it in the store. Set RUN_REWARD_ENABLED=1
 * to re-enable per-run minting (e.g. a temporary testnet faucet). Read at call
 * time so it toggles by env without a rebuild. See [[doopie-smash-tokenomics]].
 */
export function runRewardsEnabled(): boolean {
  return process.env.RUN_REWARD_ENABLED === "1";
}

/**
 * Reward curve for a verified run, used only when run rewards are enabled.
 * 1 RF per 25 score points + 10 per line cleared, capped to keep balances
 * sane. (Pure — kept for the faucet path + tests.)
 */
export function runReward(score: number, lines: number): number {
  const raw = Math.floor(Math.max(0, score) / 25) + Math.max(0, lines) * 10;
  return Math.min(raw, 5000);
}
