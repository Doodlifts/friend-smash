/* lib/runs.ts — run lifecycle (DB). Server-authoritative scoring on finish. */

import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { DrizzleDb } from "./db";
import { runs, scores, type Run } from "@/db/schema";
import { SYSTEM, systemAccountId, transferTx } from "./rf/ledger";
import { poolPeriod } from "./rf/pool";
import { scoreSummary, sanityCheck, checkTiming, type RunSummary, type InputEvent } from "./anticheat";
import { replayRun } from "./replay";
import { levelForLines } from "./scoring";
import { runReward, runRewardsEnabled } from "./economy";
import { randomInt } from "crypto";
import { consumePowerups, getInventory, ENFORCED_KEYS, CATALOG, CATALOG_BY_KEY } from "./powerups";
import { inventory } from "@/db/schema";
import { MAX_LOG_EVENTS } from "./anticheat";
import { logAntiCheatRejection } from "./log";
import { sanitizeConfig, type GameConfig, sanitizeScoring } from "./gameConfig";

/** Tally power-up usage from the input log's 'powerup' events. */
function countPowerupUsage(log: InputEvent[] | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(log)) return out;
  for (const ev of log) {
    if (ev.a === "powerup" && typeof ev.key === "string") {
      out[ev.key] = (out[ev.key] || 0) + 1;
    }
  }
  return out;
}

/** The run's use-time consumption record ({key: count}), defensively typed. */
function consumedOf(run: { powerupsConsumed?: unknown } | null | undefined): Record<string, number> {
  const c = run?.powerupsConsumed;
  return c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, number>) : {};
}

/** Usage still owed after subtracting what use-time consumption already took. */
function remainingUsage(
  usage: Record<string, number>,
  consumed: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(usage)) {
    const left = n - (consumed[k] || 0);
    if (left > 0) out[k] = left;
  }
  return out;
}

/** Open a new run for a user with a server-issued seed. `config` is the
 *  game-config SNAPSHOT this run will be played (and replayed) with. */
export async function createRun(
  db: DrizzleDb,
  userId: string,
  seed: number,
  ip?: string | null,
  config?: GameConfig | null,
): Promise<Run> {
  const [run] = await db
    .insert(runs)
    .values({ userId, seed, status: "open", ip: ip ?? null, config: config ?? null })
    .returning();
  return run;
}

export interface FinishResult {
  ok: boolean;
  status: "verified" | "rejected";
  score: number;
  lines: number;
  /** RF earned from this run (mock). */
  reward?: number;
  /** Rare power-up drop won on this verified run (server-rolled), if any. */
  drop?: { key: string; name: string } | null;
  reason?: string;
  /** Ranked daily-pool run, and the UTC day it counts for. */
  ranked?: boolean;
  poolDay?: string | null;
}

/**
 * Server-random rare item drop for a VERIFIED run. Rolled with node crypto —
 * never seeded, never client-influenced — and applied post-verification, so it
 * has zero replay impact. Idempotent because finishRun completes at most once
 * per run (the status flip guards it). Tunables come from the run's config
 * snapshot (drops.enabled/rate/minScore).
 */
function rollDrop(
  drops: { enabled: boolean; rate: number; minScore: number },
  score: number,
): { key: string; name: string } | null {
  if (!drops.enabled || score < drops.minScore) return null;
  // rate in [0,0.5] → compare against a 1e6-sided die (crypto-random).
  if (randomInt(0, 1_000_000) >= Math.floor(drops.rate * 1_000_000)) return null;
  const pool = CATALOG.filter((p) => p.active);
  if (!pool.length) return null;
  const pick = pool[randomInt(0, pool.length)];
  return { key: pick.key, name: pick.name };
}

/**
 * Finish a run: verify it's open + owned by the user, RE-COMPUTE the score
 * server-side from the reported summary (never trust the client's number), run
 * sanity checks, and atomically mark the run + write the leaderboard row.
 *
 * Idempotent on runId: a run can only be finished once (a second attempt sees a
 * non-'open' status and is rejected).
 */
