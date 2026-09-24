/* ============================================================
   lib/match.ts — VERSUS: best-of-5, 60-second, same-seed rounds with a
   MOCK-RF wager. The server owns every transition; clients only poll
   state, stream heartbeats, and submit replay-verified rounds.

   MONEY RULE (CLAUDE.md): wagers ride the MOCKED ledger — the same rail the
   shop spends. Escrow debits both players at pairing; the winner is credited
   2× at settlement; draws/aborts refund. All entries are idempotent via the
   ledger's (user, reason, refId=matchId) unique guard, and every settlement
   runs under the match row lock with a status re-check (at-most-once — the
   discipline learned from the power-up duplication saga). No on-chain code.

   FAIRNESS: both players play the SAME server-chosen seed each round with the
   SAME config snapshot (item drops and power-ups disabled) — pure
   piece-for-piece skill. Rounds verify through the standard replay pipeline
   (runs rows, mode='versus') and never touch the leaderboard.

   LIVENESS: there is no cron — either player's state poll advances forfeits,
   expiries, and settlement. A match can always terminate even if one (or
   both) clients vanish.
   ============================================================ */

import { SYSTEM, systemAccountId, transferTx } from "./rf/ledger";
import { versusRake } from "./rf/economy-rules";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { randomInt } from "crypto";
import type { DrizzleDb } from "./db";
import { ledger, matches, matchQueue, runs, users, type Match } from "@/db/schema";
import { getGameConfig, sanitizeConfig, type GameConfig, sanitizeScoring } from "./gameConfig";
import { replayRun } from "./replay";
import { levelForLines } from "./scoring";
import { scoreSummary, sanityCheck, checkTiming, MAX_LOG_EVENTS, MAX_SCORE_PER_SEC, type InputEvent, type RunSummary } from "./anticheat";
import { logAntiCheatRejection, logInfo } from "./log";
import { signRunToken } from "./runToken";
import {
  TURF_BEST_OF,
  TURF_WINS_NEEDED,
  TURF_RULES_V,
  TURF_TURN_MS,
  TURF_INTERGAME_MS,
  newTurfGame,
  turfGrid,
  pureRowFor,
  applyTurfMove,
  tickTurfGame,
  type TurfState,
  type TurfGame,
  type Slot as TurfSlot,
} from "./turf";
import type { PieceType } from "./rng";

export const WAGER_TIERS = [0, 50, 100, 250] as const;
export const BEST_OF = 5;
export const ROUND_SECS = 60;
/** Round win target: first to ceil(BEST_OF/2). */
export const WINS_NEEDED = Math.ceil(BEST_OF / 2);
/** Ties award no point — sudden-death rounds keep coming until this cap. */
export const MAX_ROUNDS = BEST_OF + 4;
export const COUNTDOWN_MS = 5_000; // match found → round 1 starts
export const INTERMISSION_MS = 9_000; // round result splash → next round
/** Late-submit grace after the 60s: network + lock-settling slack. */
export const GRACE_MS = 30_000;
/** A player whose round expires unsubmitted forfeits it; two consecutive
 *  forfeits (or an opponent-conceded match) ends the match. */
export const MAX_MATCH_AGE_MS = 30 * 60 * 1000;
/** Ready-up: both players must tap READY within this window or the match
 *  aborts with refunds — nobody gets clock-farmed while reading the rules. */
export const READY_TIMEOUT_MS = 75_000;

type Slot = "p1" | "p2";
interface RoundSide {
  runId: string;
  live: number; // heartbeat score (display only, never authoritative)
  score: number | null; // replay-verified score (0 on rejection/forfeit)
  state: "playing" | "done" | "forfeit";
  rejected?: boolean;
}
export interface MatchRound {
  n: number;
  seed: number;
  startsAt: string; // ISO — countdown target; play window = [startsAt, startsAt+roundSecs]
  deadline: string; // ISO — startsAt + roundSecs + GRACE_MS; unsubmitted = forfeit
  p1: RoundSide;
  p2: RoundSide;
  winner: Slot | "tie" | null;
}

/** The versus config snapshot: solo tuning minus everything unfair in a 60s
 *  head-to-head — no item drops. Power-ups
 *  are rejected at verification (any 'powerup' log event fails the round). */
export function versusConfig(base: GameConfig): GameConfig {
  const cfg = sanitizeConfig(base);
  return {
    ...cfg,
    drops: { ...cfg.drops, enabled: false },
  };
}

const roundsOf = (m: Match): MatchRound[] => (Array.isArray(m.rounds) ? (m.rounds as unknown as MatchRound[]) : []);
const slotOf = (m: Match, userId: string): Slot | null => (m.p1 === userId ? "p1" : m.p2 === userId ? "p2" : null);
const other = (s: Slot): Slot => (s === "p1" ? "p2" : "p1");

/** Decide a finished round. Exported for unit tests. */
export function decideRound(a: number, b: number): Slot | "tie" {
  return a === b ? "tie" : a > b ? "p1" : "p2";
}

/** Match over? Exported for unit tests. */
export function matchVerdict(p1Wins: number, p2Wins: number, roundsPlayed: number): Slot | "draw" | null {
  if (p1Wins >= WINS_NEEDED) return "p1";
  if (p2Wins >= WINS_NEEDED) return "p2";
  if (roundsPlayed >= BEST_OF && p1Wins !== p2Wins) return p1Wins > p2Wins ? "p1" : "p2";
  if (roundsPlayed >= MAX_ROUNDS) return "draw"; // pathological all-tie run
  return null;
}

/** Insert the pair of `runs` rows for round `n` and return the round record. */
async function createRound(
  tx: DrizzleDb,
  matchId: string,
  cfg: GameConfig,
  p1: string,
  p2: string,
  n: number,
  startsAt: Date,
): Promise<MatchRound> {
  const seed = randomInt(0, 0x100000000);
  const mk = async (userId: string) => {
    const [r] = await tx
      .insert(runs)
      .values({ userId, seed, status: "open", config: cfg, mode: "versus", matchId })
      .returning({ id: runs.id });
    return r.id;
  };
  const deadline = new Date(startsAt.getTime() + ROUND_SECS * 1000 + GRACE_MS);
  return {
    n,
    seed,
    startsAt: startsAt.toISOString(),
    deadline: deadline.toISOString(),
    p1: { runId: await mk(p1), live: 0, score: null, state: "playing" },
    p2: { runId: await mk(p2), live: 0, score: null, state: "playing" },
    winner: null,
  };
}

/* ------------------------------------------------ queue + pairing */

export interface QueueResult {
  state: "queued" | "matched" | "error";
  error?: string;
}

/**
 * Join the matchmaking queue at a wager tier and try to pair immediately.
 * Pairing is a single transaction: grab the longest-waiting compatible
 * opponent with FOR UPDATE SKIP LOCKED (two concurrent pairers can never
 * take the same row), delete both queue rows, escrow both wagers, create
 * the match + round 1. If anything fails (opponent broke, insufficient
 * funds) the tx rolls back and the queue state is unchanged.
 */
