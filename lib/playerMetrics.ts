/* ============================================================
   lib/playerMetrics.ts — at-a-glance player health for the admin dashboard.

   Everything is computed from tables we already write (users / runs / ledger)
   — no new tracking, no third-party analytics. READ-ONLY.

   Definitions (kept boring and standard):
   • DAU / WAU / MAU — distinct users who STARTED a run in the last 1/7/30 days
     (runs rows are created at prefetch, which fires on auth + before each
     game — a fine "opened the game signed-in" proxy).
   • Stickiness — DAU / WAU (how much of the weekly crowd shows up daily).
   • D1 / D7 retention — of users old enough to measure, how many played
     again the day after signup / within the first week after signup.
   • Abandon rate — abandoned / (abandoned + verified) among settled runs;
     restarts and rage-quits both land here, so treat it as a frustration
     *proxy*, not a verdict.
   • Bonus rounds — counted from stored input logs (a: "bonus"); scans recent
     jsonb logs, fine at current scale — revisit if runs/day gets huge.
   ============================================================ */

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "./db";
import { QUEUE_FRESH_MS, MAX_MATCH_AGE_MS } from "./match";

export interface DailyPoint {
  day: string; // YYYY-MM-DD
  actives: number;
  runs: number;
  verified: number;
  abandoned: number;
}

export interface PlayerMetrics {
  activity: {
    dau: number;
    wau: number;
    mau: number;
    stickiness: number | null; // dau/wau, 0..1
    runsToday: number;
    totalUsers: number;
    newUsers7d: number;
  };
  daily: DailyPoint[]; // last 30 calendar days, gaps filled with zeros
  retention: {
    d1: number | null; // 0..1 (null = no measurable cohort yet)
    d7: number | null;
    cohort1: number; // users old enough to measure D1
    cohort7: number;
  };
  quality: {
    medianDurationMs: number | null; // verified runs, last 7d
    p90DurationMs: number | null;
    medianScore: number | null;
    bestToday: number | null;
    best7d: number | null;
    verified7d: number;
    abandonRate7d: number | null; // 0..1
    runsPerActive7d: number | null;
    bonusRounds7d: number;
  };
  economy: {
    circulating: number;
    spentAll: number;
    spent7d: number;
    payers: number;
    payerRate: number | null; // payers / total users
    spendPerPayer: number | null;
    itemSales: Array<{ key: string; buys: number; smash: number }>;
    topSpenders: Array<{ handle: string; spent: number }>;
    powerupsUsed7d: Array<{ key: string; used: number }>;
  };
  versus: {
    activeNow: number;
    queuedNow: number;
    matches7d: number;
    fighters7d: number; // distinct players in a match, last 7d
    modes: Array<{ mode: string; total: number; settled: number; aborted: number; draws: number }>;
    turfEndings: Array<{ reason: string; n: number }>; // settled turf with a winner
    money: { escrowed: number; paidOut: number; refunded: number };
    daily: Array<{ day: string; speed: number; turf: number }>; // last 14 days, gaps zero-filled
  };
}

/** db.execute() result shapes differ per driver (postgres-js returns the row
 *  array; PGlite returns {rows}). Normalize. */
