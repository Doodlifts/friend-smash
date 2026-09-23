/* lib/rateLimit.ts — per-user rate limiting via the DB.

   Serverless functions are stateless and fan out across instances, so in-memory
   counters don't work. We count the user's recent rows in the `runs` table —
   correct across all instances, no extra infra. */

import { and, eq, gte, like, sql } from "drizzle-orm";
import type { DrizzleDb } from "./db";
import { runs, ledger } from "@/db/schema";

/** Shared limiter window. */
export const RUN_START_WINDOW_MS = 60_000;

/** Max runs a user may START per window. */
export const RUN_START_LIMIT = 12;

/** Max runs per IP per window (looser than per-user — shared NATs exist). */
export const RUN_START_IP_LIMIT = 40;

/** Max runs a user / IP may FINISH per window. Above the start cap so legit
 *  retries (network blips, runs opened in a prior window) aren't blocked. */
export const RUN_FINISH_LIMIT = 30;
export const RUN_FINISH_IP_LIMIT = 60;

/** Max power-up purchases a user may make per window. */
export const PURCHASE_LIMIT = 30;

/** Minimum gap between a user's handle changes (anti-churn / anti-spam). */
export const HANDLE_CHANGE_COOLDOWN_MS = 10_000;

/** Reject run tokens older than this (a game can't plausibly last longer). */
export const MAX_RUN_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Count runs the user started within the window. */
export async function countRecentRuns(
  db: DrizzleDb,
  userId: string,
  windowMs: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - windowMs);
  const [row] = await db
    .select({ c: sql<number>`count(*)` })
    .from(runs)
    .where(and(eq(runs.userId, userId), gte(runs.startedAt, cutoff)));
  return Number(row?.c ?? 0);
}

/** True if the user is over the run-start rate limit. */
export async function isRunStartLimited(db: DrizzleDb, userId: string): Promise<boolean> {
  const n = await countRecentRuns(db, userId, RUN_START_WINDOW_MS);
  return n >= RUN_START_LIMIT;
}

/** Count runs started from an IP within the window. */
export async function countRecentRunsByIp(
  db: DrizzleDb,
  ip: string,
  windowMs: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - windowMs);
  const [row] = await db
    .select({ c: sql<number>`count(*)` })
    .from(runs)
    .where(and(eq(runs.ip, ip), gte(runs.startedAt, cutoff)));
  return Number(row?.c ?? 0);
}

/** True if the IP is over the run-start rate limit (best-effort; skips empty IP). */
export async function isIpRunStartLimited(db: DrizzleDb, ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const n = await countRecentRunsByIp(db, ip, RUN_START_WINDOW_MS);
  return n >= RUN_START_IP_LIMIT;
}

/* ------------------------------------------------------------------------
   NOTE — these limiters are BEST-EFFORT (count-then-act), like the run-start
   limiter above. Under heavy concurrency a burst of simultaneous requests can
   each read an under-limit count before any of them commits, so the effective
   cap can be exceeded briefly (a known TOCTOU property of DB-count limiters).
   We intentionally do NOT serialize them with row locks, because the things
   that actually matter are protected independently:
     • purchases are idempotent on purchaseId and deduct under a FOR UPDATE
       balance lock — no double-spend or negative balance is possible;
     • finishes are idempotent per run and upstream-bounded by the run-START
       limiter (you can't finish more runs than you were allowed to open).
   So these caps are anti-spam, not hard quotas — locking would add real
   complexity for no integrity gain at launch scale.
   ------------------------------------------------------------------------ */

/** Count runs the user FINISHED within the window (finishedAt-based). */
export async function countRecentFinishes(
  db: DrizzleDb,
  userId: string,
  windowMs: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - windowMs);
  const [row] = await db
    .select({ c: sql<number>`count(*)` })
    .from(runs)
    .where(and(eq(runs.userId, userId), gte(runs.finishedAt, cutoff)));
  return Number(row?.c ?? 0);
}

/** True if the user is over the run-finish rate limit. */
export async function isRunFinishLimited(db: DrizzleDb, userId: string): Promise<boolean> {
  const n = await countRecentFinishes(db, userId, RUN_START_WINDOW_MS);
  return n >= RUN_FINISH_LIMIT;
}

/** Count runs FINISHED from an IP within the window. */
export async function countRecentFinishesByIp(
  db: DrizzleDb,
  ip: string,
  windowMs: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - windowMs);
  const [row] = await db
    .select({ c: sql<number>`count(*)` })
    .from(runs)
    .where(and(eq(runs.ip, ip), gte(runs.finishedAt, cutoff)));
  return Number(row?.c ?? 0);
}

/** True if the IP is over the run-finish rate limit (best-effort; skips empty IP). */
export async function isIpRunFinishLimited(db: DrizzleDb, ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const n = await countRecentFinishesByIp(db, ip, RUN_START_WINDOW_MS);
  return n >= RUN_FINISH_IP_LIMIT;
}

/** Count power-up purchases the user made within the window (ledger-based). */
export async function countRecentPurchases(
  db: DrizzleDb,
  userId: string,
  windowMs: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - windowMs);
  const [row] = await db
    .select({ c: sql<number>`count(*)` })
    .from(ledger)
    .where(
      and(eq(ledger.userId, userId), like(ledger.reason, "purchase:%"), gte(ledger.createdAt, cutoff)),
    );
  return Number(row?.c ?? 0);
}

/** True if the user is over the purchase rate limit. Reuses the shared 60s
 *  window (RUN_START_WINDOW_MS) deliberately — same cadence for all limiters. */
export async function isPurchaseLimited(db: DrizzleDb, userId: string): Promise<boolean> {
  const n = await countRecentPurchases(db, userId, RUN_START_WINDOW_MS);
  return n >= PURCHASE_LIMIT;
}