export const MATCH_MODES = ["speed", "turf"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export async function joinQueue(
  db: DrizzleDb,
  userId: string,
  wager: number,
  mode: MatchMode = "speed",
): Promise<QueueResult> {
  if (!WAGER_TIERS.includes(wager as (typeof WAGER_TIERS)[number])) {
    return { state: "error", error: "Unknown wager tier." };
  }
  if (!MATCH_MODES.includes(mode)) return { state: "error", error: "Unknown mode." };
  // Already in an active match? The client should resume it, not queue.
  const existing = await activeMatchFor(db, userId);
  if (existing) return { state: "matched" };

  // Balance gate up front (friendlier error than failing at pairing).
  const [u] = await db.select({ b: users.rfBalance }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return { state: "error", error: "User not found." };
  if (Number(u.b) < wager) return { state: "error", error: "Not enough RF for that wager." };

  // Upsert my queue row (re-joining with a new tier just updates it).
  await db
    .insert(matchQueue)
    .values({ userId, wager, mode })
    .onConflictDoUpdate({ target: matchQueue.userId, set: { wager, mode, enqueuedAt: new Date() } });

  const paired = await tryPair(db, userId, wager, mode);
  return paired ? { state: "matched" } : { state: "queued" };
}

/** Queue rows older than this are invisible to pairing — the client touches
 *  its row on every state poll, so a fresh row means a live, polling player.
 *  An offline player's row goes stale instead of feeding forfeit-farms. */
export const QUEUE_FRESH_MS = 60_000;

async function tryPair(db: DrizzleDb, userId: string, wager: number, mode: MatchMode): Promise<boolean> {
  return await db.transaction(async (tx) => {
    // Lock MY queue row first; if it's gone, someone just paired me.
    const mine = await tx
      .select()
      .from(matchQueue)
      .where(eq(matchQueue.userId, userId))
      .for("update", { skipLocked: true });
    if (!mine.length) return false;

    // Freshest-eligible opponent at the same tier: longest-waiting first,
    // skipping rows other pairers hold and rows whose owner stopped polling.
    const opp = await tx
      .select()
      .from(matchQueue)
      .where(
        and(
          eq(matchQueue.wager, wager),
          eq(matchQueue.mode, mode), // SPEED and TURF queues never cross
          ne(matchQueue.userId, userId),
          sql`${matchQueue.enqueuedAt} > now() - interval '${sql.raw(String(QUEUE_FRESH_MS / 1000))} seconds'`,
        ),
      )
      .orderBy(matchQueue.enqueuedAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!opp.length) return false;
    const oppId = opp[0].userId;

    // RE-CHECK inside the lock: a queue row can be resurrected by a re-tier
    // tap racing a pairing commit (upsert lands after the pairer deleted the
    // row). Without this, a player already in an active match gets paired —
    // and escrowed — a second time. Stale rows are deleted, not paired.
    for (const id of [userId, oppId]) {
      const [live] = await tx
        .select({ id: matches.id })
        .from(matches)
        .where(and(eq(matches.status, "active"), or(eq(matches.p1, id), eq(matches.p2, id))))
        .limit(1);
      if (live) {
        await tx.delete(matchQueue).where(eq(matchQueue.userId, id));
        return false;
      }
    }

    // Lock both user rows in a stable order (deadlock-proof) and re-check funds.
    const ids = [userId, oppId].sort();
    const balances = await tx
      .select({ id: users.id, b: users.rfBalance })
      .from(users)
      .where(inArray(users.id, ids))
      .orderBy(users.id)
      .for("update");
    const balOf = (id: string) => Number(balances.find((r) => r.id === id)?.b ?? 0);
    if (balOf(oppId) < wager) {
      // Opponent spent their stake while waiting — drop them, stay queued.
      await tx.delete(matchQueue).where(eq(matchQueue.userId, oppId));
      return false;
    }
    if (balOf(userId) < wager) {
      await tx.delete(matchQueue).where(eq(matchQueue.userId, userId));
      throw new Error("insufficient"); // rolls back; caller reported balance OK moments ago
    }

    await tx.delete(matchQueue).where(inArray(matchQueue.userId, [userId, oppId]));

    // Create the match shell first so escrow entries can reference its id.
    // SPEED matches carry a versus config snapshot + rounds; TURF matches
    // carry the referee state instead (p1 = PINK, p2 = BLUE).
    const cfg = mode === "speed" ? versusConfig(await getGameConfig(tx as unknown as DrizzleDb)) : null;
    // Round/game 1 is NOT created here — the ready-up gate (markReady) mints
    // it with fresh clocks once BOTH players have tapped READY.
    const [m] = await tx
      .insert(matches)
      .values({
        status: "active",
        p1: oppId, // the longer-waiting player is p1 (cosmetic only)
        p2: userId,
        wager,
        mode,
        turf: mode === "turf" ? ({ games: [] } satisfies TurfState) : null,
        ready: { p1: false, p2: false },
        bestOf: mode === "turf" ? TURF_BEST_OF : BEST_OF,
        roundSecs: ROUND_SECS,
        round: 1,
        rounds: [],
        config: cfg,
        // Snapshot both records NOW: neither can change while this match is
        // live, so the poll path never has to re-aggregate a lifetime history
        // (it was the dominant per-poll cost — concurrency/scale audit).
        records: {
          p1: await recordFor(tx as unknown as DrizzleDb, oppId),
          p2: await recordFor(tx as unknown as DrizzleDb, userId),
        },
      })
      .returning({ id: matches.id });

    // Escrow (simulated RF): each stake moves Friend → system:escrow,
    // idempotent per (user, 'versus:escrow', matchId).
    if (wager > 0) {
      const escrow = await systemAccountId(tx as unknown as DrizzleDb, SYSTEM.escrow);
      for (const id of [userId, oppId]) {
        await transferTx(tx as unknown as DrizzleDb, { from: id, to: escrow, amount: wager, reason: "versus:escrow", refId: `${m.id}:${id}` });
      }
    }

    return true;
  }).catch((e) => {
    if (e instanceof Error && e.message === "insufficient") return false;
    throw e;
  });
}

export async function leaveQueue(db: DrizzleDb, userId: string): Promise<void> {
  await db.delete(matchQueue).where(eq(matchQueue.userId, userId));
}

/* ------------------------------------------------ state + liveness */

export async function activeMatchFor(db: DrizzleDb, userId: string): Promise<Match | null> {
  const [m] = await db
    .select()
    .from(matches)
    .where(and(eq(matches.status, "active"), or(eq(matches.p1, userId), eq(matches.p2, userId))))
    .limit(1);
  return m ?? null;
}

/** Client-facing state. Includes MY runToken for the current round (signed on
 *  demand — tokens are stateless HMACs) but never the opponent's. */
export interface MatchView {
  state: "idle" | "queued" | "active" | "over";
  serverNow: number;
  wager?: number;
  queuedWager?: number;
  /** Lobby color: how many are waiting at my tier / playing right now. */
  counts?: { waiting: number; smashing: number };
  mode?: MatchMode;
  /** Ready-up gate: both players see this until each taps READY. */
  staging?: {
    id: string;
    myReady: boolean;
    oppReady: boolean;
    oppHandle: string;
    oppRecord: PlayerRecord;
    wager: number;
    /** ms remaining before the unreadied match aborts with refunds. */
    expiresInMs: number;
  };
  /** TURF WAR view — present instead of `match` when the match is turf. */
  turf?: {
    id: string;
    rulesV: number;
    game: number;
    bestOf: number;
    winsNeeded: number;
    myWins: number;
    oppWins: number;
    oppHandle: string;
    oppRecord: PlayerRecord;
    wager: number;
    myTeam: "pink" | "blue";
    myTurn: boolean;
    moveN: number;
    piece: PieceType;
    next: PieceType[];
    deadline: number; // ms epoch of the current shot clock
    placements: { t: PieceType; r: number; x: number; y: number; team: "pink" | "blue"; auto: boolean }[];
    lastGame: null | {
      n: number;
      winner: "me" | "them";
      reason: "row" | "squeeze" | "afk";
      placements: { t: PieceType; r: number; x: number; y: number; team: "pink" | "blue"; auto: boolean }[];
      row: number | null; // winning row index when reason === "row"
    };
  };
  match?: {
    id: string;
    round: number;
    bestOf: number;
    roundSecs: number;
    winsNeeded: number;
    myWins: number;
    oppWins: number;
    oppHandle: string;
    /** Opponent's lifetime settled-match record (wins/losses). */
    oppRecord: PlayerRecord;
    wager: number;
    startsAt: number;
    deadline: number;
    seed: number;
    runId: string;
    runToken: string;
    myState: RoundSide["state"];
    oppState: RoundSide["state"];
    myScore: number | null;
    oppScore: number | null;
    lastRound:
      | null
      | {
          n: number;
          myScore: number;
          oppScore: number;
          winner: "me" | "them" | "tie";
          myForfeit: boolean;
          oppForfeit: boolean;
        };
    config: unknown;
  };
  result?: {
    won: boolean;
    draw: boolean;
    aborted: boolean;
    /** How the match ended: last game/round reason, or concede/abort. */
    how: string | null;
    myWins: number;
    oppWins: number;
    wager: number;
    payout: number; // +2w − 5% burned rake on win / 0 loss / +w refund on draw|abort
    oppHandle: string;
  };
}

/**
 * Poll handler: advances liveness (expired-round forfeits, dead-match abort),
 * then reports the caller's view. Either player's poll moves the match on.
 */
/* ---------- player records & match history ---------- */

export interface PlayerRecord {
  w: number; // all modes (older clients read these two during deploy skew)
  l: number;
  speed: { w: number; l: number };
  turf: { w: number; l: number };
}

/** The opponent's record for a view: the pairing snapshot when present,
 *  otherwise computed (matches created before the snapshot column shipped). */
async function oppRecordOf(db: DrizzleDb, m: Match, oppSlot: Slot): Promise<PlayerRecord> {
  const snap = (m.records ?? null) as { p1?: PlayerRecord; p2?: PlayerRecord } | null;
  const hit = snap?.[oppSlot];
  if (hit && hit.speed && hit.turf) return hit;
  return await recordFor(db, oppSlot === "p1" ? m.p1 : m.p2);
}

/** Lifetime W–L per game mode (settled matches with a decided winner only —
    draws and aborts count for nobody). One grouped query, not four. */
export async function recordFor(db: DrizzleDb, userId: string): Promise<PlayerRecord> {
  const rows = await db
    .select({
      mode: matches.mode,
      w: sql<number>`(count(*) filter (where ${matches.winner} = ${userId}))::int`,
      l: sql<number>`(count(*) filter (where ${matches.winner} is not null and ${matches.winner} != ${userId}))::int`,
    })
    .from(matches)
    .where(and(eq(matches.status, "settled"), or(eq(matches.p1, userId), eq(matches.p2, userId))))
    .groupBy(matches.mode);
  const rec: PlayerRecord = { w: 0, l: 0, speed: { w: 0, l: 0 }, turf: { w: 0, l: 0 } };
  for (const r of rows) {
    const bucket = r.mode === "turf" ? rec.turf : rec.speed;
    bucket.w += Number(r.w) || 0;
    bucket.l += Number(r.l) || 0;
    rec.w += Number(r.w) || 0;
    rec.l += Number(r.l) || 0;
  }
  return rec;
}

export interface MatchHistoryRow {
  id: string;
  mode: MatchMode;
  opp: string;
  result: "won" | "lost" | "draw" | "void";
  myWins: number;
  oppWins: number;
  wager: number;
  endedAt: string;
}

/** The player's finished matches, newest first — the versus half of /stats. */
export async function myMatches(db: DrizzleDb, userId: string, limit = 15): Promise<MatchHistoryRow[]> {
  const rows = await db
    .select()
    .from(matches)
    .where(and(or(eq(matches.p1, userId), eq(matches.p2, userId)), ne(matches.status, "active")))
    .orderBy(sql`${matches.createdAt} desc`)
    .limit(limit);
  const oppIds = [...new Set(rows.map((m) => (m.p1 === userId ? m.p2 : m.p1)))];
  const handles = oppIds.length
    ? await db.select({ id: users.id, h: users.handle }).from(users).where(inArray(users.id, oppIds))
    : [];
  const hmap = new Map(handles.map((u) => [u.id, u.h]));
  return rows.map((m) => {
    const slot = m.p1 === userId ? "p1" : "p2";
    const oppId = slot === "p1" ? m.p2 : m.p1;
    const result: MatchHistoryRow["result"] =
      m.status === "aborted" ? "void" : m.winner === userId ? "won" : m.winner ? "lost" : "draw";
    const ended = m.settledAt ?? m.createdAt;
    return {
      id: m.id,
      mode: (m.mode as MatchMode) || "speed",
      opp: hmap.get(oppId) || "MYSTERY FRIEND",
      result,
      myWins: slot === "p1" ? m.p1Wins : m.p2Wins,
      oppWins: slot === "p1" ? m.p2Wins : m.p1Wins,
      wager: m.wager,
      endedAt: ended instanceof Date ? ended.toISOString() : String(ended),
    };
  });
}

export async function matchStateFor(db: DrizzleDb, userId: string): Promise<MatchView> {
  const now = Date.now();
  let m = await activeMatchFor(db, userId);

  if (!m) {
    // QUEUED comes before the recently-settled card: a player who re-queued
    // for a rematch has moved on — replaying the old result for two minutes
    // would wedge the lobby. Touch the row so pairing knows we're alive, and
    // attempt a pair right here: joins that crossed (or a partner whose
    // pairing tx hiccuped) would otherwise both sit queued forever, since
    // pairing only ever ran inside joinQueue.
    const [q] = await db.select().from(matchQueue).where(eq(matchQueue.userId, userId)).limit(1);
    if (q) {
      await db.update(matchQueue).set({ enqueuedAt: new Date() }).where(eq(matchQueue.userId, userId));
      const paired = await tryPair(db, userId, q.wager, (q.mode as MatchMode) || "speed").catch(() => false);
      if (paired) m = await activeMatchFor(db, userId);
      if (!m) {
        // Lobby color: who else is out there right now? (drizzle selects —
        // db.execute() returns different shapes on PGlite vs postgres-js.)
        const [wRow] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(matchQueue)
          .where(
            and(
              ne(matchQueue.userId, userId),
              eq(matchQueue.wager, q.wager),
              eq(matchQueue.mode, (q.mode as MatchMode) || "speed"),
              sql`${matchQueue.enqueuedAt} > now() - interval '${sql.raw(String(QUEUE_FRESH_MS / 1000))} seconds'`,
            ),
          );
        const [sRow] = await db
          .select({ n: sql<number>`count(*)::int * 2` })
          .from(matches)
          .where(eq(matches.status, "active"));
        return {
          state: "queued",
          serverNow: now,
          queuedWager: q.wager,
          counts: { waiting: Number(wRow?.n) || 0, smashing: Number(sRow?.n) || 0 },
        };
      }
    }
  }

  if (!m) {
    // Recently settled match? Show the result card once.
    const [done] = await db
      .select()
      .from(matches)
      .where(
        and(
          inArray(matches.status, ["settled", "aborted"]),
          or(eq(matches.p1, userId), eq(matches.p2, userId)),
          sql`${matches.settledAt} > now() - interval '2 minutes'`,
        ),
      )
      .orderBy(sql`${matches.settledAt} DESC`)
      .limit(1);
    if (done) return { state: "over", serverNow: now, result: await resultView(db, done, userId) };
    return { state: "idle", serverNow: now };
  }

  // Ready-up staging: no clocks run until both players tap READY.
  if (isStaging(m)) {
    m = await expireStaging(db, m);
    if (m.status !== "active") {
      return { state: "over", serverNow: now, result: await resultView(db, m, userId) };
    }
    if (isStaging(m)) {
      const slot = slotOf(m, userId)!;
      const oppId = slot === "p1" ? m.p2 : m.p1;
      const [opp] = await db.select({ h: users.handle }).from(users).where(eq(users.id, oppId)).limit(1);
      const oppRec = await oppRecordOf(db, m, slot === "p1" ? "p2" : "p1");
      const r = readyOf(m)!;
      return {
        state: "active",
        serverNow: now,
        mode: (m.mode as MatchMode) || "speed",
        staging: {
          id: m.id,
          myReady: r[slot],
          oppReady: r[slot === "p1" ? "p2" : "p1"],
          oppHandle: opp?.h || "MYSTERY FRIEND",
          oppRecord: oppRec,
          wager: m.wager,
          expiresInMs: Math.max(0, READY_TIMEOUT_MS - (now - new Date(m.createdAt).getTime())),
        },
      };
    }
  }

  // Liveness: expire unsubmitted sides past the deadline, abort stale matches.
  m = (m.mode === "turf" ? await advanceTurf(db, m.id) : await advanceLiveness(db, m.id)) ?? m;
  if (m.status !== "active") {
    return { state: "over", serverNow: now, result: await resultView(db, m, userId) };
  }
  if (m.mode === "turf") return await turfView(db, m, userId, now);

  const slot = slotOf(m, userId)!;
  const rs = roundsOf(m);
  const cur = rs[rs.length - 1];
  const prev = rs.length > 1 ? rs[rs.length - 2] : null;
  const oppId = slot === "p1" ? m.p2 : m.p1;
  const [opp] = await db.select({ h: users.handle }).from(users).where(eq(users.id, oppId)).limit(1);
  // Lifetime record: settled matches with a decided winner (draws/aborts skip).
  const oppRec = await oppRecordOf(db, m, slot === "p1" ? "p2" : "p1");

  const mySide = cur[slot];
  const oppSide = cur[other(slot)];
  return {
    state: "active",
    serverNow: now,
    match: {
      id: m.id,
      round: cur.n,
      bestOf: m.bestOf,
      roundSecs: m.roundSecs,
      winsNeeded: WINS_NEEDED,
      myWins: slot === "p1" ? m.p1Wins : m.p2Wins,
      oppWins: slot === "p1" ? m.p2Wins : m.p1Wins,
      oppHandle: opp?.h || "MYSTERY FRIEND",
      oppRecord: oppRec,
      wager: m.wager,
      startsAt: Date.parse(cur.startsAt),
      deadline: Date.parse(cur.deadline),
      seed: cur.seed,
      runId: mySide.runId,
      runToken: signRunToken({ runId: mySide.runId, userId, seed: cur.seed, issuedAt: Date.parse(cur.startsAt) }),
      myState: mySide.state,
      oppState: oppSide.state,
      myScore: mySide.score,
      // NO live opponent score — round scores are secret until BOTH sides
      // settle (tester call: watching their number mid-round is anti-fun and
      // it was the only consumer of forgeable heartbeats).
      oppScore:
        mySide.state !== "playing" && (oppSide.state === "done" || oppSide.state === "forfeit")
          ? oppSide.score
          : null,
      lastRound: prev
        ? {
            n: prev.n,
            myScore: prev[slot].score ?? 0,
            oppScore: prev[other(slot)].score ?? 0,
            winner: prev.winner === "tie" ? "tie" : prev.winner === slot ? "me" : "them",
            myForfeit: prev[slot].state === "forfeit",
            oppForfeit: prev[other(slot)].state === "forfeit",
          }
        : null,
      config: m.config,
    },
  };
}

async function resultView(db: DrizzleDb, m: Match, userId: string) {
  const slot = slotOf(m, userId)!;
  // How it ended: the deciding game's reason (turf), the last round's shape
  // (speed), a concede (winner set but no deciding reason), or an abort.
  let how: string | null = null;
  if (m.status === "aborted") how = "abort";
  else if (m.mode === "turf") {
    const t = (m.turf ?? { games: [] }) as unknown as TurfState;
    const lastG = t.games.length ? t.games[t.games.length - 1] : null;
    how = lastG?.winner ? (lastG.reason ?? null) : m.winner ? "concede" : null;
  } else if (m.winner) {
    const rs = roundsOf(m);
    const lastR = rs.length ? rs[rs.length - 1] : null;
    how = lastR?.winner && lastR.winner !== "tie" ? "score" : "concede";
  }
  const oppId = slot === "p1" ? m.p2 : m.p1;
  const [opp] = await db.select({ h: users.handle }).from(users).where(eq(users.id, oppId)).limit(1);
  const won = m.winner === userId;
  const draw = m.status === "settled" && !m.winner;
  const aborted = m.status === "aborted";
  // Match ended on a pure row: ship the final board so the client can play the
  // row FX before the verdict card (the loser never saw the winning move).
  let turfFinal: { placements: Array<{ t: string; r: number; x: number; y: number; team: string }>; row: number | null } | null = null;
  if (m.mode === "turf" && how === "row") {
    const t = (m.turf ?? { games: [] }) as unknown as TurfState;
    const lastG = t.games.length ? t.games[t.games.length - 1] : null;
    if (lastG?.winner) {
      turfFinal = {
        placements: lastG.placements.map((p) => ({ t: p.t, r: p.r, x: p.x, y: p.y, team: teamOf(p.by), auto: !!p.auto })),
        row: pureRowFor(turfGrid(lastG.placements), lastG.winner),
      };
    }
  }
  return {
    id: m.id,
    won,
    draw,
    aborted,
    how,
    turfFinal,
    myWins: slot === "p1" ? m.p1Wins : m.p2Wins,
    oppWins: slot === "p1" ? m.p2Wins : m.p1Wins,
    winsNeeded: m.mode === "turf" ? TURF_WINS_NEEDED : WINS_NEEDED,
    wager: m.wager,
    payout: won ? m.wager * 2 - versusRake(m.wager) : draw || aborted ? m.wager : 0,
    oppHandle: opp?.h || "MYSTERY FRIEND",
  };
}

/**
 * Forfeit expired sides of the current round and terminate dead matches.
 * Runs under the match row lock; safe under concurrent polls from both
 * players (second poller sees the already-advanced state).
 */
async function advanceLiveness(db: DrizzleDb, matchId: string): Promise<Match | null> {
  return await db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("update");
    if (!m || m.status !== "active") return m ?? null;
    const now = Date.now();

    // Hard age cap: something is deeply wrong — abort and refund.
    if (now - new Date(m.createdAt).getTime() > MAX_MATCH_AGE_MS) {
      return await settleLocked(tx, m, { abort: true });
    }

    const rs = roundsOf(m);
    const cur = rs[rs.length - 1];
    if (!cur || now < Date.parse(cur.deadline)) return m;

    // Deadline passed: any side still 'playing' forfeits (score 0) — UNLESS
    // its run row already verified/rejected. finishVersusRound flips the run
    // in one tx and records into the match in a second; a poll landing in
    // that gap must ADOPT the settled score, not forfeit a delivered round.
    let changed = false;
    for (const s of ["p1", "p2"] as const) {
      if (cur[s].state === "playing") {
        // LOCK the run row. finishVersusRound's flip tx takes this same lock,
        // so the two serialize instead of racing. Unlocked, a score that
        // verified in the read→write gap (one Vercel↔Railway RTT; a
        // backgrounded phone submitting at the buzzer hits it) was
        // overwritten with forfeit/0 and the pot paid the WRONG player
        // (concurrency audit, 2026-07-29 — the only wager-integrity race
        // reachable in normal play).
        const [r] = await tx
          .select({ status: runs.status, score: runs.score })
          .from(runs)
          .where(eq(runs.id, cur[s].runId))
          .for("update");
        const adopt = (status: string, score: number) => {
          cur[s] = { ...cur[s], state: "done", score, live: score, ...(status === "rejected" ? { rejected: true } : {}) };
        };
        if (r && (r.status === "verified" || r.status === "rejected")) {
          adopt(r.status, r.status === "verified" ? Number(r.score ?? 0) : 0);
        } else {
          const killed = await tx
            .update(runs)
            .set({ status: "abandoned", finishedAt: new Date() })
            .where(and(eq(runs.id, cur[s].runId), eq(runs.status, "open")))
            .returning({ id: runs.id });
          if (killed.length) {
            cur[s] = { ...cur[s], state: "forfeit", score: 0 };
          } else {
            // The row wasn't 'open' after all (belt-and-braces if the lock
            // above ever fails to hold, as it once did in prod): re-read and
            // ADOPT the truth. Never forfeit a delivered round.
            const [r2] = await tx
              .select({ status: runs.status, score: runs.score })
              .from(runs)
              .where(eq(runs.id, cur[s].runId));
            if (r2 && (r2.status === "verified" || r2.status === "rejected")) {
              adopt(r2.status, r2.status === "verified" ? Number(r2.score ?? 0) : 0);
            } else {
              cur[s] = { ...cur[s], state: "forfeit", score: 0 };
            }
          }
        }
        changed = true;
      }
    }
    if (!changed) return m;
    return await concludeRoundLocked(tx, m, rs);
  });
}

