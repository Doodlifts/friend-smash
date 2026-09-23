/* ============================================================
   lib/bonus.ts — the guts-meter bonus rounds (arrows / swords).

   SHARED, PURE module (like rng/scoring/pieces): the client engine uses it to
   run the bonus and the SERVER REPLAY uses it to reproduce the exact same
   deletions — so bonus outcomes are deterministic and cheat-proof.

   Determinism contract:
   • The guts meter fills from CLEARED LINES (deterministic). When
     `meterLines >= fillLines`, the bonus triggers right after that clear
     resolves — same point in the event order on both sides.
   • Each bonus draws from its OWN mulberry32 stream, seeded from
     (runSeed, bonusIndex) — it never consumes the piece-bag stream, so the
     piece sequence is unaffected.
   • Which round plays (arrows vs swords), every arrow target, and every sword
     slash are all drawn from that stream over a CANONICALLY ORDERED cell scan
     (row-major), so client and server compute identical cell sets.
   • Tuning values live in a per-run CONFIG SNAPSHOT (runs.config) — replay uses
     the exact numbers the run was played with. Runs with no snapshot (older
     runs) replay with the bonus disabled.
   • The ALGORITHM itself is versioned (BonusTuning.v / BONUS_ALGO_V): the
     snapshot records which geometry the run was played under, so geometry
     changes never break the replay of in-flight or historical runs.

   The videos / slosh / gyro are pure presentation and never touch this module.
   ============================================================ */

import { mulberry32 } from "./rng";
import type { PieceType } from "./rng";

/** Current bonus ALGORITHM version. Bumped when the deterministic geometry
 *  changes, so old run snapshots keep replaying with the exact semantics they
 *  were played under (same pattern as the fillLines/fillGuts legacy split).
 *    v1: uniform slash intercepts (a sword round could whiff to +0);
 *        deletions leave survivors floating.
 *    v2: every slash is ANCHORED through an occupied cell (never a full
 *        whiff) and survivors FALL (column gravity) after the deletions.
 *    v3: FOUR round kinds drawn uniformly (arrows / swords / rats / banana) —
 *        RAT ATTACK gnaws anchored row-runs, BANANA BANGER snipes random
 *        blocks. Gravity + anchoring carry over from v2. */
export const BONUS_ALGO_V = 3;

/** Max contiguous cells one rat gnaws in a RAT ATTACK run. */
export const RAT_BITE = 3;

/* ---- tuning (defaults; admin-tunable via game_config, snapshot per run) ---- */
export interface BonusTuning {
  /** Master switch — replay treats missing config as disabled. */
  enabled: boolean;
  /** Bonus algorithm version (see BONUS_ALGO_V). Absent on run snapshots
   *  taken before v2 shipped — those replay as v1. */
  v?: number;
  /**
   * GUTS points needed to fill the meter (guts-weighted mode). Multi-line
   * clears fill faster: single=2, double=5, triple=9, tetris=14 (see
   * GUTS_PER_CLEAR). Absent on LEGACY snapshots — see fillLines.
   */
  fillGuts?: number;
  /**
   * LEGACY meter mode: cleared LINES needed (each line = 1). Only present on
   * run snapshots taken before guts weighting shipped; replay honors it so
   * in-flight runs keep verifying. New configs use fillGuts.
   */
  fillLines?: number;
  /** Arrows fired in an arrow round. */
  arrowCount: number;
  /** Slashes in a sword round. */
  swordSlashes: number;
  /** Rats unleashed in a RAT ATTACK round (v3+). */
  ratCount: number;
  /** Shots fired in a BANANA BANGER round (v3+). */
  bananaShots: number;
  /** Points per destroyed block, multiplied by the current level. */
  pointsPerBlock: number;
}

/** Guts earned per clear size (index = lines cleared by one lock).
 *  Super-linear so doubles/triples/tetrises race the meter. */
export const GUTS_PER_CLEAR = [0, 2, 5, 9, 14] as const;

export function gutsForClear(lines: number): number {
  return GUTS_PER_CLEAR[Math.max(0, Math.min(4, lines | 0))];
}

