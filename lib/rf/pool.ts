/* ============================================================
   lib/rf/pool.ts — ranked daily prize pools (SIMULATED RF).

   Loop:
     1. A signed-in Friend opens a verified run (/api/run/start) and pays a
        ranked ENTRY for it (/api/pool/enter): 0.40 RF → today's pool,
        0.10 RF → burn. The run is marked ranked for that UTC day.
     2. The run is played and server-REPLAYED like every run (anti-cheat).
        Ranked runs may not use power-ups: pure skill, equal loadout.
     3. After the day closes (+2h grace for in-flight runs) the pool pays the
        top 10 best ranked scores (one place per Friend), top-heavy. A pool with
        no finishers rolls over to the next day. Settlement is lazy (triggered
        by reads) and idempotent: each payout is a ledger transfer keyed by
        (day, place), so concurrent settlers can't double-pay.
   ============================================================ */

import { and, desc, eq, like, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db";
import { runs, scores, users } from "@/db/schema";
import { SYSTEM, systemAccountId, systemBalance, transferTx, InsufficientFundsError } from "./ledger";
import {
  POOL_BURN,
  POOL_ENTRY,
  POOL_ENTRY_WINDOW_MS,
  POOL_PAID_PLACES,
  POOL_SHARE,
  nextUtcDay,
  poolClosesAt,
  poolSettlesAt,
  utcDay,
} from "./economy-rules";

export const poolPeriod = (day: string) => `pool:${day}`;

/** Top-heavy linear split (n, n-1, …, 1); integer units, remainder to #1. */
export function splitPool(pool: number, places: number): number[] {
  if (places <= 0 || pool <= 0) return Array.from({ length: Math.max(0, places) }, () => 0);
  const w = Array.from({ length: places }, (_, i) => places - i);
  const tw = w.reduce((a, b) => a + b, 0);
  const out = w.map((x) => Math.floor((pool * x) / tw));
  out[0] += pool - out.reduce((a, b) => a + b, 0);
  return out;
}

/* ----------------------------------- enter ----------------------------------- */

export type EnterResult =
  | { ok: true; day: string; duplicate: boolean; balance: number }
  | { ok: false; status: number; error: string };

export async function enterPool(
  db: DrizzleDb,
  p: { userId: string; runId: string; now?: Date },
): Promise<EnterResult> {
  const now = p.now ?? new Date();
  const day = utcDay(now);
  try {
    return await db.transaction(async (tx0) => {
      const tx = tx0 as unknown as DrizzleDb;
      const [run] = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, p.runId), eq(runs.userId, p.userId)))
        .for("update");
      if (!run) return { ok: false as const, status: 404, error: "Run not found." };
      if (run.mode === "ranked") {
        const [u] = await tx.select({ b: users.rfBalance }).from(users).where(eq(users.id, p.userId));
        return { ok: true as const, day: run.poolDay ?? day, duplicate: true, balance: Number(u?.b ?? 0) };
      }
      if (run.status !== "open" || run.mode) return { ok: false as const, status: 409, error: "That run can't be ranked." };
      if (now.getTime() - new Date(run.startedAt).getTime() > POOL_ENTRY_WINDOW_MS) {
        return { ok: false as const, status: 409, error: "Entry window for that run has passed." };
      }
      const consumed = run.powerupsConsumed as Record<string, number> | null;
      if (consumed && Object.values(consumed).some((n) => n > 0)) {
        return { ok: false as const, status: 409, error: "Ranked runs can't use power-ups." };
      }

      const pool = await systemAccountId(tx, SYSTEM.pool(day));
      const burn = await systemAccountId(tx, SYSTEM.burn);
      await transferTx(tx, { from: p.userId, to: pool, amount: POOL_SHARE, reason: "pool:entry", refId: p.runId });
      const r = await transferTx(tx, { from: p.userId, to: burn, amount: POOL_BURN, reason: "pool:burn", refId: p.runId });
      await tx.update(runs).set({ mode: "ranked", poolDay: day }).where(eq(runs.id, p.runId));
      return { ok: true as const, day, duplicate: false, balance: r.fromBalance };
    });
  } catch (e) {
    if (e instanceof InsufficientFundsError) {
      return { ok: false, status: 402, error: `Ranked entry is ${POOL_ENTRY / 100} RF (simulated) — not enough RF.` };
    }
    throw e;
  }
}

