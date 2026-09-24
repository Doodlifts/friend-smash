/* ============================================================
   lib/replay.ts — deterministic server-side replay (anti-cheat, Phase 3).

   THE real protection: given the server's seed + the client's input log, the
   server reconstructs the game headlessly and decides the score. It does NOT
   trust the client's claimed score or per-lock outcomes.

   For each piece-lock the replay:
     1. checks the piece TYPE matches the seeded 7-bag sequence (with hold),
     2. checks the placement is in-bounds, collision-free, GROUNDED (resting),
        and REACHABLE from spawn (BFS over legal moves/rotations/soft-drops),
     3. applies it, clears full rows, and re-scores via lib/scoring.

   Soft/hard-drop points are linear (1–2 pts/cell) and low-value to forge; they
   are taken from the summary but BOUNDED by what the placements allow, and the
   run is rejected if they exceed that bound.

   Pure module — no DOM, no DB, no randomness beyond the seeded bag.
   ============================================================ */

import { SevenBag, type PieceType } from "./rng";
import { scoreClear, levelForLines, softDropPoints, hardDropPoints, smashClearPoints } from "./scoring";
import type { InputEvent, RunSummary } from "./anticheat";
import {
  COLS,
  HIDDEN,
  TOTAL,
  STATES,
  KICKS_I,
  KICKS_JLSTZ,
  GRIDS,
  spawnX,
  emptyBoard,
  collides,
  bombBlast,
  type Board,
} from "./pieces";

export interface ReplayResult {
  ok: boolean;
  score: number;
  lines: number;
  level: number;
  /** Number of pieces locked during the replay. */
  pieces: number;
  reason?: string;
}

interface LockEvent {
  pt: PieceType;
  r: number;
  x: number;
  y: number;
  cleared: number;
}

/** All grounded, reachable resting states for piece `t` on `board`. */
function reachableLocks(board: Board, t: PieceType): Set<string> {
  const reachable = new Set<string>(); // "x,y,r" states visited
  const grounded = new Set<string>(); // "r,x,y" valid lock positions

  let sx = spawnX(t);
  let sy = 0;
  if (collides(board, t, 0, sx, 0)) sy = -1;
  if (collides(board, t, 0, sx, sy)) return grounded; // spawn blocked -> none

  const startKey = `${sx},${sy},0`;
  const queue: Array<[number, number, number]> = [[sx, sy, 0]];
  reachable.add(startKey);

  const tryRotate = (x: number, y: number, r: number, dir: number): [number, number, number] | null => {
    const nr = (r + dir + 4) % 4;
    const table = t === "I" ? KICKS_I : KICKS_JLSTZ;
    for (const [kx, ky] of table[`${r}>${nr}`]) {
      if (!collides(board, t, nr, x + kx, y - ky)) return [x + kx, y - ky, nr];
    }
    return null;
  };

  while (queue.length) {
    const [x, y, r] = queue.shift() as [number, number, number];

    // grounded? (can't fall one more)
    if (collides(board, t, r, x, y + 1)) grounded.add(`${r},${x},${y}`);

    const neighbors: Array<[number, number, number]> = [];
    if (!collides(board, t, r, x - 1, y)) neighbors.push([x - 1, y, r]);
    if (!collides(board, t, r, x + 1, y)) neighbors.push([x + 1, y, r]);
    if (!collides(board, t, r, x, y + 1)) neighbors.push([x, y + 1, r]); // soft drop
    const cw = tryRotate(x, y, r, 1);
    if (cw) neighbors.push(cw);
    const ccw = tryRotate(x, y, r, -1);
    if (ccw) neighbors.push(ccw);

    for (const [nx, ny, nr] of neighbors) {
      const k = `${nx},${ny},${nr}`;
      if (!reachable.has(k)) {
        reachable.add(k);
        queue.push([nx, ny, nr]);
      }
    }
  }
  return grounded;
}

function place(board: Board, t: PieceType, r: number, x: number, y: number): boolean {
  for (const [fx, fy] of STATES[t][r].cells) {
    const cy = y + fy;
    const cx = x + fx;
    if (cy < 0) return false; // locked above the top -> game over (not a scoring lock)
    board[cy][cx] = true;
  }
  return true;
}

function clearFullRows(board: Board): number {
  const keep: Board = [];
  let cleared = 0;
  for (let yy = 0; yy < TOTAL; yy++) {
    if (board[yy].every((c) => c)) cleared++;
    else keep.push(board[yy]);
  }
  while (keep.length < TOTAL) keep.unshift(Array(COLS).fill(null));
  for (let yy = 0; yy < TOTAL; yy++) board[yy] = keep[yy];
  return cleared;
}

function fail(reason: string, score = 0, lines = 0, pieces = 0): ReplayResult {
  return { ok: false, score, lines, level: levelForLines(lines), pieces, reason };
}

/**
 * Replay a run from its seed + input log and compute the authoritative score.
 * Returns ok:false with a reason on any divergence (illegal sequence/placement
 * or out-of-bound drop counts).
 *
 * `scoring` is the run's scoring SNAPSHOT (runs.config.scoring); a missing
 * snapshot means the run was played under v1.
 */
