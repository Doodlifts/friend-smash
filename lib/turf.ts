/* ============================================================
   lib/turf.ts — TURF WAR referee: turn-based, no-gravity, shared-board
   duel on a 7×12 arena. Pure Connect-4 energy:

   - Players alternate placing pieces from a SHARED visible queue: TRUE
     zero gravity — a piece may be placed ANYWHERE its four cells are
     in-bounds and empty (floating is fine; tester call after playing v1's
     drop-to-stack version). A 10s shot clock keeps turns honest.
   - WIN a game by completing a row owned ENTIRELY by you (all 7 cells).
   - LOSE a game by being SQUEEZED: it's your turn and your piece has no
     legal spot anywhere on the board. (Aiming at occupied cells is merely
     rejected — only having no option at all loses.)
   - Nothing ever clears except the winning row — mixed full rows are dead
     turf eating space (the squeeze is the endgame clock).
   - AFK: an expired shot clock auto-places your piece (lowest open spot);
     two consecutive timeouts forfeit the game.
   - Best of 3 games; the starter alternates each game.

   The SERVER is the whole referee: every move is validated and applied under
   the match row lock — there is no replay step because there is nothing the
   client computes that the server trusts. p1 is always PINK, p2 always BLUE.
   ============================================================ */

import { randomInt } from "crypto";
import { STATES } from "./pieces";
import { SevenBag, type PieceType } from "./rng";

/** Bumped whenever placement semantics change — the client echoes it and a
 *  mismatch tells a stale tab to reload itself instead of misplaying. */
export const TURF_RULES_V = 2; // v2 = true zero gravity + squeeze
export const TURF_COLS = 7;
export const TURF_ROWS = 12;
export const TURF_TURN_MS = 10_000;
/** Network slack on top of the shot clock before the server calls a timeout. */
export const TURF_TURN_GRACE_MS = 3_000;
export const TURF_BEST_OF = 3;
export const TURF_WINS_NEEDED = 2;
/** Consecutive timeouts that forfeit the game. Three strikes — the playtest
 *  showed two is brutal when a game-over splash eats one turn of attention
 *  (the auto-place is already the per-miss penalty). */
export const TURF_MAX_TIMEOUTS = 3;
/** Breather before a new game's first shot clock starts ticking — the
 *  previous game's verdict splash needs time to be READ (playtest: game 2
 *  started silently under the splash and forfeited by confusion). */
export const TURF_INTERGAME_MS = 10_000;
/** Pregenerated piece budget per game (board holds ~21 pieces max). */
export const TURF_PIECE_BUDGET = 60;

export type Slot = "p1" | "p2";
export interface TurfPlacement {
  t: PieceType;
  r: number; // rotation 0..3
  x: number; // column offset of the rotation state's cell frame
  y: number; // resolved row offset (server-computed)
  by: Slot;
  auto?: boolean; // true = the shot clock placed it, not the player
}
export interface TurfGame {
  n: number;
  starter: Slot;
  turn: Slot;
  moveN: number; // index into pieces; echoed by the client for idempotency
  deadline: string; // ISO — current turn's shot clock (+grace server-side)
  pieces: PieceType[];
  placements: TurfPlacement[];
  timeouts: { p1: number; p2: number }; // consecutive, reset on a real move
  /** Human-made placements this game (auto-drops excluded) — a game that
   *  ends with zero real moves is a DEAD game (mutual absence), and two in
   *  a row abort the match with refunds instead of paying slot parity. */
  realMoves?: number;
  winner: Slot | null;
  reason: "row" | "squeeze" | "afk" | null;
}
export interface TurfState {
  games: TurfGame[];
}

const other = (s: Slot): Slot => (s === "p1" ? "p2" : "p1");

/** Build the ownership grid from placements. grid[row][col] = slot | null. */
export function turfGrid(placements: TurfPlacement[]): (Slot | null)[][] {
  const g: (Slot | null)[][] = Array.from({ length: TURF_ROWS }, () => Array(TURF_COLS).fill(null));
  for (const p of placements) {
    for (const [fx, fy] of STATES[p.t][p.r].cells) {
      const x = p.x + fx, y = p.y + fy;
      if (y >= 0 && y < TURF_ROWS && x >= 0 && x < TURF_COLS) g[y][x] = p.by;
    }
  }
  return g;
}

