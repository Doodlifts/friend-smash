/* ============================================================
   lib/scoring.ts — canonical scoring rules.

   SHARED between client and server. The server replays a run's input
   log through the engine and calls these exact functions to compute the
   authoritative score (see anti-cheat). The client calls the same
   functions so what the player sees matches what the server certifies.

   These are pure functions — no DOM, no globals, no randomness.
   Mirrors the scoring in the original index.html (finishClear /
   hardDrop / softDrop / level progression / gravity).
   ============================================================ */

/** Base line-clear points by number of rows cleared (index 0 = no clear). */
export const LINE_CLEAR_BASE = [0, 100, 300, 500, 800] as const;

/** Back-to-back tetris (4-line) multiplier. */
export const B2B_MULTIPLIER = 1.5;

/** Per-cell points awarded for soft-dropping (one point per cell descended). */
export function softDropPoints(cells: number): number {
  return Math.max(0, cells);
}

/** Per-cell points awarded for hard-dropping (two points per cell). */
export function hardDropPoints(cells: number): number {
  return Math.max(0, cells) * 2;
}

/**
 * SCORING ALGORITHM VERSION. 1 = the original rules. 2 = adds the SMASH-clear
 * bonus below. Per-run config SNAPSHOTS carry the version a run was PLAYED
 * under, so in-flight runs and historical leaderboard scores keep their rules
 * (same discipline as BONUS_ALGO_V).
 */
export const SCORING_ALGO_V = 2;

/** Flat bonus (times level) for a line clear committed with a SMASH. */
export const SMASH_CLEAR_BONUS = 50;

/**
 * Points for clearing line(s) with a hard drop — the game is called SMASH, so
 * the signature gesture pays. Deliberately FLAT (not a multiplier): a
 * multiplier would compound with back-to-back and combo and distort scoring at
 * the top end.
 */
export function smashClearPoints(level: number): number {
  return SMASH_CLEAR_BONUS * Math.max(1, level);
}

export interface ClearState {
  /** Current level (affects the multiplier). */
  level: number;
  /** Whether the previous clear was a back-to-back-eligible tetris. */
  b2b: boolean;
  /**
   * Combo counter as tracked by the engine. Starts at -1 between piece
   * sequences; incremented on every line-clearing lock. A value > 0 (i.e.
   * the 2nd consecutive clear onward) adds the combo bonus.
   */
  combo: number;
}

export interface ClearResult {
  /** Points to add to the score for this clear. */
  points: number;
  /** New back-to-back flag after this clear. */
  b2b: boolean;
  /** New combo counter after this clear. */
  combo: number;
}

/**
 * Score a line clear of `n` rows. Mirrors finishClear() exactly:
 *   base  = LINE_CLEAR_BASE[n]
 *   pts   = base * level
 *   if (n === 4 && b2b) pts = floor(pts * 1.5)
 *   b2b   = (n === 4)
 *   combo = combo + 1
 *   if (combo > 0) pts += 50 * combo * level
 */
export function scoreClear(n: number, s: ClearState): ClearResult {
  const base = LINE_CLEAR_BASE[n] ?? 0;
  let pts = base * s.level;
  if (n === 4 && s.b2b) pts = Math.floor(pts * B2B_MULTIPLIER);
  const b2b = n === 4;
  const combo = s.combo + 1;
  if (combo > 0) pts += 50 * combo * s.level;
  return { points: pts, b2b, combo };
}

/** Level for a given total line count: every 10 lines advances a level. */
export function levelForLines(lines: number): number {
  return Math.floor(lines / 10) + 1;
}

/**
 * Gravity interval (ms per cell of automatic fall) for a level.
 * Mirrors the original gravityMs(): a classic exponential speed curve.
 */
export function gravityMs(level: number): number {
  return Math.pow(0.8 - (level - 1) * 0.007, level - 1) * 1000;
}