/* ---------------------------------- standings ---------------------------------- */

export interface Standing {
  rank: number;
  userId: string;
  /** false = read-only (pasted address) account. */
  verified?: boolean;
  friendId: string | null;
  handle: string | null;
  score: number;
}

export async function poolStandings(db: DrizzleDb, day: string, limit = POOL_PAID_PLACES): Promise<Standing[]> {
  const best = sql<number>`max(${scores.score})`;
  // Tie-break: earliest time the Friend reached its best (first to the score wins).
  const firstAt = sql<Date>`min(${scores.createdAt})`;
  const rows = await db
    .select({ userId: users.id, did: users.did, friendId: users.friendId, handle: users.handle, best, firstAt })
    .from(scores)
    .innerJoin(users, eq(users.id, scores.userId))
    .where(eq(scores.period, poolPeriod(day)))
    .groupBy(users.id, users.did, users.friendId, users.handle)
    .orderBy(desc(best), firstAt)
    .limit(limit);
  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.userId,
    verified: !r.did.startsWith("watch:"),
    friendId: r.friendId,
    handle: r.handle,
    score: Number(r.best),
  }));
}

/** A Friend's place in a day's pool (1 + Friends with a strictly higher best). */
export async function poolRank(db: DrizzleDb, userId: string, day: string): Promise<{ rank: number; best: number } | null> {
  const [mine] = await db
    .select({ best: sql<number>`max(${scores.score})` })
    .from(scores)
    .where(and(eq(scores.userId, userId), eq(scores.period, poolPeriod(day))));
  if (mine?.best == null) return null;
  const best = Number(mine.best);
  const res = await db.execute(sql`
    select count(*) as n from (
      select user_id from scores where period = ${poolPeriod(day)}
      group by user_id having max(score) > ${best}) t`);
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as { n: unknown }[];
  return { rank: Number(rows[0]?.n ?? 0) + 1, best };
}

/* ---------------------------------- settlement ---------------------------------- */

/**
 * Pay out every pool whose settle time has passed and that still holds RF.
 * Cheap when there's nothing to do (one indexed query). Safe to call often.
 */
export async function settleDuePools(db: DrizzleDb, now: Date = new Date()): Promise<string[]> {
  const due = await db
    .select({ did: users.did, b: users.rfBalance })
    .from(users)
    .where(and(like(users.did, "system:pool:%"), sql`${users.rfBalance} > 0`));
  const settled: string[] = [];
  // Oldest first: a pool with no finishers rolls into the NEXT day, which
  // must receive it before that day itself settles.
  due.sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));
  for (const row of due) {
    const day = row.did.slice("system:pool:".length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || now < poolSettlesAt(day)) continue;
    await settleDay(db, day);
    settled.push(day);
  }
  return settled;
}

export async function settleDay(db: DrizzleDb, day: string): Promise<void> {
  const standings = await poolStandings(db, day, POOL_PAID_PLACES);
  await db.transaction(async (tx0) => {
    const tx = tx0 as unknown as DrizzleDb;
    const poolId = await systemAccountId(tx, SYSTEM.pool(day));
    const [locked] = await tx.select({ b: users.rfBalance }).from(users).where(eq(users.id, poolId)).for("update");
    const pot = Number(locked?.b ?? 0);
    if (pot <= 0) return;
    if (!standings.length) {
      const next = await systemAccountId(tx, SYSTEM.pool(nextUtcDay(day)));
      await transferTx(tx, { from: poolId, to: next, amount: pot, reason: "pool:rollover", refId: day });
      return;
    }
    const prizes = splitPool(pot, standings.length);
    for (let i = 0; i < standings.length; i++) {
      if (prizes[i] <= 0) continue;
      await transferTx(tx, {
        from: poolId,
        to: standings[i].userId,
        amount: prizes[i],
        reason: "pool:prize",
        refId: `${day}#${i + 1}`,
      });
    }
  });
}