async function q<T = Record<string, unknown>>(db: DrizzleDb, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
  return Array.isArray(res) ? res : (res.rows ?? []);
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
/** Chart day keys are UTC on BOTH sides: the SQL buckets convert with
 *  AT TIME ZONE 'UTC' (session-timezone-proof — PGlite sessions run in the
 *  host zone, Railway runs UTC) and the JS gap-fill uses toISOString(). */
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function getPlayerMetrics(db: DrizzleDb): Promise<PlayerMetrics> {
  const [head] = await q(db, sql`
    SELECT
      (SELECT count(DISTINCT user_id) FROM runs WHERE started_at > now() - interval '1 day')::int   AS dau,
      (SELECT count(DISTINCT user_id) FROM runs WHERE started_at > now() - interval '7 days')::int  AS wau,
      (SELECT count(DISTINCT user_id) FROM runs WHERE started_at > now() - interval '30 days')::int AS mau,
      (SELECT count(*) FROM runs WHERE started_at > now() - interval '1 day')::int                  AS runs_today,
      (SELECT count(*) FROM users WHERE did NOT LIKE 'system:%')::int                                                             AS total_users,
      (SELECT count(*) FROM users WHERE did NOT LIKE 'system:%' AND created_at > now() - interval '7 days')::int                AS new_users_7d
  `);

  const dailyRows = await q(db, sql`
    SELECT to_char(date_trunc('day', started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           count(DISTINCT user_id)::int                          AS actives,
           count(*)::int                                         AS runs,
           count(*) FILTER (WHERE status = 'verified')::int      AS verified,
           count(*) FILTER (WHERE status = 'abandoned')::int     AS abandoned
    FROM runs
    WHERE started_at > now() - interval '30 days'
    GROUP BY 1 ORDER BY 1
  `);
  // fill calendar gaps so charts don't lie by omission
  const byDay = new Map(dailyRows.map((r) => [String(r.day), r]));
  const daily: DailyPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = utcDay(d);
    const row = byDay.get(key);
    daily.push({
      day: key,
      actives: num(row?.actives),
      runs: num(row?.runs),
      verified: num(row?.verified),
      abandoned: num(row?.abandoned),
    });
  }

  const [ret] = await q(db, sql`
    SELECT
      count(*) FILTER (WHERE age_ok1)::int          AS cohort1,
      count(*) FILTER (WHERE age_ok1 AND d1)::int   AS ret1,
      count(*) FILTER (WHERE age_ok7)::int          AS cohort7,
      count(*) FILTER (WHERE age_ok7 AND d7)::int   AS ret7
    FROM (
      SELECT u.id,
        u.created_at < now() - interval '2 days' AS age_ok1,
        u.created_at < now() - interval '8 days' AS age_ok7,
        EXISTS (SELECT 1 FROM runs r WHERE r.user_id = u.id
                AND r.started_at >= u.created_at + interval '1 day'
                AND r.started_at <  u.created_at + interval '2 days') AS d1,
        EXISTS (SELECT 1 FROM runs r WHERE r.user_id = u.id
                AND r.started_at >= u.created_at + interval '1 day'
                AND r.started_at <  u.created_at + interval '8 days') AS d7
      FROM users u WHERE u.did NOT LIKE 'system:%'
    ) t
  `);

  const [qual] = await q(db, sql`
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS med_dur,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS p90_dur,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY score)       AS med_score,
      max(score)                                               AS best7,
      count(*)::int                                            AS verified7
    FROM runs
    WHERE status = 'verified' AND finished_at > now() - interval '7 days'
  `);
  const [today] = await q(db, sql`
    SELECT max(score) AS best FROM runs
    WHERE status = 'verified' AND finished_at > now() - interval '1 day'
  `);
  const [settle] = await q(db, sql`
    SELECT count(*) FILTER (WHERE status = 'abandoned')::int AS ab,
           count(*) FILTER (WHERE status = 'verified')::int  AS ok
    FROM runs WHERE finished_at > now() - interval '7 days'
  `);
  const [bonus] = await q(db, sql`
    SELECT count(*)::int AS n
    FROM runs r, jsonb_array_elements(r.input_log) e
    WHERE r.finished_at > now() - interval '7 days'
      AND r.input_log IS NOT NULL AND jsonb_typeof(r.input_log) = 'array'
      AND e->>'a' = 'bonus'
  `);

  const [eco] = await q(db, sql`
    SELECT
      (SELECT coalesce(sum(rf_balance), 0) FROM users WHERE did NOT LIKE 'system:%')::int AS circulating,
      coalesce(-sum(delta) FILTER (WHERE reason LIKE 'purchase:%'), 0)::int AS spent_all,
      coalesce(-sum(delta) FILTER (WHERE reason LIKE 'purchase:%'
        AND created_at > now() - interval '7 days'), 0)::int AS spent_7d,
      count(DISTINCT user_id) FILTER (WHERE reason LIKE 'purchase:%')::int AS payers
    FROM ledger WHERE user_id IN (SELECT id FROM users WHERE did NOT LIKE 'system:%')
  `);
  const itemSales = await q(db, sql`
    SELECT substring(reason FROM 10) AS key, count(*)::int AS buys, coalesce(-sum(delta), 0)::int AS smash
    FROM ledger WHERE reason LIKE 'purchase:%' AND delta < 0
    GROUP BY 1 ORDER BY 3 DESC
  `);
  const topSpenders = await q(db, sql`
    SELECT coalesce(u.handle, 'friend-' || coalesce(u.friend_id, left(u.id::text, 4))) AS handle, (-sum(l.delta))::int AS spent
    FROM ledger l JOIN users u ON u.id = l.user_id
    WHERE l.reason LIKE 'purchase:%' AND l.delta < 0
    GROUP BY u.id, u.handle ORDER BY 2 DESC LIMIT 5
  `);
  const powerupsUsed = await q(db, sql`
    SELECT k.key AS key, sum((k.value)::int)::int AS used
    FROM runs r, jsonb_each_text(r.powerups_used) k
    WHERE r.finished_at > now() - interval '7 days' AND r.powerups_used IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC
  `);

  const dau = num(head?.dau), wau = num(head?.wau);
  // --- versus: matches, queue, endings, wager flow (mock ledger) ---
  // Mirror the game's own liveness horizons: pairing ignores queue rows older
  // than QUEUE_FRESH_MS and matches age-cap at MAX_MATCH_AGE_MS — counting
  // abandoned rows would show phantom players "live now" forever.
  const FRESH_S = Math.round(QUEUE_FRESH_MS / 1000);
  const MAX_AGE_S = Math.round(MAX_MATCH_AGE_MS / 1000);
  const [vsHead] = await q(db, sql`
    SELECT
      (SELECT count(*) FROM matches WHERE status = 'active'
        AND created_at > now() - interval '${sql.raw(String(MAX_AGE_S))} seconds')::int AS active_now,
      (SELECT count(*) FROM match_queue
        WHERE enqueued_at > now() - interval '${sql.raw(String(FRESH_S))} seconds')::int AS queued_now,
      (SELECT count(*) FROM matches WHERE created_at > now() - interval '7 days')::int AS matches_7d,
      (SELECT count(DISTINCT u) FROM (
        SELECT p1 AS u FROM matches WHERE created_at > now() - interval '7 days'
        UNION SELECT p2 FROM matches WHERE created_at > now() - interval '7 days'
      ) f)::int AS fighters_7d
  `);
  const vsModes = await q(db, sql`
    SELECT mode,
      count(*)::int AS total,
      (count(*) FILTER (WHERE status = 'settled'))::int AS settled,
      (count(*) FILTER (WHERE status = 'aborted'))::int AS aborted,
      (count(*) FILTER (WHERE status = 'settled' AND winner IS NULL))::int AS draws
    FROM matches GROUP BY mode ORDER BY mode
  `);
  const vsEndings = await q(db, sql`
    SELECT coalesce(turf->'games'->-1->>'reason', 'concede') AS reason, count(*)::int AS n
    FROM matches
    WHERE mode = 'turf' AND status = 'settled' AND winner IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC
  `);
  const vsMoney = await q(db, sql`
    SELECT reason, coalesce(sum(abs(delta)), 0)::bigint AS v
    FROM ledger WHERE reason IN ('versus:escrow', 'versus:win', 'versus:refund')
      AND user_id IN (SELECT id FROM users WHERE did NOT LIKE 'system:%')
    GROUP BY reason
  `);
  const vsDailyRows = await q(db, sql`
    SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      (count(*) FILTER (WHERE mode = 'speed'))::int AS speed,
      (count(*) FILTER (WHERE mode = 'turf'))::int  AS turf
    FROM matches WHERE created_at > now() - interval '14 days'
    GROUP BY 1
  `);
  const vsDayMap = new Map(vsDailyRows.map((r) => [String(r.day), r]));
  const vsDaily: Array<{ day: string; speed: number; turf: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const day = utcDay(new Date(Date.now() - i * 86400_000));
    const r = vsDayMap.get(day);
    vsDaily.push({ day, speed: num(r?.speed), turf: num(r?.turf) });
  }
  const vsMoneyBy = { escrowed: 0, paidOut: 0, refunded: 0 };
  for (const r of vsMoney) {
    if (r.reason === "versus:escrow") vsMoneyBy.escrowed = num(r.v);
    else if (r.reason === "versus:win") vsMoneyBy.paidOut = num(r.v);
    else if (r.reason === "versus:refund") vsMoneyBy.refunded = num(r.v);
  }

  const cohort1 = num(ret?.cohort1), cohort7 = num(ret?.cohort7);
  const ab = num(settle?.ab), ok = num(settle?.ok);
  const payers = num(eco?.payers), totalUsers = num(head?.total_users);
  return {
    activity: {
      dau,
      wau,
      mau: num(head?.mau),
      stickiness: wau ? dau / wau : null,
      runsToday: num(head?.runs_today),
      totalUsers,
      newUsers7d: num(head?.new_users_7d),
    },
    versus: {
      activeNow: num(vsHead?.active_now),
      queuedNow: num(vsHead?.queued_now),
      matches7d: num(vsHead?.matches_7d),
      fighters7d: num(vsHead?.fighters_7d),
      modes: vsModes.map((r) => ({
        mode: String(r.mode || "speed"),
        total: num(r.total),
        settled: num(r.settled),
        aborted: num(r.aborted),
        draws: num(r.draws),
      })),
      turfEndings: vsEndings.map((r) => ({ reason: String(r.reason), n: num(r.n) })),
      money: vsMoneyBy,
      daily: vsDaily,
    },
    daily,
    retention: {
      d1: cohort1 ? num(ret?.ret1) / cohort1 : null,
      d7: cohort7 ? num(ret?.ret7) / cohort7 : null,
      cohort1,
      cohort7,
    },
    quality: {
      medianDurationMs: numOrNull(qual?.med_dur),
      p90DurationMs: numOrNull(qual?.p90_dur),
      medianScore: numOrNull(qual?.med_score),
      bestToday: numOrNull(today?.best),
      best7d: numOrNull(qual?.best7),
      verified7d: num(qual?.verified7),
      abandonRate7d: ab + ok ? ab / (ab + ok) : null,
      runsPerActive7d: wau ? daily.slice(-7).reduce((a, d) => a + d.runs, 0) / wau : null,
      bonusRounds7d: num(bonus?.n),
    },
    economy: {
      circulating: num(eco?.circulating),
      spentAll: num(eco?.spent_all),
      spent7d: num(eco?.spent_7d),
      payers,
      payerRate: totalUsers ? payers / totalUsers : null,
      spendPerPayer: payers ? num(eco?.spent_all) / payers : null,
      itemSales: itemSales.map((r) => ({ key: String(r.key), buys: num(r.buys), smash: num(r.smash) })),
      topSpenders: topSpenders.map((r) => ({ handle: String(r.handle), spent: num(r.spent) })),
      powerupsUsed7d: powerupsUsed.map((r) => ({ key: String(r.key), used: num(r.used) })),
    },
  };
}