/** Resolve a tuning snapshot into its meter mode + target. */
export function meterTarget(t: BonusTuning): { mode: "guts" | "lines"; target: number } {
  if (typeof t.fillGuts === "number") return { mode: "guts", target: t.fillGuts };
  return { mode: "lines", target: typeof t.fillLines === "number" ? t.fillLines : 18 };
}

export const DEFAULT_BONUS: BonusTuning = {
  enabled: false,
  v: BONUS_ALGO_V,
  fillGuts: 20, // ≈ 10 singles, 4 doubles, or ~1.5 tetrises
  arrowCount: 12,
  swordSlashes: 3,
  ratCount: 6,
  bananaShots: 10,
  pointsPerBlock: 10,
};

/** Clamp arbitrary (admin-supplied / snapshot) tuning into sane, replay-safe
 *  bounds. Preserves the LEGACY lines mode when a snapshot has fillLines but
 *  no fillGuts — old runs must keep replaying with their original semantics.
 *
 *  `snapshot: true` = sanitizing a per-run snapshot for REPLAY: a missing `v`
 *  means the run predates versioning and must replay as v1. Without the flag
 *  (live config / client) a missing `v` upgrades to the current algorithm. */
export function sanitizeBonus(
  t: Partial<BonusTuning> | null | undefined,
  opts?: { snapshot?: boolean },
): BonusTuning {
  const d = DEFAULT_BONUS;
  const vDefault = opts?.snapshot ? 1 : BONUS_ALGO_V;
  const num = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : dflt;
  if (!t || typeof t !== "object") return { ...d, v: vDefault };
  const base = {
    enabled: typeof t.enabled === "boolean" ? t.enabled : d.enabled,
    v: num(t.v, 1, BONUS_ALGO_V, vDefault),
    arrowCount: num(t.arrowCount, 1, 40, d.arrowCount),
    swordSlashes: num(t.swordSlashes, 1, 8, d.swordSlashes),
    ratCount: num(t.ratCount, 1, 12, d.ratCount),
    bananaShots: num(t.bananaShots, 1, 30, d.bananaShots),
    pointsPerBlock: num(t.pointsPerBlock, 0, 100, d.pointsPerBlock),
  };
  if (typeof t.fillGuts !== "number" && typeof t.fillLines === "number") {
    // legacy snapshot: lines mode
    return { ...base, fillLines: num(t.fillLines, 4, 100, 18) };
  }
  return { ...base, fillGuts: num(t.fillGuts, 6, 200, d.fillGuts as number) };
}

/* ---- deterministic core ---------------------------------------------------- */

export type BonusKind = "arrows" | "swords" | "rats" | "banana";

/** v3 kind order — the uniform draw indexes into this list. NEVER reorder:
 *  it would change which round historical seeds produce. */
const KINDS_V3: readonly BonusKind[] = ["arrows", "swords", "rats", "banana"];

/** Minimal board view: anything truthy = occupied cell. Matches both the
 *  replay's boolean board and the engine's cell-object grid. */
export type AnyBoard = ReadonlyArray<ReadonlyArray<unknown>>;

/** The dedicated RNG stream for bonus #idx of a run. Never touches the bag. */
export function bonusRng(seed: number, idx: number): () => number {
  // Golden-ratio spaced sub-seeds; ^0xB05EED keeps it disjoint from the bag seed.
  return mulberry32(((seed >>> 0) ^ 0xb05eed) + Math.imul(idx + 1, 0x9e3779b9));
}

/** Which round plays — one rng draw in every version (replay parity).
 *  v1/v2: coin flip between arrows/swords. v3+: uniform over all four, so
 *  the player never knows which round is coming. */
export function pickBonusKind(rng: () => number, v = 2): BonusKind {
  const roll = rng();
  if (v >= 3) return KINDS_V3[Math.min(3, Math.floor(roll * 4))];
  return roll < 0.5 ? "arrows" : "swords";
}

/** Canonical row-major scan of occupied cells — the shared ordering both sides
 *  index into. */
export function occupiedCells(board: AnyBoard): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < board.length; y++) {
    const row = board[y];
    for (let x = 0; x < row.length; x++) if (row[x]) out.push([x, y]);
  }
  return out;
}