/* ------------------------------------ status ------------------------------------ */

export interface PoolStatus {
  day: string;
  closesAt: string;
  settlesAt: string;
  pot: number;
  entries: number;
  entryFee: number;
  poolShare: number;
  burnPerEntry: number;
  standings: (Standing & { projectedPrize: number })[];
  me: { best: number | null; rank: number | null; entries: number } | null;
  yesterday: { day: string; winners: (Standing & { prize: number })[] } | null;
  totals: { burned: number; prizesPaid: number; faucetIssued: number };
}

export async function poolStatus(db: DrizzleDb, opts: { userId?: string | null; now?: Date } = {}): Promise<PoolStatus> {
  const now = opts.now ?? new Date();
  await settleDuePools(db, now).catch(() => {});
  const day = utcDay(now);
  const yday = utcDay(new Date(now.getTime() - 86_400_000));

  const [pot, burned, faucet, standings, entriesRow, paidRow, ywin] = await Promise.all([
    systemBalance(db, SYSTEM.pool(day)),
    systemBalance(db, SYSTEM.burn),
    systemBalance(db, SYSTEM.faucet),
    poolStandings(db, day, POOL_PAID_PLACES),
    db.select({ n: sql<number>`count(*)` }).from(runs).where(and(eq(runs.mode, "ranked"), eq(runs.poolDay, day))),
    db.execute(sql`select coalesce(sum(delta),0) as s from ledger where reason = 'pool:prize' and delta > 0`),
    db.execute(sql`
      select l.delta as prize, u.id as "userId", u.friend_id as "friendId", u.handle as handle, l.ref_id as ref
      from ledger l join users u on u.id = l.user_id
      where l.reason = 'pool:prize' and l.delta > 0 and l.ref_id like ${yday + "#%"}
      order by l.ref_id`),
  ]);
  const rowsOf = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  const prizes = splitPool(pot, Math.max(standings.length, 1));

  let me: PoolStatus["me"] = null;
  if (opts.userId) {
    const [mine] = await db
      .select({ best: sql<number>`max(${scores.score})` })
      .from(scores)
      .where(and(eq(scores.userId, opts.userId), eq(scores.period, poolPeriod(day))));
    const [mineEntries] = await db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.userId, opts.userId), eq(runs.mode, "ranked"), eq(runs.poolDay, day)));
    const best = mine?.best != null ? Number(mine.best) : null;
    let rank: number | null = null;
    if (best != null) {
      const ahead = await db.execute(sql`
        select count(*) as n from (
          select user_id from scores where period = ${poolPeriod(day)}
          group by user_id having max(score) > ${best}) t`);
      rank = Number(rowsOf(ahead)[0]?.n ?? 0) + 1;
    }
    me = { best, rank, entries: Number(mineEntries?.n ?? 0) };
  }

  const yWinners = rowsOf(ywin).map((r) => ({
    rank: Number(String(r.ref).split("#")[1] ?? 0),
    userId: String(r.userId),
    friendId: (r.friendId as string) ?? null,
    handle: (r.handle as string) ?? null,
    score: 0,
    prize: Number(r.prize),
  }));

  return {
    day,
    closesAt: poolClosesAt(day).toISOString(),
    settlesAt: poolSettlesAt(day).toISOString(),
    pot,
    entries: Number(entriesRow[0]?.n ?? 0),
    entryFee: POOL_ENTRY,
    poolShare: POOL_SHARE,
    burnPerEntry: POOL_BURN,
    standings: standings.map((s, i) => ({ ...s, projectedPrize: standings.length ? prizes[i] ?? 0 : 0 })),
    me,
    yesterday: yWinners.length ? { day: yday, winners: yWinners } : null,
    totals: {
      burned,
      prizesPaid: Number(rowsOf(paidRow)[0]?.s ?? 0),
      faucetIssued: -faucet,
    },
  };
}