/** Legal x range for a piece/rotation (all cells inside the 7 columns). */
export function xRange(t: PieceType, r: number): { min: number; max: number } {
  const cells = STATES[t][r].cells;
  const minFx = Math.min(...cells.map((c) => c[0]));
  const maxFx = Math.max(...cells.map((c) => c[0]));
  return { min: -minFx, max: TURF_COLS - 1 - maxFx };
}

/** Zero-gravity legality: every cell in-bounds AND empty. That's the whole
 *  physics engine now — no support requirement, floating placements welcome. */
export function fitsAt(grid: (Slot | null)[][], t: PieceType, r: number, x: number, y: number): boolean {
  return STATES[t][r].cells.every(([fx, fy]) => {
    const cx = x + fx, cy = y + fy;
    return cx >= 0 && cx < TURF_COLS && cy >= 0 && cy < TURF_ROWS && !grid[cy][cx];
  });
}

/** Legal y range for a piece/rotation (all cells inside the 12 rows). */
export function yRange(t: PieceType, r: number): { min: number; max: number } {
  const cells = STATES[t][r].cells;
  const minFy = Math.min(...cells.map((c) => c[1]));
  const maxFy = Math.max(...cells.map((c) => c[1]));
  return { min: -minFy, max: TURF_ROWS - 1 - maxFy };
}

/** Any legal spot at all for this piece? False = the mover is SQUEEZED. */
export function hasAnyPlacement(grid: (Slot | null)[][], t: PieceType): boolean {
  for (let r = 0; r < 4; r++) {
    const xr = xRange(t, r), yr = yRange(t, r);
    for (let x = xr.min; x <= xr.max; x++) {
      for (let y = yr.min; y <= yr.max; y++) {
        if (fitsAt(grid, t, r, x, y)) return true;
      }
    }
  }
  return false;
}

/** A row you own outright — all 7 cells yours. The win condition. */
export function pureRowFor(grid: (Slot | null)[][], by: Slot): number | null {
  for (let y = 0; y < TURF_ROWS; y++) {
    if (grid[y].every((c) => c === by)) return y;
  }
  return null;
}

/**
 * AFK auto-place: the lowest legal spot (deepest row first, then leftmost,
 * spawn rotation preferred) — tucked out of the way, minimally strategic.
 * Null ONLY when nothing fits anywhere (the mover is squeezed).
 */
export function autoPlacement(
  grid: (Slot | null)[][],
  t: PieceType,
): { r: number; x: number; y: number } | null {
  let best: { r: number; x: number; y: number; depth: number } | null = null;
  for (let r = 0; r < 4; r++) {
    const xr = xRange(t, r), yr = yRange(t, r);
    for (let x = xr.min; x <= xr.max; x++) {
      for (let y = yr.max; y >= yr.min; y--) {
        if (!fitsAt(grid, t, r, x, y)) continue;
        const depth = Math.max(...STATES[t][r].cells.map(([, fy]) => y + fy));
        if (!best || depth > best.depth) best = { r, x, y, depth };
        break; // deepest y for this column found
      }
    }
  }
  return best ? { r: best.r, x: best.x, y: best.y } : null;
}

/** Fresh game: crypto-seeded shared bag, alternating starter. */
export function newTurfGame(n: number): TurfGame {
  const bag = new SevenBag(randomInt(0, 0x100000000));
  const pieces: PieceType[] = [];
  while (pieces.length < TURF_PIECE_BUDGET) pieces.push(bag.next());
  const starter: Slot = n % 2 === 1 ? "p1" : "p2";
  return {
    n,
    starter,
    turn: starter,
    moveN: 0,
    deadline: new Date(Date.now() + TURF_TURN_MS + 5_000).toISOString(), // +5s first-turn settle
    pieces,
    placements: [],
    timeouts: { p1: 0, p2: 0 },
    winner: null,
    reason: null,
  };
}

export type TurfMoveOutcome =
  | { kind: "illegal"; error: string }
  | { kind: "placed"; game: TurfGame }
  | { kind: "game-over"; game: TurfGame; winner: Slot; reason: "row" | "squeeze" };

/**
 * Pure move application (no DB): validate + apply one placement to a game.
 * The DB wrapper in lib/match.ts owns locking/persistence/settlement.
 */
