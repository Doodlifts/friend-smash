/* lib/daily.ts — daily claim + streak (SIMULATED RF from the faucet).

   A small once-per-(UTC)-day reward to nudge return visits. Claiming is
   idempotent: the ledger row uses reason="daily_bonus", refId=UTC date string,
   so a second claim the same day is a no-op (see economy.earn → applyLedger).
   Streak = consecutive claimed UTC days ending today (or yesterday, if today
   isn't claimed yet — so the streak still reads as "alive" before you claim). */

import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "./db";
import { ledger } from "@/db/schema";
import { earn, getBalance } from "./economy";
import { DAILY_GRANT } from "./rf/economy-rules";

/** Simulated RF granted by the first claim each UTC day (1 RF). */
export const DAILY_BONUS = DAILY_GRANT;

/**
 * The daily bonus is GATED OFF by default. RF is a mock balance with no
 * treasury behind it, and issuance becomes a real liability only if pre-token
 * balances are ever honored 1:1. Until that tokenomics/treasury decision is
 * made, minting a daily bonus stays off. Flip DAILY_BONUS_ENABLED=1 to enable.
 * Read at call time so it can be toggled by env without a rebuild.
 */
export function dailyEnabled(): boolean {
  return process.env.DAILY_BONUS_ENABLED === "1";
}

const DAY_MS = 86_400_000;
/** UTC YYYY-MM-DD key for a date. */
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/** Set of UTC date keys on which this user has claimed the daily bonus. */
async function claimedDays(db: DrizzleDb, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ refId: ledger.refId })
    .from(ledger)
    .where(and(eq(ledger.userId, userId), eq(ledger.reason, "daily_bonus")));
  // Faucet refIds are namespaced "<userId>:<YYYY-MM-DD>" (lib/rf/ledger).
  return new Set(
    rows.map((r) => (typeof r.refId === "string" ? r.refId.slice(r.refId.lastIndexOf(":") + 1) : null)).filter((x): x is string => !!x),
  );
}

/** Consecutive claimed UTC days ending today, or yesterday if today isn't claimed. */
function streakFrom(days: Set<string>, now: Date): number {
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!days.has(dayKey(new Date(t)))) t -= DAY_MS; // today not claimed → anchor on yesterday
  let streak = 0;
  while (days.has(dayKey(new Date(t)))) {
    streak++;
    t -= DAY_MS;
  }
  return streak;
}

export interface DailyStatus {
  enabled: boolean;
  claimedToday: boolean;
  streak: number;
  amount: number;
  balance: number;
}

export async function getDailyStatus(
  db: DrizzleDb,
  userId: string,
  now: Date = new Date(),
): Promise<DailyStatus> {
  const days = await claimedDays(db, userId);
  const balance = await getBalance(db, userId);
  const enabled = dailyEnabled();
  return {
    enabled,
    claimedToday: days.has(dayKey(now)),
    streak: streakFrom(days, now),
    amount: enabled ? DAILY_BONUS : 0,
    balance,
  };
}

export interface DailyClaim {
  /** false if already claimed today (idempotent no-op). */
  awarded: boolean;
  amount: number;
  streak: number;
  balance: number;
}

export async function claimDaily(
  db: DrizzleDb,
  userId: string,
  now: Date = new Date(),
): Promise<DailyClaim> {
  // Disabled: never mint. Report the existing streak/balance so callers (and the
  // UI) behave, but award nothing.
  if (!dailyEnabled()) {
    const days = await claimedDays(db, userId);
    return { awarded: false, amount: 0, streak: streakFrom(days, now), balance: await getBalance(db, userId) };
  }
  const res = await earn(db, userId, DAILY_BONUS, "daily_bonus", dayKey(now));
  const days = await claimedDays(db, userId); // includes today after a fresh claim
  return { awarded: res.applied, amount: DAILY_BONUS, streak: streakFrom(days, now), balance: res.balance };
}