/* ------------------------------------------------ heartbeat */

/** Live score tick (display only). jsonb_set on the caller's slot — atomic,
 *  no read-modify-write race with the opponent's concurrent heartbeat. */
export async function heartbeat(
  db: DrizzleDb,
  params: { matchId: string; userId: string; round: number; score: number },
): Promise<void> {
  const { matchId, userId } = params;
  const round = Math.trunc(params.round);
  const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!m || m.status !== "active" || m.round !== round) return;
  const slot = slotOf(m, userId);
  if (!slot) return;
  const idx = roundsOf(m).length - 1;
  if (idx < 0) return;
  // Plausibility clamp: heartbeats are client-claimed display values, and a
  // forged "999999" is a psy-op to scare the opponent into conceding a
  // wagered match. Cap at the anti-cheat scoring ceiling for the elapsed
  // play time — generous for honest play, ruinous for theater.
  const elapsedSec = Math.max(1, (Date.now() - Date.parse(roundsOf(m)[idx].startsAt)) / 1000);
  const cap = Math.ceil(elapsedSec * MAX_SCORE_PER_SEC);
  const score = Math.max(0, Math.min(cap, Math.trunc(params.score) || 0));
  await db
    .update(matches)
    .set({
      rounds: sql`jsonb_set(${matches.rounds}, ${`{${idx},${slot},live}`}::text[], to_jsonb(${score}::int))`,
    })
    .where(and(eq(matches.id, matchId), eq(matches.status, "active"), eq(matches.round, round)));
}

