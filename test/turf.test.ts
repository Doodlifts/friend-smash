/* test/turf.test.ts — TURF WAR referee rules, pure and exhaustive.
   DB integration (queue/escrow/settle threading) joins verify-db.mjs when
   the mode is wired into lib/match.ts. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TURF_COLS,
  TURF_ROWS,
  TURF_MAX_TIMEOUTS,
  TURF_TURN_MS,
  TURF_TURN_GRACE_MS,
  turfGrid,
  xRange,
  yRange,
  fitsAt,
  hasAnyPlacement,
  pureRowFor,
  autoPlacement,
  newTurfGame,
  applyTurfMove,
  tickTurfGame,
  type TurfPlacement,
} from "../lib/turf";
import { STATES } from "../lib/pieces";
import type { PieceType } from "../lib/rng";

const place = (t: PieceType, r: number, x: number, y: number, by: "p1" | "p2"): TurfPlacement => ({ t, r, x, y, by });

test("turf: zero gravity — floating mid-air placements are legal", () => {
  const g = turfGrid([]);
  assert.equal(fitsAt(g, "I", 0, 0, 4), true, "floating flat I mid-board");
  assert.equal(fitsAt(g, "O", 0, 2, 0), true, "top corner");
  assert.equal(fitsAt(g, "O", 0, 2, TURF_ROWS - 2), true, "bottom");
  assert.equal(fitsAt(g, "I", 0, 0, TURF_ROWS - 1), false, "cells below the floor");
  assert.equal(fitsAt(g, "I", 0, 4, 4), false, "cells past the right wall");
});

test("turf: occupied cells block a placement (but nothing requires support)", () => {
  const g = turfGrid([place("O", 0, 2, 4, "p2")]);
  assert.equal(fitsAt(g, "O", 0, 2, 4), false, "overlap rejected");
  assert.equal(fitsAt(g, "O", 0, 2, 8), true, "floating below it: fine");
  assert.equal(fitsAt(g, "O", 0, 2, 1), true, "floating above it: fine");
});

test("turf: xRange keeps every rotation inside 7 columns", () => {
  for (const t of Object.keys(STATES) as PieceType[]) {
    for (let r = 0; r < 4; r++) {
      const { min, max } = xRange(t, r);
      assert.ok(min <= max, `${t}/${r} has a legal column`);
      const cells = STATES[t][r].cells;
      for (const x of [min, max]) {
        for (const [fx] of cells) {
          const cx = x + fx;
          assert.ok(cx >= 0 && cx < TURF_COLS, `${t}/${r}@${x} cell in bounds`);
        }
      }
    }
  }
});

test("turf: pure row detection — I(4) + flat J bottom bar(3) = pink win", () => {
  // Flat J: find the rotation whose bottom bar spans 3 columns in one row
  // with total width 3 (spawn J: top-left cell + bottom bar of 3).
  const g = turfGrid([
    place("I", 0, 0, TURF_ROWS - 2, "p1"), // spawn I cells sit on relative row 1 → board row 11
    place("J", 0, 4, TURF_ROWS - 2, "p1"), // J spawn: bottom row cols 4-6, top cell col 4
  ]);
  assert.equal(pureRowFor(g, "p1"), TURF_ROWS - 1);
  assert.equal(pureRowFor(g, "p2"), null);
});

test("turf: one enemy cell poisons the row", () => {
  const g = turfGrid([
    place("I", 0, 0, TURF_ROWS - 2, "p1"),
    place("J", 0, 4, TURF_ROWS - 2, "p2"), // same geometry, wrong owner
  ]);
  assert.equal(pureRowFor(g, "p1"), null);
  assert.equal(pureRowFor(g, "p2"), null, "mixed full row is nobody's");
});

test("turf: hasAnyPlacement — squeezed when only a too-small hole remains", () => {
  // Fill everything except a 2x2 hole: O fits, I does not.
  const placements: TurfPlacement[] = [];
  for (let col = 0; col < TURF_COLS; col++) {
    for (let band = 0; band < 3; band++) {
      if (col <= 1 && band === 0) continue; // leave cols 0-1 rows 0-3 open for now
      placements.push(place("I", 1, col - 2, band * 4, "p1")); // vertical I fills 4 rows
    }
  }
  // Now close rows 2-3 of cols 0-1, leaving exactly a 2x2 hole at (0,0).
  placements.push(place("O", 0, 0, 2, "p2"));
  const g = turfGrid(placements);
  assert.equal(fitsAt(g, "O", 0, 0, 0), true, "the O-shaped hole is open");
  assert.equal(hasAnyPlacement(g, "O"), true);
  assert.equal(hasAnyPlacement(g, "I"), false, "no 4-in-a-line anywhere = squeezed");
});

test("turf: applyTurfMove full flow — turns alternate, wrong turn rejected", () => {
  const game = newTurfGame(1);
  assert.equal(game.turn, "p1");
  const t0 = game.pieces[0];
  const bad = applyTurfMove(game, "p2", { moveN: 0, t: t0, r: 0, x: 0, y: 0 });
  assert.equal(bad.kind, "illegal");
  const ok = applyTurfMove(game, "p1", { moveN: 0, t: t0, r: 0, x: xRange(t0, 0).min, y: yRange(t0, 0).min });
  assert.equal(ok.kind, "placed");
  assert.equal(game.turn, "p2");
  assert.equal(game.moveN, 1);
  const stale = applyTurfMove(game, "p2", { moveN: 0, t: t0, r: 0, x: 0, y: 0 });
  assert.equal(stale.kind, "illegal", "stale moveN rejected (idempotency)");
  const wrongPiece = applyTurfMove(game, "p2", {
    moveN: 1,
    t: game.pieces[1] === "I" ? "O" : "I",
    r: 0,
    x: 0,
    y: 0,
  });
  assert.equal(wrongPiece.kind, "illegal", "must play the queue's piece");
});

test("turf: aiming at a blocked spot is a rejection, never a loss", () => {
  const game = newTurfGame(1);
  game.placements.push(place("O", 0, 2, 4, "p2"));
  const t0 = game.pieces[0];
  const res = applyTurfMove(game, "p1", { moveN: 0, t: t0, r: 0, x: 2, y: 4 });
  assert.equal(res.kind, "illegal", "misclick = try again");
  assert.equal(game.winner, null);
});

test("turf: filling the board until the opponent's piece can't fit = squeeze win", () => {
  const game = newTurfGame(1);
  // Doctor: everything full except a 2x2 hole at (0,0) and an O hole at (0,2).
  for (let col = 0; col < TURF_COLS; col++) {
    for (let band = 0; band < 3; band++) {
      if (col <= 1 && band === 0) continue;
      // mixed ownership so no filler row is ever PURE (row wins must not fire)
      game.placements.push(place("I", 1, col - 2, band * 4, col % 2 ? "p1" : "p2"));
    }
  }
  game.pieces[0] = "O"; // my move: plug the lower hole
  game.pieces[1] = "I"; // their next piece can never fit a 2x2
  const res = applyTurfMove(game, "p1", { moveN: 0, t: "O", r: 0, x: 0, y: 2 });
  assert.equal(res.kind, "game-over");
  if (res.kind === "game-over") {
    assert.equal(res.winner, "p1", "the squeezer wins");
    assert.equal(res.reason, "squeeze");
  }
});

test("turf: completing your pure row wins immediately", () => {
  const game = newTurfGame(1);
  game.pieces[0] = "J"; // deterministic test: force the finishing piece
  game.placements.push(place("I", 0, 0, TURF_ROWS - 2, "p1"));
  const res = applyTurfMove(game, "p1", { moveN: 0, t: "J", r: 0, x: 4, y: TURF_ROWS - 2 });
  assert.equal(res.kind, "game-over");
  if (res.kind === "game-over") {
    assert.equal(res.winner, "p1");
    assert.equal(res.reason, "row");
  }
});

test("turf: shot-clock expiry auto-drops; three in a row forfeits", () => {
  const game = newTurfGame(1);
  const past = Date.now() - TURF_TURN_MS - TURF_TURN_GRACE_MS - 1000;
  game.deadline = new Date(past).toISOString();
  const tick1 = tickTurfGame(game, Date.now());
  assert.equal(tick1.kind, "auto-placed", "first timeout auto-drops for the AFK player");
  assert.equal(game.timeouts.p1, 1);
  assert.equal(game.turn, "p2", "turn passed after the auto-drop");
  assert.equal(game.placements[0].by, "p1", "auto-drop is credited to the slacker");
  assert.equal(game.placements[0].auto, true, "auto-drop is MARKED — telemetry + client callout depend on it");
  // Both keep vanishing: p1 must reach TURF_MAX_TIMEOUTS consecutive misses.
  let over = null;
  for (let i = 0; i < 8 && !over; i++) {
    game.deadline = new Date(past).toISOString();
    const t = tickTurfGame(game, Date.now());
    if (t.kind === "game-over") over = t;
  }
  assert.ok(over, "forfeit eventually fires");
  assert.equal(over.winner, "p2");
  assert.equal(over.reason, "afk");
  assert.equal(game.timeouts.p1, TURF_MAX_TIMEOUTS, `forfeits on strike ${TURF_MAX_TIMEOUTS}`);
});

test("turf: a real move resets the consecutive-timeout counter", () => {
  const game = newTurfGame(1);
  const past = Date.now() - TURF_TURN_MS - TURF_TURN_GRACE_MS - 1000;
  game.deadline = new Date(past).toISOString();
  tickTurfGame(game, Date.now()); // p1 timeout #1 -> auto-drop, p2's turn
  const t = game.pieces[game.moveN];
  applyTurfMove(game, "p2", { moveN: game.moveN, t, r: 0, x: xRange(t, 0).min, y: yRange(t, 0).min });
  // p1 moves for real now — counter must reset.
  const t2 = game.pieces[game.moveN];
  const mv = applyTurfMove(game, "p1", { moveN: game.moveN, t: t2, r: 0, x: xRange(t2, 0).max, y: yRange(t2, 0).min });
  assert.equal(mv.kind, "placed");
  assert.equal(game.timeouts.p1, 0, "real move resets the AFK counter");
  assert.equal(game.placements[game.placements.length - 1].auto, undefined,
    "a HUMAN move must never carry the auto mark (the client callout keys on it)");
});

test("turf: autoPlacement tucks into the lowest open spot", () => {
  const g = turfGrid([]);
  const auto = autoPlacement(g, "O");
  assert.notEqual(auto, null);
  const a = auto as { r: number; x: number; y: number };
  const depth = Math.max(...STATES.O[a.r].cells.map(([, fy]) => a.y + fy));
  assert.equal(depth, TURF_ROWS - 1, "bottom row reached");
});

test("turf: starter alternates by game number", () => {
  assert.equal(newTurfGame(1).starter, "p1");
  assert.equal(newTurfGame(2).starter, "p2");
  assert.equal(newTurfGame(3).starter, "p1");
});

test("turf: piece budget covers a full board twice over", () => {
  const game = newTurfGame(1);
  assert.ok(game.pieces.length * 4 >= TURF_COLS * TURF_ROWS * 2);
});

test("turf (review): autoPlacement finds non-spawn rotations", () => {
  // Only column 6 open (a 1-wide, 12-tall well): flat I can't fit, vertical can.
  const placements: TurfPlacement[] = [];
  for (let col = 0; col < 6; col += 2) {
    for (let i = 0; i < 6; i++) placements.push(place("O", 0, col, TURF_ROWS - 2 * (i + 1), "p1"));
  }
  const g = turfGrid(placements);
  const auto = autoPlacement(g, "I");
  assert.notEqual(auto, null, "vertical rotation must be found");
  assert.ok((auto as { r: number }).r === 1 || (auto as { r: number }).r === 3);
});

test("turf (review): real moves are counted; auto-drops are not", () => {
  const game = newTurfGame(1);
  const t = game.pieces[0];
  applyTurfMove(game, "p1", { moveN: 0, t, r: 0, x: xRange(t, 0).min, y: yRange(t, 0).min });
  assert.equal(game.realMoves, 1);
  const past = Date.now() - TURF_TURN_MS - TURF_TURN_GRACE_MS - 1000;
  game.deadline = new Date(past).toISOString();
  tickTurfGame(game, Date.now()); // p2 auto-drop
  assert.equal(game.realMoves, 1, "auto-drop is not a real move");
});
