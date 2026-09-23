/* lib/leaderboard.ts — leaderboard reads (best score per user, per period).

   Periods are derived from scores.created_at (no bucket-rolling cron needed):
   'all' = no filter, 'weekly' = last 7 days, 'daily' = last 24h. We store one
   score row per verified run with period='all' and time-filter for the rest. */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DrizzleDb } from "./db";
import { scores, users } from "@/db/schema";

export type Period = "all" | "weekly" | "daily";

export interface LeaderboardRow {
  rank: number;
  userId: string;
  handle: string | null;
  score: number;
}

function cutoff(period: Period, now: Date): Date | null {
  if (period === "daily") return new Date(now.getTime() - 24 * 3600 * 1000);
  if (period === "weekly") return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  return null;
}

export interface LeaderboardOptions {
  period?: Period;
  limit?: number;
  offset?: number;
  now?: Date;
}

export async function getLeaderboard(
  db: DrizzleDb,
  { period = "all", limit = 50, offset = 0, now = new Date() }: LeaderboardOptions = {},
): Promise<LeaderboardRow[]> {
  const cut = cutoff(period, now);
  const best = sql<number>`max(${scores.score})`;
  const rows = await db
    .select({ userId: users.id, handle: users.handle, best })
    .from(scores)
    .innerJoin(users, eq(users.id, scores.userId))
    .where(cut ? gte(scores.createdAt, cut) : undefined)
    .groupBy(users.id, users.handle)
    .orderBy(desc(best))
    .limit(Math.min(Math.max(limit, 1), 100))
    .offset(Math.max(offset, 0));

  return rows.map((r, i) => ({
    rank: offset + i + 1,
    userId: r.userId,
    handle: r.handle,
    score: Number(r.best),
  }));
}

export interface UserRank {
  rank: number;
  best: number;
}

/**
 * The user's rank within a period ("you're #482"), or null if they have no
 * verified score in that window. Counts, IN SQL, the distinct users with a
 * strictly higher best score (HAVING over a grouped subquery) — so the DB does
 * the work instead of shipping every user's best back to count in JS. Runs on
 * the hot game-over path, so keep it cheap.
 */
export async function getUserRank(
  db: DrizzleDb,
  userId: string,
  period: Period = "all",
  now: Date = new Date(),
): Promise<UserRank | null> {
  const cut = cutoff(period, now);
  const timeFilter = cut ? gte(scores.createdAt, cut) : undefined;

  const best = sql<number>`max(${scores.score})`;
  const [mine] = await db
    .select({ best })
    .from(scores)
    .where(cut ? and(eq(scores.userId, userId), timeFilter) : eq(scores.userId, userId));
  const myBest = mine?.best != null ? Number(mine.best) : null;
  if (myBest == null) return null;

  // Subquery: one row per user whose best score beats mine; count it in SQL.
  const aheadUsers = db
    .select({ uid: scores.userId })
    .from(scores)
    .where(timeFilter)
    .groupBy(scores.userId)
    .having(sql`max(${scores.score}) > ${myBest}`)
    .as("ahead_users");
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(aheadUsers);
  const ahead = Number(row?.n ?? 0);
  return { rank: ahead + 1, best: myBest };
}