/* ------------------------------------------------ round submit */

export interface RoundFinishResult {
  ok: boolean;
  score: number;
  rejected?: boolean;
  reason?: string;
}

/**
 * Submit my side of the current round. Replay-verifies exactly like a solo
 * finish (same pipeline, same snapshot rules) with versus extras:
 *   - power-up events in the log fail the round (they're disabled in versus);
 *   - duration must fit the 60s window (+ small slack);
 *   - a rejected replay scores 0 — the round continues, the cheat just loses.
 * Then, under the match lock, records the score and advances the round /
 * match state machine (conclude, next round, or settle + payout).
 */
export async function finishVersusRound(
  db: DrizzleDb,
  params: { matchId: string; userId: string; runId: string; summary: RunSummary; log?: InputEvent[] },
): Promise<RoundFinishResult> {
  const { matchId, userId, runId, summary, log } = params;
  const storedLog = Array.isArray(log) ? log.slice(0, MAX_LOG_EVENTS) : null;

  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId), eq(runs.matchId, matchId)))
    .limit(1);
  if (!run || run.mode !== "versus") return { ok: false, score: 0, reason: "round not found" };
  if (run.status !== "open") return { ok: false, score: 0, reason: "round already submitted" };
  if (Array.isArray(log) && log.length > MAX_LOG_EVENTS) {
    // Same status-guarded flip as every other run writer — an unguarded
    // update here could clobber a row a concurrent poll already abandoned.
    await db
      .update(runs)
      .set({ status: "rejected", finishedAt: new Date() })
      .where(and(eq(runs.id, runId), eq(runs.status, "open")));
    logAntiCheatRejection({ userId, runId, reason: "versus log too large", score: 0, lines: 0, ip: run.ip });
    return await recordRoundScore(db, matchId, userId, runId, 0, true, "input log too large");
  }

  // ---- replay verification (server-authoritative) ----
  let score = 0;
  let lines = 0;
  let rejectedReason: string | null = null;

  if (storedLog?.length && storedLog.some((ev) => ev.a === "powerup")) {
    rejectedReason = "power-ups are disabled in versus";
  } else {
    const roundMs = ROUND_SECS * 1000;
    if ((Math.trunc(summary.durationMs) || 0) > roundMs + 5_000) {
      rejectedReason = "round overran the clock";
    } else if (storedLog?.length) {
      const snapScoring = sanitizeScoring(
      run.config ? (run.config as { scoring?: unknown }).scoring : null,
    );
    const replay = replayRun(run.seed, storedLog, summary, snapScoring);
      if (!replay.ok) rejectedReason = replay.reason ?? "replay failed";
      else {
        const claimedLines = (summary.locks || []).reduce((a, b) => a + b, 0);
        if (claimedLines !== replay.lines) rejectedReason = "replay diverged from reported clears";
        else {
          score = replay.score;
          lines = replay.lines;
          const scored = { ok: true, score, lines, level: levelForLines(lines), reason: undefined };
          rejectedReason = sanityCheck(summary, scored) || checkTiming(storedLog, summary.durationMs);
        }
      }
    } else {
      // No log = no verified score. (A real client always sends one.)
      const scored = scoreSummary(summary);
      rejectedReason = scored.ok ? "versus requires an input log" : (scored.reason ?? "rejected");
    }
  }

  const rejected = rejectedReason !== null;
  const finalScore = rejected ? 0 : score;

  // Flip the run row (lock + status re-check → at-most-once).
  const flipped = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).for("update");
    if (!locked || locked.status !== "open") return false;
    await tx
      .update(runs)
      .set({
        status: rejected ? "rejected" : "verified",
        score: finalScore,
        lines,
        durationMs: Math.max(0, Math.trunc(summary.durationMs) || 0),
        inputLog: storedLog,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId));
    return true;
  });
  if (!flipped) return { ok: false, score: 0, reason: "round already submitted" };
  if (rejected) {
    logAntiCheatRejection({ userId, runId, reason: rejectedReason!, score, lines, ip: run.ip });
  }

  return await recordRoundScore(db, matchId, userId, runId, finalScore, rejected, rejectedReason ?? undefined);
}