export async function finishRun(
  db: DrizzleDb,
  params: { runId: string; userId: string; summary: RunSummary; log?: InputEvent[] },
): Promise<FinishResult> {
  const { runId, userId, summary, log } = params;
  // Cap stored log size defensively (a real run is well under this).
  const storedLog = Array.isArray(log) ? log.slice(0, 200000) : null;

  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .limit(1);

  if (!run) return reject(0, 0, "run not found");
  if (run.status !== "open") return reject(0, 0, "run already finished");
  // Versus rounds settle ONLY through /api/match/finish — the same HMAC signs
  // both token kinds, and this pipeline writes the leaderboard (and, when the
  // reward faucet is enabled, mints RF). A match round routed here would
  // inject a 60s score into the solo boards and dodge the match state machine.
  if (run.mode === "versus") return reject(0, 0, "versus rounds settle via the match pipeline");

  // DoS guard: a forged, oversized log would force the expensive deterministic
  // replay (BFS reachability per lock) before any other check. A real run is
  // far under MAX_LOG_EVENTS, so reject early without replaying — and without
  // storing the bloated payload.
  if (Array.isArray(log) && log.length > MAX_LOG_EVENTS) {
    await db
      .update(runs)
      .set({ status: "rejected", finishedAt: new Date() })
      .where(eq(runs.id, runId));
    logAntiCheatRejection({ userId, runId, reason: "input log too large", score: 0, lines: 0, ip: run.ip });
    return reject(0, 0, "input log too large");
  }

  // ---- Server-authoritative scoring ----------------------------------------
  // Prefer a full DETERMINISTIC REPLAY of the input log through the headless
  // engine (the real anti-cheat). Fall back to the interim summary scorer only
  // if no input log was submitted.
  let scored: ReturnType<typeof scoreSummary>;
  if (Array.isArray(storedLog) && storedLog.length) {
    // Replay with the run's scoring SNAPSHOT: a missing algorithm version
    // means the run was PLAYED as v1.
    const snapScoring = sanitizeScoring(
      run.config ? (run.config as { scoring?: unknown }).scoring : null,
    );
    const replay = replayRun(run.seed, storedLog, summary, snapScoring);
    scored = {
      ok: replay.ok,
      score: replay.score,
      lines: replay.lines,
      level: levelForLines(replay.lines),
      reason: replay.reason,
    };
    // Integrity cross-check: the client's claimed clears must match the replay.
    if (scored.ok) {
      const claimedLines = (summary.locks || []).reduce((a, b) => a + b, 0);
      if (claimedLines !== replay.lines) {
        scored = { ...scored, ok: false, reason: "replay diverged from reported clears" };
      }
    }
  } else {
    scored = scoreSummary(summary);
  }

  // Entitlement: board-/sequence-affecting power-ups (bomb, reroll) change the
  // replayed score, so a run can't use more of them than the player owns.
  // Inventory NOW plus what THIS run already consumed at use time equals what
  // the player owned at the start — but the two terms must be read as a
  // CONSISTENT PAIR, so take the run-row lock (consumePowerupUse holds the
  // same lock while it decrements): no in-flight use call can land between
  // the two reads and falsely reject a legit run.
  const usage = countPowerupUsage(storedLog);
  let entitlementReason: string | null = null;
  if (ENFORCED_KEYS.some((k) => (usage[k] || 0) > 0)) {
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ pc: runs.powerupsConsumed })
        .from(runs)
        .where(eq(runs.id, runId))
        .for("update");
      const usedAtUseTime = consumedOf({ powerupsConsumed: locked?.pc });
      const inv = await getInventory(tx as unknown as DrizzleDb, userId);
      const owned: Record<string, number> = {};
      for (const i of inv) owned[i.key] = i.qty;
      for (const k of ENFORCED_KEYS) {
        if ((usage[k] || 0) > (owned[k] || 0) + (usedAtUseTime[k] || 0)) {
          entitlementReason = `used more "${k}" than owned`;
          break;
        }
      }
    });
  }

  // Ranked (daily-pool) runs are equal-loadout: any power-up use disqualifies.
  const rankedReason =
    run.mode === "ranked" && Object.values(usage).some((n) => n > 0) ? "power-ups aren't allowed in ranked runs" : null;

  const sanityReason =
    rankedReason ||
    entitlementReason ||
    sanityCheck(summary, scored) ||
    (storedLog ? checkTiming(storedLog, summary.durationMs) : null);

  if (!scored.ok || sanityReason) {
    // Consume the power-ups used in the run EVEN ON REJECTION — the player
    // spent them either way. Without this, a rejected run "refunds" bombs on
    // the next inventory refresh (the tester-reported duplication bug).
    await db.transaction(async (tx) => {
      // Lock the row, re-check status, and re-read use-time consumption: only
      // the FIRST settlement of a run may flip it / consume — a concurrent
      // duplicate finish or abandon must lose here, not proceed blindly.
      const [locked] = await tx
        .select({ status: runs.status, pc: runs.powerupsConsumed })
        .from(runs)
        .where(eq(runs.id, runId))
        .for("update");
      if (!locked || locked.status !== "open") return;
      const owe = remainingUsage(usage, consumedOf({ powerupsConsumed: locked.pc }));
      await tx
        .update(runs)
        .set({
          status: "rejected",
          score: scored.score,
          lines: scored.lines,
          durationMs: Math.max(0, Math.trunc(summary.durationMs) || 0),
          inputLog: storedLog,
          powerupsUsed: Object.keys(usage).length ? usage : null,
          finishedAt: new Date(),
        })
        .where(eq(runs.id, runId));
      if (Object.keys(owe).length) {
        await consumePowerups(tx as unknown as DrizzleDb, userId, owe);
      }
    });
    const reason = sanityReason ?? scored.reason ?? "rejected";
    logAntiCheatRejection({ userId, runId, reason, score: scored.score, lines: scored.lines, ip: run.ip });
    return reject(scored.score, scored.lines, reason);
  }

  // Gameplay does not mint RF unless explicitly enabled (off by default).
  const reward = runRewardsEnabled() ? runReward(scored.score, scored.lines) : 0;

  // Rare item drop (server-rolled, post-verification; see rollDrop).
  const dropCfg = sanitizeConfig(run.config ?? undefined).drops;
  const drop = rollDrop(dropCfg, scored.score);

  const settled = await db.transaction(async (tx) => {
    // Lock, re-check status, re-read use-time consumption (see the rejected
    // branch): the scores insert, reward, drop grant, and consumption below
    // must execute at most ONCE per run even under concurrent duplicates.
    const [locked] = await tx
      .select({ status: runs.status, pc: runs.powerupsConsumed })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    if (!locked || locked.status !== "open") return false;
    const owe = remainingUsage(usage, consumedOf({ powerupsConsumed: locked.pc }));
    await tx
      .update(runs)
      .set({
        status: "verified",
        score: scored.score,
        lines: scored.lines,
        durationMs: Math.max(0, Math.trunc(summary.durationMs) || 0),
        inputLog: storedLog,
        powerupsUsed: Object.keys(usage).length ? usage : null,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId));

    // Ranked runs land on that UTC day's prize-pool board; practice runs on
    // the general boards (which read every period, so ranked counts there too).
    await tx.insert(scores).values({
      userId,
      runId,
      score: scored.score,
      period: run.mode === "ranked" && run.poolDay ? poolPeriod(run.poolDay) : "all",
    });

    // Optional per-run reward from the SIMULATED faucet (off by default —
    // RF is won from pools, not minted by play). Idempotent on runId.
    if (reward > 0) {
      const faucet = await systemAccountId(tx as unknown as DrizzleDb, SYSTEM.faucet);
      await transferTx(tx as unknown as DrizzleDb, {
        from: faucet, to: userId, amount: reward, reason: "run_reward", refId: `${userId}:${runId}`, allowOverdraft: true,
      });
    }

    // Consume what use-time consumption hasn't already taken (never below 0).
    if (Object.keys(owe).length) {
      await consumePowerups(tx as unknown as DrizzleDb, userId, owe);
    }

    // Grant the rare drop, if won (same tx as the run flip → exactly-once).
    if (drop) {
      await tx
        .insert(inventory)
        .values({ userId, powerupKey: drop.key, qty: 1 })
        .onConflictDoUpdate({
          target: [inventory.userId, inventory.powerupKey],
          set: { qty: sql`${inventory.qty} + 1` },
        });
    }
    return true;
  });
  if (!settled) return reject(scored.score, scored.lines, "run already finished");

  return {
    ok: true, status: "verified", score: scored.score, lines: scored.lines, reward, drop,
    ranked: run.mode === "ranked", poolDay: run.poolDay ?? null,
  };
}