/** Arrow round: `count` arrows each strike a random occupied cell (repeats
 *  allowed — deletion dedupes). Returns the ORDERED strike list (for the
 *  animation) — delete the unique set after all land. */
export function arrowStrikes(
  board: AnyBoard,
  rng: () => number,
  count: number,
): Array<[number, number]> {
  const occ = occupiedCells(board);
  if (!occ.length) return [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) out.push(occ[Math.floor(rng() * occ.length)]);
  return out;
}

/** A slash's geometry: intercept row at x=0 + slope numerator (over 2). Kept
 *  in the resolution so the blade can be DRAWN even when it cuts few cells. */
export interface SlashLine {
  y0: number;
  sl: number;
}

const SLOPES = [-2, -1, 1, 2] as const;

/** The occupied cells inside one slash's 2-cell-tall diagonal band. */
function slashBand(
  board: AnyBoard,
  y0: number,
  sl: number,
  cols: number,
  totalRows: number,
): Array<[number, number]> {
  const cut: Array<[number, number]> = [];
  for (let x = 0; x < cols; x++) {
    const yy = y0 + Math.floor((x * sl) / 2);
    for (let dy = 0; dy < 2; dy++) {
      const y = yy + dy;
      if (y >= 0 && y < totalRows && board[y] && board[y][x]) cut.push([x, y]);
    }
  }
  return cut;
}

/** Sword round: each slash is a 2-cell-tall diagonal band across the full board
 *  width (integer math only). Returns the occupied cells cut, per slash, plus
 *  each slash's line for the animation.
 *
 *  v1 draws the intercept uniformly over ALL rows — on a low stack a slash
 *  (or the whole round) routinely whiffed to 0 cuts (the tester's "BONUS +0").
 *  v2 ANCHORS each slash through a random occupied cell, so every slash is
 *  guaranteed ≥1 cut on a non-empty board. Both draw exactly 2 rng values per
 *  slash, in the same order, and stay integer-only for replay parity. */
export function swordCuts(
  board: AnyBoard,
  rng: () => number,
  slashes: number,
  cols: number,
  totalRows: number,
  anchored = false,
): { groups: Array<Array<[number, number]>>; lines: SlashLine[] } {
  const occ = anchored ? occupiedCells(board) : null;
  const groups: Array<Array<[number, number]>> = [];
  const lines: SlashLine[] = [];
  for (let s = 0; s < slashes; s++) {
    let y0: number;
    let sl: number;
    if (occ && occ.length) {
      const [ax, ay] = occ[Math.floor(rng() * occ.length)];
      sl = SLOPES[Math.floor(rng() * 4)];
      y0 = ay - Math.floor((ax * sl) / 2); // band passes through (ax, ay)
    } else {
      y0 = Math.floor(rng() * totalRows); // intercept row at x=0
      sl = SLOPES[Math.floor(rng() * 4)];
    }
    lines.push({ y0, sl });
    groups.push(slashBand(board, y0, sl, cols, totalRows));
  }
  return { groups, lines };
}

/** One rat's gnaw in a RAT ATTACK round: enters on a row anchored at an
 *  occupied cell and chews up to RAT_BITE CONTIGUOUS occupied cells in its
 *  direction of travel (stops at the first gap or the wall). Anchored like v2
 *  swords, so a rat never whiffs on a non-empty board. Two rng draws per rat
 *  (anchor, direction) — the same count on an empty board (row, direction). */
export interface RatRun {
  /** Row the rat scurries along. */
  y: number;
  /** Travel direction: 1 = left→right, -1 = right→left. */
  dir: 1 | -1;
  /** Cells gnawed, in bite order starting at the anchor. */
  cells: Array<[number, number]>;
}

export function ratRuns(
  board: AnyBoard,
  rng: () => number,
  count: number,
  totalRows: number,
): RatRun[] {
  const occ = occupiedCells(board);
  const out: RatRun[] = [];
  for (let r = 0; r < count; r++) {
    if (!occ.length) {
      const y = Math.floor(rng() * totalRows);
      const dir: 1 | -1 = rng() < 0.5 ? 1 : -1;
      out.push({ y, dir, cells: [] });
      continue;
    }
    const [ax, ay] = occ[Math.floor(rng() * occ.length)];
    const dir: 1 | -1 = rng() < 0.5 ? 1 : -1;
    const cells: Array<[number, number]> = [];
    const row = board[ay];
    for (let i = 0, x = ax; i < RAT_BITE && x >= 0 && x < row.length && row[x]; i++, x += dir) {
      cells.push([x, ay]);
    }
    out.push({ y: ay, dir, cells });
  }
  return out;
}