/** Write my verified score into the round and advance the state machine. */
async function recordRoundScore(
  db: DrizzleDb,
  matchId: string,
  userId: string,
  runId: string,
  score: number,
  rejected: boolean,
  reason?: string,
): Promise<RoundFinishResult> {
  const recorded = await db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("update");
    if (!m || m.status !== "active") return false;
    const rs = roundsOf(m);
    const cur = rs[rs.length - 1];
    const slot = slotOf(m, userId);
    if (!cur || !slot || cur[slot].runId !== runId) return false; // stale round
    if (cur[slot].state !== "playing") return false; // already recorded/forfeited
    cur[slot] = { ...cur[slot], state: "done", score, live: score, ...(rejected ? { rejected: true } : {}) };
    await concludeRoundLocked(tx, m, rs);
    return true;
  });
  // ok=false = the round settled without this submission (forfeited by the
  // deadline, or the match ended) — honest signal, the client just moves on.
  return { ok: recorded, score, rejected: rejected || undefined, reason: recorded ? reason : (reason ?? "round already settled") };
}

/** With the match row locked: persist round state; when both sides are
 *  settled decide the round, then either settle the match or open the next
 *  round. Single writer per transition — polls and finishes all funnel here. */
async function concludeRoundLocked(tx: DrizzleDb, m: Match, rs: MatchRound[]): Promise<Match> {
  const cur = rs[rs.length - 1];
  const bothDone = cur.p1.state !== "playing" && cur.p2.state !== "playing";

  if (!bothDone) {
    await tx.update(matches).set({ rounds: rs }).where(eq(matches.id, m.id));
    return { ...m, rounds: rs as unknown as Match["rounds"] };
  }

  // Both sides settled → decide the round.
  const bothForfeit = cur.p1.state === "forfeit" && cur.p2.state === "forfeit";
  cur.winner = decideRound(cur.p1.score ?? 0, cur.p2.score ?? 0);
  if (bothForfeit) cur.winner = "tie"; // nobody played; no point either way
  let p1Wins = m.p1Wins + (cur.winner === "p1" ? 1 : 0);
  let p2Wins = m.p2Wins + (cur.winner === "p2" ? 1 : 0);

  // Two dead rounds in a row = both players gone → abort + refund.
  const prev = rs.length > 1 ? rs[rs.length - 2] : null;
  const prevBothForfeit = prev ? prev.p1.state === "forfeit" && prev.p2.state === "forfeit" : false;
  if (bothForfeit && prevBothForfeit) {
    await tx.update(matches).set({ rounds: rs, p1Wins, p2Wins }).where(eq(matches.id, m.id));
    return await settleLocked(tx, { ...m, rounds: rs as unknown as Match["rounds"], p1Wins, p2Wins }, { abort: true });
  }

  const verdict = matchVerdict(p1Wins, p2Wins, rs.length);
  if (verdict) {
    await tx.update(matches).set({ rounds: rs, p1Wins, p2Wins }).where(eq(matches.id, m.id));
    const updated = { ...m, rounds: rs as unknown as Match["rounds"], p1Wins, p2Wins };
    return await settleLocked(tx, updated, verdict === "draw" ? { draw: true } : { winnerSlot: verdict });
  }

  // Next round.
  const next = await createRound(
    tx,
    m.id,
    (m.config ?? undefined) as GameConfig,
    m.p1,
    m.p2,
    rs.length + 1,
    new Date(Date.now() + INTERMISSION_MS),
  );
  rs.push(next);
  await tx
    .update(matches)
    .set({ rounds: rs, p1Wins, p2Wins, round: next.n })
    .where(eq(matches.id, m.id));
  return { ...m, rounds: rs as unknown as Match["rounds"], p1Wins, p2Wins, round: next.n };
}