export function applyTurfMove(
  game: TurfGame,
  by: Slot,
  move: { moveN: number; t: PieceType; r: number; x: number; y: number },
): TurfMoveOutcome {
  if (game.winner) return { kind: "illegal", error: "game already decided" };
  if (game.turn !== by) return { kind: "illegal", error: "not your turn" };
  if (move.moveN !== game.moveN) return { kind: "illegal", error: "stale move" };
  if (move.t !== game.pieces[game.moveN]) return { kind: "illegal", error: "wrong piece" };
  if (!Number.isInteger(move.r) || move.r < 0 || move.r > 3) return { kind: "illegal", error: "bad rotation" };
  if (!Number.isInteger(move.x) || !Number.isInteger(move.y)) return { kind: "illegal", error: "bad spot" };

  const grid = turfGrid(game.placements);
  // Zero gravity: an occupied/out-of-bounds aim is a MISCLICK, not a loss —
  // the client re-aims. Only having no legal spot at all ends a game (the
  // squeeze check below, after the turn passes).
  if (!fitsAt(grid, move.t, move.r, move.x, move.y)) {
    return { kind: "illegal", error: "spot is blocked" };
  }

  game.placements.push({ t: move.t, r: move.r, x: move.x, y: move.y, by });
  game.timeouts[by] = 0;
  game.realMoves = (game.realMoves || 0) + 1;
  const after = turfGrid(game.placements);
  if (pureRowFor(after, by) !== null) {
    game.winner = by;
    game.reason = "row";
    return { kind: "game-over", game, winner: by, reason: "row" };
  }
  game.moveN++;
  game.turn = other(by);
  game.deadline = new Date(Date.now() + TURF_TURN_MS).toISOString();
  // SQUEEZE: the incoming player's piece has nowhere to go — they lose.
  if (!hasAnyPlacement(after, game.pieces[game.moveN])) {
    game.winner = by;
    game.reason = "squeeze";
    return { kind: "game-over", game, winner: by, reason: "squeeze" };
  }
  return { kind: "placed", game };
}

export type TurfTickOutcome =
  | { kind: "waiting" }
  | { kind: "auto-placed"; game: TurfGame }
  | { kind: "game-over"; game: TurfGame; winner: Slot; reason: "row" | "squeeze" | "afk" };

/**
 * Liveness (called from state polls under the match lock): if the current
 * turn's clock (+grace) expired, auto-drop for the absent player; two
 * consecutive timeouts — or a forced top-out — ends the game against them.
 */
export function tickTurfGame(game: TurfGame, now: number): TurfTickOutcome {
  if (game.winner) return { kind: "waiting" };
  if (now < Date.parse(game.deadline) + TURF_TURN_GRACE_MS) return { kind: "waiting" };
  const slacker = game.turn;
  game.timeouts[slacker]++;
  if (game.timeouts[slacker] >= TURF_MAX_TIMEOUTS) {
    game.winner = other(slacker);
    game.reason = "afk";
    return { kind: "game-over", game, winner: game.winner, reason: "afk" };
  }
  const grid = turfGrid(game.placements);
  const t = game.pieces[game.moveN];
  const auto = autoPlacement(grid, t);
  if (!auto) {
    // Shouldn't be reachable (the squeeze check fires when the turn is
    // handed over) — belt-and-braces for doctored/legacy states.
    game.winner = other(slacker);
    game.reason = "squeeze";
    return { kind: "game-over", game, winner: game.winner, reason: "squeeze" };
  }
  game.placements.push({ t, r: auto.r, x: auto.x, y: auto.y, by: slacker, auto: true });
  const after = turfGrid(game.placements);
  if (pureRowFor(after, slacker) !== null) {
    // An accidental AFK win is still a win — rare, but the rules are the rules.
    game.winner = slacker;
    game.reason = "row";
    return { kind: "game-over", game, winner: slacker, reason: "row" };
  }
  game.moveN++;
  game.turn = other(slacker);
  game.deadline = new Date(Date.now() + TURF_TURN_MS).toISOString();
  // Squeeze check for the player now on turn (mirrors applyTurfMove).
  if (!hasAnyPlacement(after, game.pieces[game.moveN])) {
    game.winner = slacker;
    game.reason = "squeeze";
    return { kind: "game-over", game, winner: slacker, reason: "squeeze" };
  }
  return { kind: "auto-placed", game };
}