function reject(score: number, lines: number, reason: string): FinishResult {
  return { ok: false, status: "rejected", score, lines, reason };
}

/**
 * Abandon an open run (quit / restart mid-game): no score, no leaderboard row —
 * but the power-ups used up to that point ARE consumed (capped at owned via
 * consumePowerups), so quitting can't refund them. Idempotent: only an 'open'
 * run can be abandoned once.
 */
export async function abandonRun(
  db: DrizzleDb,
  params: { runId: string; userId: string; log?: InputEvent[] },
): Promise<{ ok: boolean; consumed: Record<string, number> }> {
  const { runId, userId, log } = params;
  const storedLog = Array.isArray(log) ? log.slice(0, MAX_LOG_EVENTS) : null;
  const usage = countPowerupUsage(storedLog);

  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .limit(1);
  if (!run || run.status !== "open") return { ok: false, consumed: {} };
  // Match rounds are owned by the match state machine (forfeits close them).
  if (run.mode === "versus") return { ok: false, consumed: {} };

  let consumed: Record<string, number> = {};
  const settled = await db.transaction(async (tx) => {
    // Lock, re-check status, re-read use-time consumption: a concurrent
    // finish must win-or-lose cleanly — never both settle the same run.
    const [locked] = await tx
      .select({ status: runs.status, pc: runs.powerupsConsumed })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    if (!locked || locked.status !== "open") return false;
    const owe = remainingUsage(usage, consumedOf({ powerupsConsumed: locked.pc }));
    await tx
      .update(runs)
      .set({
        status: "abandoned",
        inputLog: storedLog,
        powerupsUsed: Object.keys(usage).length ? usage : null,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId));
    if (Object.keys(owe).length) {
      consumed = await consumePowerups(tx as unknown as DrizzleDb, userId, owe);
    }
    return true;
  });
  return settled ? { ok: true, consumed } : { ok: false, consumed: {} };
}