/* ------------------------------------------------ settlement */

/**
 * Terminal transition — MUST be called with the match row locked and status
 * 'active' (checked again here). Pays out / refunds the MOCK-RF escrow,
 * idempotent via the ledger unique guard even if a bug ever re-entered.
 */
async function settleLocked(
  tx: DrizzleDb,
  m: Match,
  outcome: { winnerSlot?: Slot; draw?: boolean; abort?: boolean },
): Promise<Match> {
  if (m.status !== "active") return m;
  const status = outcome.abort ? "aborted" : "settled";
  const winnerId = outcome.winnerSlot ? (outcome.winnerSlot === "p1" ? m.p1 : m.p2) : null;

  // THE STATUS FLIP IS THE COMPARE-AND-SWAP. The in-memory re-check above
  // trusts the row lock; prod has already proven once (the turf overlap that
  // motivated claimTurfRev) that the lock can fail to hold end-to-end. With
  // `AND status='active'` a lost race becomes a no-op instead of a double
  // payout: the win/refund legs use DIFFERENT ledger refIds, so the ledger's
  // unique guard cannot catch two divergent outcomes (win+win, or win+refund
  // = 2× the pot minted from nothing). Credits below run ONLY if we won it.
  const flipped = await tx
    .update(matches)
    .set({ status, winner: winnerId, settledAt: new Date() })
    .where(and(eq(matches.id, m.id), eq(matches.status, "active")))
    .returning({ id: matches.id });
  if (!flipped.length) {
    logInfo("match.settle.lost", { matchId: m.id, attempted: status });
    const [fresh] = await tx.select().from(matches).where(eq(matches.id, m.id));
    return fresh ?? m;
  }

  // Close any still-open versus runs of this match (nothing may finish later).
  await tx
    .update(runs)
    .set({ status: "abandoned", finishedAt: new Date() })
    .where(and(eq(runs.matchId, m.id), eq(runs.status, "open")));

  if (m.wager > 0) {
    // Pay out of escrow. Decisive result: winner takes the pot minus a 5%
    // rake that is BURNED. Draw/abort: both stakes refunded in full.
    const t = tx as unknown as DrizzleDb;
    const escrow = await systemAccountId(t, SYSTEM.escrow);
    const pay = (to: string, amount: number, reason: string, refId: string) =>
      amount > 0 ? transferTx(t, { from: escrow, to, amount, reason, refId }) : Promise.resolve(null);
    if (winnerId) {
      const rake = versusRake(m.wager);
      await pay(winnerId, m.wager * 2 - rake, "versus:win", m.id);
      if (rake > 0) {
        const burn = await systemAccountId(t, SYSTEM.burn);
        await pay(burn, rake, "versus:rake", m.id);
      }
    } else {
      await pay(m.p1, m.wager, "versus:refund", `${m.id}:p1`);
      await pay(m.p2, m.wager, "versus:refund", `${m.id}:p2`);
    }
  }
  return { ...m, status, winner: winnerId };
}

