/* ============================================================
   lib/economyMetrics.ts — read-only economy metrics for the admin dashboard.

   The MOCK provider computes everything from the `ledger` (source of truth) +
   the leaderboard. When the on-chain $SMASH economy ships, an OnChain provider
   implements this SAME interface (reading the vault / PDA / chain) and
   getEconomyMetrics() flips to it — the dashboard UI + types stay identical.

   NOTHING here moves funds; it's pure read + simulation.
   ============================================================ */

import { and, gte, like, sql } from "drizzle-orm";
import type { DrizzleDb } from "./db";
import { ledger, users } from "@/db/schema";
import { getLeaderboard, type Period } from "./leaderboard";

/** The proposed revenue split (the "four legs"). Simulation only, pre-token. */
export const REVENUE_SPLIT = { dood: 0.25, floor: 0.2, leaderboard: 0.35, team: 0.2 } as const;

function cutoff(period: Period, now: Date): Date | null {
  if (period === "daily") return new Date(now.getTime() - 24 * 3600 * 1000);
  if (period === "weekly") return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  return null;
}

export interface Circulation {
  /** Sum of all users' current balances. */
  held: number;
  /** Total simulated RF ever issued (faucet + admin grants) that still exists or was burned. */
  minted: number;
  /** Total RF burned (system:burn balance). */
  sinks: number;
}

export interface SplitPreview {
  spend: number;
  dood: number;
  floor: number;
  leaderboard: number;
  team: number;
}

export interface PoolEntry {
  rank: number;
  userId: string;
  handle: string | null;
  score: number;
  prize: number;
}

export interface PoolPreview {
  pool: number;
  entries: PoolEntry[];
}

export interface EconomyMetrics {
  source: "mock" | "onchain";
  circulation(db: DrizzleDb): Promise<Circulation>;
  storeSpend(db: DrizzleDb, period: Period, now?: Date): Promise<number>;
  splitPreview(db: DrizzleDb, period: Period, now?: Date): Promise<SplitPreview>;
  poolPreview(db: DrizzleDb, period: Period, topN?: number, now?: Date): Promise<PoolPreview>;
}

/** Distribute a pool across ranked entries with a top-heavy linear curve.
 *  Deterministic integer split; any rounding remainder goes to #1. Exported for
 *  unit testing. */
export function distributePool(pool: number, entries: PoolEntry[]): PoolEntry[] {
  const n = entries.length;
  if (n === 0 || pool <= 0) return entries.map((e) => ({ ...e, prize: 0 }));
  const weights = entries.map((_, i) => n - i); // n, n-1, …, 1
  const totalW = weights.reduce((a, b) => a + b, 0);
  let allocated = 0;
  const out = entries.map((e, i) => {
    const prize = Math.floor((pool * weights[i]) / totalW);
    allocated += prize;
    return { ...e, prize };
  });
  out[0].prize += pool - allocated; // remainder to first place
  return out;
}

export const mockEconomyMetrics: EconomyMetrics = {
  source: "mock",

  async circulation(db) {
    // Double-entry ledger (lib/rf/ledger): Friends hold `held`; RF burned sits
    // in system:burn; escrow/pools hold the rest; the faucet's negative balance
    // is what was issued. So: minted = held + burned + escrow + pools.
    const [held] = await db
      .select({ s: sql<number>`coalesce(sum(${users.rfBalance}),0)` })
      .from(users)
      .where(sql`${users.did} not like 'system:%'`);
    const [burned] = await db
      .select({ s: sql<number>`coalesce(sum(${users.rfBalance}),0)` })
      .from(users)
      .where(sql`${users.did} = 'system:burn'`);
    const [locked] = await db
      .select({ s: sql<number>`coalesce(sum(${users.rfBalance}),0)` })
      .from(users)
      .where(sql`${users.did} = 'system:escrow' or ${users.did} like 'system:pool:%'`);
    const h = Number(held?.s ?? 0);
    const sinks = Number(burned?.s ?? 0);
    return { held: h, minted: h + sinks + Number(locked?.s ?? 0), sinks };
  },

  async storeSpend(db, period, now = new Date()) {
    const cut = cutoff(period, now);
    const conds = [like(ledger.reason, "purchase:%"), sql`${ledger.delta} < 0`];
    if (cut) conds.push(gte(ledger.createdAt, cut));
    const [row] = await db
      .select({ s: sql<number>`coalesce(-sum(${ledger.delta}),0)` })
      .from(ledger)
      .where(and(...conds));
    return Number(row?.s ?? 0);
  },

  async splitPreview(db, period, now = new Date()) {
    const spend = await this.storeSpend(db, period, now);
    return {
      spend,
      dood: Math.floor(spend * REVENUE_SPLIT.dood),
      floor: Math.floor(spend * REVENUE_SPLIT.floor),
      leaderboard: Math.floor(spend * REVENUE_SPLIT.leaderboard),
      team: Math.floor(spend * REVENUE_SPLIT.team),
    };
  },

  async poolPreview(db, period, topN = 10, now = new Date()) {
    const spend = await this.storeSpend(db, period, now);
    const pool = Math.floor(spend * REVENUE_SPLIT.leaderboard);
    const rows = await getLeaderboard(db, { period, limit: topN, now });
    const entries: PoolEntry[] = rows.map((r) => ({
      rank: r.rank,
      userId: r.userId,
      handle: r.handle,
      score: r.score,
      prize: 0,
    }));
    return { pool, entries: distributePool(pool, entries) };
  },
};

/** The active metrics provider: on-chain once configured (devnet/mainnet RPC +
 *  $SMASH mint), otherwise the mock (ledger-backed) provider. Read at call time. */
export function getEconomyMetrics(): EconomyMetrics {
  return mockEconomyMetrics; // RF is simulated in this build (lib/rf/settlement.ts)
}