export function replayRun(
  seed: number,
  log: InputEvent[],
  summary: RunSummary,
  scoring?: { v: number } | null,
): ReplayResult {
  if (!Array.isArray(log)) return fail("missing input log");

  const bag = new SevenBag(seed >>> 0);
  const board = emptyBoard();

  let current: PieceType = bag.next();
  let hold: PieceType | null = null;
  let holdUsed = false;
  let bombArmed = false;
  // SMASH-clear bonus (scoring v2+): the LOG says whether the piece about to
  // lock was hard-dropped — the server decides, the client never reports it.
  const smashV = Math.max(1, Math.floor(scoring?.v ?? 1));
  const smashOn = smashV >= 2;
  let smashArmed = false;
  let hdCells = 0; // cross-check against summary.hardDropCells

  let score = 0;
  let lines = 0;
  let level = 1;
  let combo = -1;
  let b2b = false;
  let pieces = 0;

  for (const ev of log) {
    if (ev.a === "hold") {
      if (holdUsed) continue; // engine ignores a second hold per piece
      if (hold === null) {
        hold = current;
        current = bag.next();
      } else {
        const tmp = current;
        current = hold;
        hold = tmp;
      }
      holdUsed = true;
      continue;
    }
    if (ev.a === "powerup") {
      // Apply the board-/sequence-affecting power-ups (entitlement is enforced
      // by finishRun); the replay-safe ones (slow_fall/next_peek/clean_slate)
      // have no effect here.
      if (ev.key === "bomb") {
        bombArmed = true;
      } else if (ev.key === "reroll") {
        current = bag.next(); // swap the current piece for the next (matches spawn())
        holdUsed = false;
      }
      continue;
    }
    if (ev.a === "hd") {
      // A hard drop commits the CURRENT piece; the very next lock is a SMASH.
      smashArmed = true;
      const cells = (ev as unknown as { cells?: unknown }).cells;
      if (typeof cells === "number" && Number.isFinite(cells) && cells >= 0) hdCells += Math.trunc(cells);
      continue;
    }
    if (ev.a !== "lock") continue; // moves/rotations/drops are validated via reachability

    const lock = ev as unknown as LockEvent;
    if (lock.pt !== current) {
      return fail(`piece sequence mismatch at lock ${pieces} (got ${lock.pt}, expected ${current})`, score, lines, pieces);
    }
    if (!Number.isInteger(lock.r) || lock.r < 0 || lock.r > 3) return fail("bad rotation", score, lines, pieces);

    // Placement must be reachable + grounded.
    const grounded = reachableLocks(board, current);
    if (!grounded.has(`${lock.r},${lock.x},${lock.y}`)) {
      return fail(`unreachable/ungrounded placement at lock ${pieces} (${current} r${lock.r} @${lock.x},${lock.y})`, score, lines, pieces);
    }

    if (!place(board, current, lock.r, lock.x, lock.y)) {
      return fail("placement above the board", score, lines, pieces);
    }

    // bomb: detonate a 3×3 blast around the placement (same geometry + order as
    // the engine — BEFORE the full-row scan).
    if (bombArmed) {
      for (const [bx, by] of bombBlast(current, lock.r, lock.x, lock.y)) board[by][bx] = null;
      bombArmed = false;
    }

    const n = clearFullRows(board);
    const wasSmash = smashArmed;
    smashArmed = false; // consumed by this lock either way
    if (n > 0) {
      const res = scoreClear(n, { level, b2b, combo });
      score += res.points;
      b2b = res.b2b;
      combo = res.combo;
      lines += n;
      level = levelForLines(lines);
      // SMASH bonus: awarded at the level AFTER the clear, matching the engine.
      if (smashOn && wasSmash) score += smashClearPoints(level);
    } else {
      combo = -1;
    }

    current = bag.next();
    holdUsed = false;
    pieces++;
  }

  // Soft/hard drop points: bounded by what the placements allow, then added.
  const maxPerPiece = TOTAL; // a piece can travel at most ~board height
  const maxDropCells = Math.max(1, pieces) * maxPerPiece;
  const soft = summary?.softDropCells ?? 0;
  const hard = summary?.hardDropCells ?? 0;
  if (!Number.isFinite(soft) || soft < 0 || soft > maxDropCells) {
    return fail("soft-drop count out of bounds", score, lines, pieces);
  }
  if (!Number.isFinite(hard) || hard < 0 || hard > maxDropCells) {
    return fail("hard-drop count out of bounds", score, lines, pieces);
  }
  // The log's own hard-drop events must agree with the submitted total. Two
  // independent claims about the same thing that disagree = a desynced or
  // doctored client. (Only enforced for logs that record cell counts.)
  if (hdCells > 0 && hdCells !== Math.trunc(hard)) {
    return fail(`hard-drop mismatch (log ${hdCells}, summary ${Math.trunc(hard)})`, score, lines, pieces);
  }
  score += softDropPoints(soft) + hardDropPoints(hard);

  return { ok: true, score, lines, level, pieces };
}

// Keep the HIDDEN/GRIDS imports meaningful for future tightening (e.g. top-out
// detection / footprint checks); referenced to avoid unused-import lint noise.
void HIDDEN;
void GRIDS;