/* ------------------------------------------------ ready-up gate */

type ReadyState = { p1: boolean; p2: boolean };
const readyOf = (m: Match): ReadyState | null => (m.ready as ReadyState | null) ?? null;
/** Matches created before the ready gate shipped have ready=null → not staging. */
const isStaging = (m: Match): boolean => {
  const r = readyOf(m);
  return !!r && !(r.p1 && r.p2);
};

/**
 * Tap READY. When the second player readies, round/game 1 is minted HERE with
 * fresh clocks — nobody's shot clock or countdown ran while anyone was
 * reading the rules. Idempotent per player.
 */
export async function markReady(db: DrizzleDb, matchId: string, userId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("update");
    if (!m || m.status !== "active") return false;
    const slot = slotOf(m, userId);
    if (!slot) return false;
    const r = readyOf(m) ?? { p1: true, p2: true };
    if (r[slot]) return true; // already ready — idempotent
    r[slot] = true;
    if (r.p1 && r.p2) {
      if (m.mode === "turf") {
        const t = turfOf(m) as TurfState & { rev?: number };
        if (!t.games.length) {
          const g = newTurfGame(1);
          g.deadline = new Date(Date.now() + TURF_TURN_MS + 5_000).toISOString();
          t.games.push(g);
        }
        t.rev = Number(t.rev ?? 0) + 1;
        await tx.update(matches).set({ ready: r, turf: t }).where(eq(matches.id, m.id));
      } else {
        const rs = roundsOf(m);
        if (!rs.length) {
          const round1 = await createRound(
            tx as unknown as DrizzleDb,
            m.id,
            (m.config ?? undefined) as GameConfig,
            m.p1,
            m.p2,
            1,
            new Date(Date.now() + COUNTDOWN_MS),
          );
          rs.push(round1);
        }
        await tx.update(matches).set({ ready: r, rounds: rs }).where(eq(matches.id, m.id));
      }
    } else {
      await tx.update(matches).set({ ready: r }).where(eq(matches.id, m.id));
    }
    return true;
  });
}

/** Staging liveness: a match where someone never readies aborts with refunds. */
async function expireStaging(db: DrizzleDb, m: Match): Promise<Match> {
  if (Date.now() - new Date(m.createdAt).getTime() <= READY_TIMEOUT_MS) return m;
  return await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(matches).where(eq(matches.id, m.id)).for("update");
    if (!locked || locked.status !== "active" || !isStaging(locked)) return locked ?? m;
    return await settleLocked(tx, locked, { abort: true });
  });
}

/* ------------------------------------------------ TURF WAR (mode #2) */

const turfOf = (m: Match): TurfState => (m.turf ?? { games: [] }) as unknown as TurfState;

/**
 * Claim the turf-write lock via a guarded UPDATE (optimistic rev counter).
 * An UPDATE always takes a real row lock regardless of driver quirks with
 * SELECT ... FOR UPDATE — added after prod stored an overlapping placement
 * that should have been impossible under the assumed locking. Returns the
 * new rev to stamp on the final write, or null when another writer won
 * (caller returns 'busy'; the client just re-polls).
 */
async function claimTurfRev(tx: DrizzleDb, matchId: string, t: TurfState & { rev?: number }): Promise<number | null> {
  const rev0 = Number(t.rev ?? 0);
  const res = await tx
    .update(matches)
    .set({ turf: sql`jsonb_set(coalesce(${matches.turf}, '{"games":[]}'::jsonb), '{rev}', to_jsonb(${rev0 + 1}::int))` })
    .where(
      and(
        eq(matches.id, matchId),
        sql`coalesce((${matches.turf}->>'rev')::int, 0) = ${rev0}`,
      ),
    )
    .returning({ id: matches.id });
  return res.length ? rev0 + 1 : null;
}
const curGame = (t: TurfState): TurfGame => t.games[t.games.length - 1];
const teamOf = (s: TurfSlot): "pink" | "blue" => (s === "p1" ? "pink" : "blue");

/** Client view of a turf match (opponent record queries shared with speed). */
async function turfView(db: DrizzleDb, m: Match, userId: string, now: number): Promise<MatchView> {
  const slot = slotOf(m, userId)!;
  const oppId = slot === "p1" ? m.p2 : m.p1;
  const [opp] = await db.select({ h: users.handle }).from(users).where(eq(users.id, oppId)).limit(1);
  const oppRec = await oppRecordOf(db, m, slot === "p1" ? "p2" : "p1");
  const t = turfOf(m);
  const g = curGame(t);
  const prev = t.games.length > 1 ? t.games[t.games.length - 2] : null;
  return {
    state: "active",
    serverNow: now,
    mode: "turf",
    turf: {
      id: m.id,
      rulesV: TURF_RULES_V,
      game: g.n,
      bestOf: TURF_BEST_OF,
      winsNeeded: TURF_WINS_NEEDED,
      myWins: slot === "p1" ? m.p1Wins : m.p2Wins,
      oppWins: slot === "p1" ? m.p2Wins : m.p1Wins,
      oppHandle: opp?.h || "MYSTERY FRIEND",
      oppRecord: oppRec,
      wager: m.wager,
      myTeam: teamOf(slot),
      myTurn: g.turn === slot && !g.winner,
      moveN: g.moveN,
      piece: g.pieces[g.moveN],
      next: g.pieces.slice(g.moveN + 1, g.moveN + 3),
      deadline: Date.parse(g.deadline),
      placements: g.placements.map((p) => ({ t: p.t, r: p.r, x: p.x, y: p.y, team: teamOf(p.by), auto: !!p.auto })),
      lastGame: prev
        ? {
            n: prev.n,
            winner: prev.winner === slot ? "me" : "them",
            reason: prev.reason ?? "row",
            // Finished board + winning row: the client plays the row FX before
            // the verdict splash (the loser never saw the winning placement).
            placements: prev.placements.map((p) => ({ t: p.t, r: p.r, x: p.x, y: p.y, team: teamOf(p.by), auto: !!p.auto })),
            row: prev.winner && prev.reason === "row" ? pureRowFor(turfGrid(prev.placements), prev.winner) : null,
          }
        : null,
    },
  };
}