/**
 * USE-TIME power-up consumption — the real fix for the "power-ups keep
 * reappearing" bug. The engine reports each activation the moment it happens
 * ({key, n} where n = cumulative uses of `key` this run), and inventory is
 * decremented immediately. A reload / tab-kill / orphaned run can then never
 * "refund" a spent power-up, because the spend already settled.
 *
 * Idempotent + order-proof: `n` is a cumulative counter, so a retried or
 * out-of-order call (n ≤ what's recorded) is a no-op. Only what inventory
 * actually covered is recorded, so the finish-time entitlement check still
 * catches over-claiming. Finish/abandon consume only (log usage − recorded),
 * so nothing is ever taken twice.
 */
export async function consumePowerupUse(
  db: DrizzleDb,
  params: { runId: string; userId: string; key: string; n: number },
): Promise<{ ok: boolean; qty?: number }> {
  const { runId, userId, key } = params;
  const n = Math.trunc(params.n);
  if (!CATALOG_BY_KEY[key] || !Number.isFinite(n) || n < 1 || n > 500) return { ok: false };

  return await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status, pc: runs.powerupsConsumed, mode: runs.mode })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
      .for("update");
    if (!run || run.status !== "open") return { ok: false };
    if (run.mode === "ranked") return { ok: false }; // equal-loadout pool runs

    const consumed = consumedOf({ powerupsConsumed: run.pc });
    const cur = consumed[key] || 0;
    if (n <= cur) return { ok: true }; // duplicate/out-of-order report — settled
    const applied = await consumePowerups(tx as unknown as DrizzleDb, userId, { [key]: n - cur });
    const got = applied[key] || 0;
    if (got > 0) {
      // Record only what inventory actually covered — recording the CLAIM
      // would let an over-claim inflate the entitlement allowance.
      await tx
        .update(runs)
        .set({ powerupsConsumed: { ...consumed, [key]: cur + got } })
        .where(eq(runs.id, runId));
    }
    return { ok: true };
  });
}

/**
 * Housekeeping: mark a user's EXPIRED open runs abandoned. An open run older
 * than the token max-age can never be finished or abandoned by its client
 * (the token no longer verifies), so flipping it is provably safe. Power-ups
 * were already settled at use time; there is no stored log to reconcile.
 * Called from /api/run/start — recent open runs are left alone (a second tab
 * may legitimately hold a prefetched run).
 */
export async function reapExpiredRuns(db: DrizzleDb, userId: string, maxAgeMs: number): Promise<void> {
  await db
    .update(runs)
    .set({ status: "abandoned", finishedAt: new Date() })
    .where(
      and(
        eq(runs.userId, userId),
        eq(runs.status, "open"),
        lt(runs.startedAt, new Date(Date.now() - maxAgeMs)),
      ),
    );
}

export interface RecentRun {
  id: string;
  score: number;
  lines: number;
  durationMs: number;
  finishedAt: string | null;
}

/** A user's most recent VERIFIED runs (newest first) for the run-history page. */
export async function recentRuns(
  db: DrizzleDb,
  userId: string,
  limit = 20,
): Promise<RecentRun[]> {
  const rows = await db
    .select({
      id: runs.id,
      score: runs.score,
      lines: runs.lines,
      durationMs: runs.durationMs,
      finishedAt: runs.finishedAt,
    })
    .from(runs)
    .where(and(eq(runs.userId, userId), eq(runs.status, "verified")))
    .orderBy(desc(runs.finishedAt))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map((r) => ({
    id: r.id,
    score: Number(r.score ?? 0),
    lines: Number(r.lines ?? 0),
    durationMs: Number(r.durationMs ?? 0),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
  }));
}