/** v2 aftermath: survivors fall straight down their columns (in place). Works
 *  on both boards — the engine's {id,rsx,rsy} cell objects move intact (the
 *  slice renderer keeps drawing them correctly) and the replay's booleans just
 *  shift. Deterministic and integer-only; a full row formed by the compaction
 *  clears on the next lock (both sides scan all rows). */
export function applyBonusGravity(
  board: Array<Array<unknown>>,
  cols: number,
  totalRows: number,
): void {
  for (let x = 0; x < cols; x++) {
    let write = totalRows - 1;
    for (let y = totalRows - 1; y >= 0; y--) {
      const c = board[y][x];
      if (c) {
        if (write !== y) {
          board[write][x] = c;
          board[y][x] = null;
        }
        write--;
      }
    }
  }
}

/** Unique cells from strike/cut lists (the actual deletion set). */
export function uniqueCells(cells: Array<[number, number]>): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const [x, y] of cells) {
    const k = `${x},${y}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push([x, y]);
    }
  }
  return out;
}

/** Compute one full bonus resolution: kind + the unique deletion set + points.
 *  This is THE function both the engine and the replay call. */
export interface BonusResolution {
  kind: BonusKind;
  /** Ordered strikes/cuts for animation (may repeat cells). */
  hits: Array<[number, number]>;
  /** Per-slash grouping (swords only) for the slash animation. */
  slashGroups?: Array<Array<[number, number]>>;
  /** Per-slash geometry (swords only) — lets the blade draw its full sweep
   *  independent of how many cells it cut. Presentation only. */
  slashLines?: SlashLine[];
  /** Per-rat runs (rats only) — row, direction, and bite cells, for the
   *  scurry animation. Presentation only; deletions come from `deleted`. */
  ratRuns?: RatRun[];
  /** Unique cells to delete once the animation completes. */
  deleted: Array<[number, number]>;
  /** Score awarded: deleted.length * pointsPerBlock * level. */
  points: number;
  /** v2+: apply applyBonusGravity() to the board AFTER the deletions. Both
   *  the engine and the replay key off this same flag. */
  gravity: boolean;
}

export function resolveBonus(
  board: AnyBoard,
  seed: number,
  idx: number,
  level: number,
  tuning: BonusTuning,
  cols: number,
  totalRows: number,
): BonusResolution {
  const v = typeof tuning.v === "number" && tuning.v >= 2 ? tuning.v : 1;
  const gravity = v >= 2;
  const rng = bonusRng(seed, idx);
  const kind = pickBonusKind(rng, v);
  const score = (deleted: Array<[number, number]>) =>
    deleted.length * tuning.pointsPerBlock * Math.max(1, level);
  if (kind === "arrows" || kind === "banana") {
    // banana banger snipes random occupied blocks — same selection as arrows,
    // different gun. Presentation is the engine's problem.
    const n = kind === "arrows" ? tuning.arrowCount : tuning.bananaShots;
    const hits = arrowStrikes(board, rng, n);
    const deleted = uniqueCells(hits);
    return { kind, hits, deleted, points: score(deleted), gravity };
  }
  if (kind === "rats") {
    const runs = ratRuns(board, rng, tuning.ratCount, totalRows);
    const hits = runs.flatMap((r) => r.cells);
    const deleted = uniqueCells(hits);
    return { kind, hits, ratRuns: runs, deleted, points: score(deleted), gravity };
  }
  const { groups, lines } = swordCuts(board, rng, tuning.swordSlashes, cols, totalRows, v >= 2);
  const hits = groups.flat();
  const deleted = uniqueCells(hits);
  return {
    kind,
    hits,
    slashGroups: groups,
    slashLines: lines,
    deleted,
    points: score(deleted),
    gravity,
  };
}

// PieceType intentionally re-exported context: bonus never alters the sequence.
export type { PieceType };