/** With the match locked: bank the finished game, then next game or settle. */
async function concludeTurfGameLocked(tx: DrizzleDb, m: Match, t: TurfState): Promise<Match> {
  const g = curGame(t);
  if (!g.winner) {
    await tx.update(matches).set({ turf: t }).where(eq(matches.id, m.id));
    return { ...m, turf: t as unknown as Match["turf"] };
  }
  // DEAD game (mutual absence — zero human moves): two in a row abort the
  // match with refunds, mirroring speed mode. Slot parity must never pay
  // a pot to whoever happened to be seated second.
  if (!(g.realMoves || 0)) {
    const prevG = t.games.length > 1 ? t.games[t.games.length - 2] : null;
    if (prevG && !(prevG.realMoves || 0)) {
      await tx.update(matches).set({ turf: t }).where(eq(matches.id, m.id));
      return await settleLocked(tx, { ...m, turf: t as unknown as Match["turf"] }, { abort: true });
    }
  }
  const p1Wins = m.p1Wins + (g.winner === "p1" ? 1 : 0);
  const p2Wins = m.p2Wins + (g.winner === "p2" ? 1 : 0);
  if (p1Wins >= TURF_WINS_NEEDED || p2Wins >= TURF_WINS_NEEDED) {
    await tx.update(matches).set({ turf: t, p1Wins, p2Wins }).where(eq(matches.id, m.id));
    return await settleLocked(
      tx,
      { ...m, turf: t as unknown as Match["turf"], p1Wins, p2Wins },
      { winnerSlot: p1Wins >= TURF_WINS_NEEDED ? "p1" : "p2" },
    );
  }
  const nextG = newTurfGame(t.games.length + 1);
  // Breather: the first shot clock of a new game starts AFTER the verdict
  // splash has had its moment (clients render a NEXT GAME countdown).
  nextG.deadline = new Date(Date.now() + TURF_INTERGAME_MS + 10_000).toISOString();
  t.games.push(nextG);
  await tx
    .update(matches)
    .set({ turf: t, p1Wins, p2Wins, round: t.games.length })
    .where(eq(matches.id, m.id));
  return { ...m, turf: t as unknown as Match["turf"], p1Wins, p2Wins };
}

/** Poll-driven turf liveness: shot-clock expiries + the stale-match abort. */
async function advanceTurf(db: DrizzleDb, matchId: string): Promise<Match | null> {
  return await db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("update");
    if (!m || m.status !== "active") return m ?? null;
    if (Date.now() - new Date(m.createdAt).getTime() > MAX_MATCH_AGE_MS) {
      return await settleLocked(tx, m, { abort: true });
    }
    const t = turfOf(m) as TurfState & { rev?: number };
    const g = curGame(t);
    if (!g) return m;
    // Peek first: only claim the write lock when a deadline actually expired.
    if (Date.now() < Date.parse(g.deadline) + 3_000) return m;
    const rev = await claimTurfRev(tx, m.id, t);
    if (rev === null) return m; // another writer is on it — our poll just reads
    t.rev = rev;
    // A poll can clear several expired turns in one pass (both players gone).
    let out = m;
    for (let hops = 0; hops < 4; hops++) {
      const tick = tickTurfGame(curGame(t), Date.now());
      if (tick.kind === "waiting") break;
      logInfo("turf.tick", { matchId: m.id, kind: tick.kind, game: curGame(t).n, moveN: curGame(t).moveN });
      out = await concludeTurfGameLocked(tx, out, t);
      if (out.status !== "active" || tick.kind === "auto-placed") break;
    }
    return out;
  });
}

export interface TurfPlaceResult {
  ok: boolean;
  error?: string;
  gameOver?: { winner: "me" | "them"; reason: "row" | "squeeze" };
}

/**
 * Play my turn. The server referees the whole move under the match lock:
 * turn/deadline/piece/geometry checks, then the drop, the win/loss check,
 * and any game/match settlement — all in one transaction. moveN makes
 * retries idempotent (a duplicate is just "stale move").
 */
export async function placeTurfMove(
  db: DrizzleDb,
  params: { matchId: string; userId: string; moveN: number; t: PieceType; r: number; x: number; y: number },
): Promise<TurfPlaceResult> {
  const { matchId, userId } = params;
  return await db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("update");
    if (!m || m.status !== "active" || m.mode !== "turf") return { ok: false, error: "match not active" };
    const slot = slotOf(m, userId);
    if (!slot) return { ok: false, error: "not your match" };
    const t = turfOf(m) as TurfState & { rev?: number };
    const g = curGame(t);
    if (!g || g.winner) return { ok: false, error: "game already decided" };

    // Write-lock the turf state (see claimTurfRev) BEFORE any mutation.
    const rev = await claimTurfRev(tx, m.id, t);
    if (rev === null) {
      logInfo("turf.place.busy", { matchId: m.id, slot, moveN: params.moveN });
      return { ok: false, error: "busy — try again" };
    }
    t.rev = rev;

    // Expired clock? The timeout machinery wins — the move arrived too late.
    const tick = tickTurfGame(g, Date.now());
    if (tick.kind !== "waiting") {
      logInfo("turf.place.expired", { matchId: m.id, slot, moveN: params.moveN, tick: tick.kind });
      await concludeTurfGameLocked(tx, m, t);
      return { ok: false, error: "shot clock expired" };
    }

    const res = applyTurfMove(g, slot, { moveN: params.moveN, t: params.t, r: params.r, x: params.x, y: params.y });
    logInfo("turf.place", {
      matchId: m.id, slot, moveN: params.moveN, piece: params.t, r: params.r, x: params.x, y: params.y,
      verdict: res.kind, error: res.kind === "illegal" ? res.error : undefined,
      boardMoveN: g.moveN, turn: g.turn, placements: g.placements.length,
    });
    if (res.kind === "illegal") return { ok: false, error: res.error };
    const after = await concludeTurfGameLocked(tx, m, t);
    void after;
    if (res.kind === "game-over") {
      return { ok: true, gameOver: { winner: res.winner === slot ? "me" : "them", reason: res.reason } };
    }
    return { ok: true };
  });
}

/** Concede the whole match (quit button). Opponent wins and is paid out. */
export async function concedeMatch(db: DrizzleDb, matchId: string, userId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("update");
    if (!m || m.status !== "active") return false;
    const slot = slotOf(m, userId);
    if (!slot) return false;
    await settleLocked(tx, m, { winnerSlot: other(slot) });
    return true;
  });
}
