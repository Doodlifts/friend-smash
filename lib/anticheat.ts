/* ============================================================
   lib/anticheat.ts — server-authoritative run scoring + validation.

   THE RULE: never trust a client-reported score. The server decides.

   Phase 2 (this file, interim): the client submits a structured, ordered
   summary of per-lock outcomes (how many lines each piece-lock cleared) plus
   soft/hard-drop cell counts. The server RE-COMPUTES the score from those
   events using the canonical scoring state machine in lib/scoring — so the
   score is internally consistent with the rules and centralized on the server.

   Phase 3 (hardening): replace scoreSummary() with a full DETERMINISTIC REPLAY
   of the raw input log (InputEvent[]) through a headless engine seeded with the
   server's seed, so the per-lock outcomes can't be forged at all; plus physical
   sanity limits and rate limits. The raw `log` is already captured + stored now
   so historical runs can be re-validated once replay lands.

   Pure module — no DOM, no DB, no randomness.
   ============================================================ */

import { scoreClear, levelForLines, softDropPoints, hardDropPoints } from "./scoring";

/** Raw timestamped input, captured now and stored for Phase-3 replay. */
export interface InputEvent {
  t: number; // ms from run start
  a: "m" | "rot" | "sd" | "hd" | "hold" | "lock" | "powerup"; // action
  [k: string]: unknown;
}

/** Per-run summary the client submits at game over (Phase-2 scoring input). */
export interface RunSummary {
  /** Lines cleared by each piece-lock, in order (0 = no clear). */
  locks: number[];
  /** Total cells descended via soft drop (1 pt each). */
  softDropCells: number;
  /** Total cells descended via hard drop (2 pts each). */
  hardDropCells: number;
  /** Run duration in ms (client clock; sanity-checked, not trusted for score). */
  durationMs: number;
}

export interface ScoredRun {
  ok: boolean;
  score: number;
  lines: number;
  level: number;
  reason?: string;
}

/** Maximum plausible score per second (loose Phase-2 guard; tightened in P3). */
export const MAX_SCORE_PER_SEC = 5000;
/** Hard cap on locks per run (sanity; a very long run is still far below this). */
export const MAX_LOCKS = 100000;
/**
 * Hard cap on raw input-log events accepted for replay. A real run is a few
 * thousand events (a long 500-line game is ~15–20k); this is generous headroom.
 * Logs above it are rejected BEFORE the expensive replay (DoS guard).
 */
export const MAX_LOG_EVENTS = 60000;
/** Sustained input rate ceiling (human peak is ~10–15/s; this is generous). */
export const MAX_INPUTS_PER_SEC = 40;
/** Sustained piece-lock rate ceiling (hard-drop spam guard). */
export const MAX_PIECES_PER_SEC = 20;

/**
 * Physical-timing validation of the raw input log. Catches non-monotonic or
 * out-of-bounds timestamps and superhuman input/piece rates. Returns null if OK,
 * else a rejection reason.
 */
export function checkTiming(log: InputEvent[], durationMs: number): string | null {
  if (!Array.isArray(log) || log.length === 0) return null;
  let last = 0;
  for (const ev of log) {
    if (typeof ev.t !== "number" || !Number.isFinite(ev.t) || ev.t < 0) {
      return "bad event timestamp";
    }
    if (ev.t < last - 50) return "non-monotonic timestamps"; // small slack for jitter
    if (ev.t > last) last = ev.t;
  }
  const spanMs = Math.max(durationMs || 0, last);
  if (spanMs <= 0) return "zero-length run";
  const secs = spanMs / 1000;
  if (log.length / secs > MAX_INPUTS_PER_SEC) return "input rate above human max";
  const locks = log.reduce((n, e) => n + (e.a === "lock" ? 1 : 0), 0);
  if (locks / secs > MAX_PIECES_PER_SEC) return "piece rate above human max";
  return null;
}

/**
 * Re-compute the authoritative score from the reported per-lock outcomes.
 * Mirrors the engine exactly: a non-clearing lock (0) resets the combo;
 * a clearing lock runs scoreClear() with the running level/b2b/combo state;
 * the level advances every 10 lines; soft/hard drops add their per-cell points.
 */
export function scoreSummary(summary: RunSummary): ScoredRun {
  const { locks, softDropCells, hardDropCells } = summary;
  if (!Array.isArray(locks)) return fail("missing locks");
  if (locks.length > MAX_LOCKS) return fail("too many locks");
  if (!Number.isFinite(softDropCells) || softDropCells < 0) return fail("bad soft drop count");
  if (!Number.isFinite(hardDropCells) || hardDropCells < 0) return fail("bad hard drop count");

  let score = 0;
  let lines = 0;
  let level = 1;
  let combo = -1;
  let b2b = false;

  for (const n of locks) {
    if (!Number.isInteger(n) || n < 0 || n > 4) return fail("invalid lock outcome");
    if (n === 0) {
      combo = -1; // non-clearing lock breaks the combo (matches lockPiece)
      continue;
    }
    const res = scoreClear(n, { level, b2b, combo });
    score += res.points;
    b2b = res.b2b;
    combo = res.combo;
    lines += n;
    level = levelForLines(lines);
  }

  // Soft/hard drop points are additive and order-independent.
  score += softDropPoints(softDropCells);
  score += hardDropPoints(hardDropCells);

  return { ok: true, score, lines, level };
}

/**
 * Light physical-plausibility checks. Phase 3 expands this (per-input timing,
 * reachability, replay divergence). Returns null if OK, else a rejection reason.
 */
export function sanityCheck(summary: RunSummary, scored: ScoredRun): string | null {
  if (!scored.ok) return scored.reason ?? "scoring failed";
  if (!Number.isFinite(summary.durationMs) || summary.durationMs <= 0) {
    return "implausible duration";
  }
  const seconds = summary.durationMs / 1000;
  if (scored.score / seconds > MAX_SCORE_PER_SEC) {
    return "score per second above plausible max";
  }
  const totalLines = summary.locks.reduce((a, b) => a + b, 0);
  if (totalLines !== scored.lines) return "line count mismatch";
  return null;
}

function fail(reason: string): ScoredRun {
  return { ok: false, score: 0, lines: 0, level: 1, reason };
}
