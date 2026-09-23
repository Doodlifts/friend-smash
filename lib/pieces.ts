/* ============================================================
   lib/pieces.ts — canonical piece geometry (SRS), headless.

   SHARED source of truth for the tetromino shapes, rotation states, and SRS
   wall-kick tables. The server replay (lib/replay.ts) uses these to reconstruct
   a run. The values are byte-identical to the client engine
   (components/engine.ts); the replay-vs-client golden test guarantees they stay
   in agreement, so a divergence would surface immediately.

   Pure module — no DOM, no globals.
   ============================================================ */

import type { PieceType } from "./rng";

export const CELL = 96;
export const COLS = 10;
export const ROWS = 20;
export const HIDDEN = 2;
export const TOTAL = ROWS + HIDDEN;

export const SHAPES: Record<PieceType, { n: number; c: number[][] }> = {
  I: { n: 4, c: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  J: { n: 3, c: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { n: 3, c: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  O: { n: 2, c: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  S: { n: 3, c: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  T: { n: 3, c: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  Z: { n: 3, c: [[0, 0], [1, 0], [1, 1], [2, 1]] },
};

export const TYPES = Object.keys(SHAPES) as PieceType[];

export interface RotState {
  cells: number[][];
  bx: number;
  by: number;
  w: number;
  h: number;
}

/** Precompute 4 rotation states per piece (matches the engine's STATES loop). */
function buildStates(): Record<PieceType, RotState[]> {
  const out = {} as Record<PieceType, RotState[]>;
  for (const t of TYPES) {
    const n = SHAPES[t].n;
    let cells = SHAPES[t].c.map((c) => c.slice());
    out[t] = [];
    for (let r = 0; r < 4; r++) {
      const xs = cells.map((c) => c[0]);
      const ys = cells.map((c) => c[1]);
      const bx = Math.min(...xs);
      const by = Math.min(...ys);
      out[t].push({
        cells: cells.map((c) => c.slice()),
        bx,
        by,
        w: Math.max(...xs) - bx + 1,
        h: Math.max(...ys) - by + 1,
      });
      cells = cells.map(([x, y]) => [n - 1 - y, x]); // 90° CW in n-frame
    }
  }
  return out;
}

export const STATES = buildStates();

export const KICKS_JLSTZ: Record<string, number[][]> = {
  "0>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "1>0": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "1>2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "2>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "2>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "3>2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "3>0": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "0>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

export const KICKS_I: Record<string, number[][]> = {
  "0>1": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "1>0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "1>2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  "2>1": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "2>3": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "3>2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "3>0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "0>3": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

export const GRIDS: Record<PieceType, [number, number]> = {
  I: [4, 1],
  J: [3, 2],
  L: [3, 2],
  O: [2, 2],
  S: [3, 2],
  T: [3, 2],
  Z: [3, 2],
};

/** Spawn x for a piece (matches the engine's spawn()). */
export function spawnX(t: PieceType): number {
  return t === "O" ? 4 : 3;
}

export type Board = (boolean | null)[][];

export function emptyBoard(): Board {
  return Array.from({ length: TOTAL }, () => Array(COLS).fill(null));
}

/**
 * The cells a "bomb" power-up clears: a 3×3 box centered on the just-locked
 * piece's centroid (rounded). SHARED by the client engine and the server replay
 * so the blast is identical on both sides. Returns in-bounds [x,y] cells.
 */
export function bombBlast(t: PieceType, r: number, px: number, py: number): [number, number][] {
  const cells = STATES[t][r].cells;
  let sx = 0;
  let sy = 0;
  for (const [fx, fy] of cells) {
    sx += px + fx;
    sy += py + fy;
  }
  const cx = Math.round(sx / cells.length);
  const cy = Math.round(sy / cells.length);
  const out: [number, number][] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < COLS && y >= 0 && y < TOTAL) out.push([x, y]);
    }
  }
  return out;
}

/** Collision test for piece t at rotation r, origin (px,py) against a board. */
export function collides(board: Board, t: PieceType, r: number, px: number, py: number): boolean {
  for (const [fx, fy] of STATES[t][r].cells) {
    const x = px + fx;
    const y = py + fy;
    if (x < 0 || x >= COLS || y >= TOTAL) return true;
    if (y >= 0 && board[y][x]) return true;
  }
  return false;
}
