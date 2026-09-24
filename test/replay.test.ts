import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayRun } from "../lib/replay";
import { SevenBag } from "../lib/rng";
import { scoreClear, levelForLines, smashClearPoints, SCORING_ALGO_V } from "../lib/scoring";
import {
  COLS,
  TOTAL,
  STATES,
  emptyBoard,
  collides,
  spawnX,
  bombBlast,
  type Board,
} from "../lib/pieces";
import type { PieceType } from "../lib/rng";

const golden = JSON.parse(
  readFileSync(join(process.cwd(), "test", "fixtures", "golden-run.json"), "utf8"),
);
const powerupRun = JSON.parse(
  readFileSync(join(process.cwd(), "test", "fixtures", "powerup-run.json"), "utf8"),
);

test("golden run: replay reproduces the REAL client score exactly", () => {
  const r = replayRun(golden.seed, golden.log, golden.summary);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.score, golden.score); // 326, captured from the live engine
  assert.equal(r.lines, golden.lines);
  assert.equal(r.pieces, golden.log.filter((e: { a: string }) => e.a === "lock").length);
});

test("golden run with BOMB + REROLL: replay reproduces the REAL client score", () => {
  // captured from the live engine using bomb x5, reroll x7, slow_fall x8
  const r = replayRun(powerupRun.seed, powerupRun.log, powerupRun.summary);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.score, powerupRun.score); // 524 — bomb blasts + reroll bag-advance reproduced
  assert.equal(r.lines, powerupRun.lines);
});

test("tamper: a forged piece type is rejected", () => {
  const log = golden.log.map((e: { a: string; pt?: string }) =>
    e.a === "lock" ? { ...e, pt: e.pt === "I" ? "O" : "I" } : e,
  );
  const r = replayRun(golden.seed, log, golden.summary);
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /sequence mismatch/i);
});

test("tamper: a floating (ungrounded) placement is rejected", () => {
  let mutated = false;
  const log = golden.log.map((e: { a: string; y?: number }) => {
    if (e.a === "lock" && !mutated) {
      mutated = true;
      return { ...e, y: (e.y as number) - 5 }; // lift it into mid-air
    }
    return e;
  });
  const r = replayRun(golden.seed, log, golden.summary);
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /unreachable|ungrounded|placement/i);
});

test("tamper: inflated hard-drop cells are rejected", () => {
  const summary = { ...golden.summary, hardDropCells: 10_000_000 };
  const r = replayRun(golden.seed, golden.log, summary);
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /drop count out of bounds/i);
});

/* A deterministic flat-stacking bot that shares the canonical mechanics. It
   produces real line clears so the replay's clear-scoring path is exercised
   end-to-end and cross-checked against an independent computation. */
function simulateGreedy(seed: number, maxPieces: number) {
  const bag = new SevenBag(seed >>> 0);
  const board: Board = emptyBoard();
  const log: Array<Record<string, unknown>> = [];
  let score = 0;
  let lines = 0;
  let level = 1;
  let combo = -1;
  let b2b = false;
  let pieces = 0;

  const colHeights = () => {
    const h = Array(COLS).fill(TOTAL);
    for (let x = 0; x < COLS; x++)
      for (let y = 0; y < TOTAL; y++)
        if (board[y][x]) {
          h[x] = y;
          break;
        }
    return h;
  };

  for (let i = 0; i < maxPieces; i++) {
    const t = bag.next();
    // enumerate all grounded placements; pick the one with the lowest stack
    let best: { r: number; x: number; y: number; cleared: number } | null = null;
    let bestCost = Infinity;
    for (let r = 0; r < 4; r++) {
      for (let x = -2; x < COLS; x++) {
        if (collides(board, t, r, x, -2)) continue; // can't enter at top
        let y = -2;
        while (!collides(board, t, r, x, y + 1)) y++;
        if (collides(board, t, r, x, y)) continue; // invalid
        // simulate placement cost
        let top = TOTAL;
        let bad = false;
        for (const [fx, fy] of STATES[t][r].cells) {
          const cy = y + fy;
          if (cy < 0) {
            bad = true;
            break;
          }
          top = Math.min(top, cy);
        }
        if (bad) continue;
        const cost = -top; // prefer lower placements (larger y == lower == smaller -top)
        if (cost < bestCost) {
          bestCost = cost;
          best = { r, x, y, cleared: 0 };
        }
      }
    }
    if (!best) break; // topped out

    // apply
    for (const [fx, fy] of STATES[t][best.r].cells) board[best.y + fy][best.x + fx] = true;
    const keep: Board = [];
    let n = 0;
    for (let y = 0; y < TOTAL; y++) {
      if (board[y].every((c) => c)) n++;
      else keep.push(board[y]);
    }
    while (keep.length < TOTAL) keep.unshift(Array(COLS).fill(null));
    for (let y = 0; y < TOTAL; y++) board[y] = keep[y];

    best.cleared = n;
    log.push({ t: i, a: "lock", pt: t, r: best.r, x: best.x, y: best.y, cleared: n });

    if (n > 0) {
      const res = scoreClear(n, { level, b2b, combo });
      score += res.points;
      b2b = res.b2b;
      combo = res.combo;
      lines += n;
      level = levelForLines(lines);
    } else {
      combo = -1;
    }
    pieces++;
    void colHeights;
  }

  return { log, score, lines, pieces };
}

// Landing position for a piece hard-dropped at spawn on an empty board.
function landOnEmpty(t: PieceType) {
  const board = emptyBoard();
  let y = -2;
  if (collides(board, t, 0, spawnX(t), y)) throw new Error("spawn blocked");
  while (!collides(board, t, 0, spawnX(t), y + 1)) y++;
  return { r: 0, x: spawnX(t), y };
}

test("bombBlast: 3x3 box centered on the piece, clipped to the board", () => {
  // O at x=4,y=0 occupies (0,4),(0,5),(1,4),(1,5); centroid ~ (4.5,0.5)->round(5,1)
  const cells = bombBlast("O", 0, 4, 0);
  // all in-bounds, forms a contiguous box, count 9 (fully on-board here)
  assert.equal(cells.length, 9);
  for (const [x, y] of cells) {
    assert.ok(x >= 0 && x < COLS && y >= 0 && y < TOTAL);
  }
});

test("reroll: replay advances the bag (accepts the 2nd piece, rejects the 1st-as-2nd)", () => {
  const seed = 13579;
  const bag = new SevenBag(seed);
  const p0 = bag.next();
  const p1 = bag.next();
  const place = landOnEmpty(p1);
  const summary = { locks: [0], softDropCells: 0, hardDropCells: 0, durationMs: 5000 };

  // With a reroll, current becomes p1 — locking p1 is valid.
  const withReroll = replayRun(
    seed,
    [
      { t: 100, a: "powerup", key: "reroll" },
      { t: 200, a: "lock", pt: p1, r: place.r, x: place.x, y: place.y, cleared: 0 },
    ],
    summary,
  );
  assert.equal(withReroll.ok, true, withReroll.reason);

  // Without the reroll, the expected first piece is p0 — locking p1 must reject.
  const noReroll = replayRun(
    seed,
    [{ t: 200, a: "lock", pt: p1, r: place.r, x: place.x, y: place.y, cleared: 0 }],
    summary,
  );
  // (only meaningful when p0 !== p1, which holds for a 7-bag's first two draws)
  assert.notEqual(p0, p1);
  assert.equal(noReroll.ok, false);
});

test("clear-scoring: replay matches an independent flat-stacking simulation", () => {
  // find a seed that yields at least one clear within 60 pieces
  let sim = simulateGreedy(1, 60);
  let seed = 1;
  for (let s = 1; s <= 20 && sim.lines === 0; s++) {
    seed = s;
    sim = simulateGreedy(s, 60);
  }
  assert.ok(sim.lines > 0, "expected the bot to clear at least one line");

  const summary = { locks: [], softDropCells: 0, hardDropCells: 0, durationMs: sim.pieces * 1000 };
  const r = replayRun(seed, sim.log as never, summary);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.lines, sim.lines);
  assert.equal(r.score, sim.score); // clear-scoring path agrees
});


/* ---------------- SMASH-clear bonus (scoring v2) ----------------
   The bonus is DERIVED SERVER-SIDE from the log's "hd" events — the client
   never reports which clears were smashes. These pin that, and that a v1
   snapshot (or a missing one) re-scores under the OLD rules so historical
   leaderboard scores never change under us. */

test("smash bonus: v1 (and unversioned) runs score exactly as before", () => {
  const base = replayRun(golden.seed, golden.log, golden.summary);
  const v1 = replayRun(golden.seed, golden.log, golden.summary, { v: 1 });
  assert.equal(base.ok, true, base.reason);
  assert.equal(v1.score, base.score, "v1 unchanged");
  assert.equal(base.score, golden.score, "unversioned defaults to v1");
});

/** A bot run that actually clears lines (the golden fixture clears none). */
function simWithClears() {
  for (let seed = 1; seed <= 20; seed++) {
    const sim = simulateGreedy(seed, 60);
    if (sim.lines > 0) return { seed, sim };
  }
  throw new Error("no seed produced a line clear");
}

test("smash bonus: v2 pays ONLY for clears the log attests were hard-dropped", () => {
  const { seed, sim } = simWithClears();
  const base = { locks: [], softDropCells: 0, hardDropCells: 0, durationMs: sim.pieces * 1000 };
  // The bot's log has NO "hd" events — so v2 must score identically to v1.
  const v1 = replayRun(seed, sim.log as never, base, { v: 1 });
  const v2 = replayRun(seed, sim.log as never, base, { v: 2 });
  assert.equal(v1.ok, true, v1.reason);
  assert.equal(v2.score, v1.score, "clears that were not smashed earn nothing");

  // Now commit every piece with a 1-cell hard drop and re-score.
  const hdLog: Array<Record<string, unknown>> = [];
  let hdCount = 0;
  for (const ev of sim.log as Array<Record<string, unknown>>) {
    if (ev.a === "lock") { hdLog.push({ t: ev.t, a: "hd", cells: 1 }); hdCount++; }
    hdLog.push(ev);
  }
  const smashed = { locks: [], softDropCells: 0, hardDropCells: hdCount, durationMs: sim.pieces * 1000 };
  const s1 = replayRun(seed, hdLog as never, smashed, { v: 1 });
  const s2 = replayRun(seed, hdLog as never, smashed, { v: 2 });
  assert.equal(s1.ok, true, s1.reason);
  assert.equal(s2.ok, true, s2.reason);

  // Expected: 50 x level for each clearing lock, at the level AFTER the clear.
  let lines = 0, expected = 0;
  for (const ev of sim.log as Array<Record<string, unknown>>) {
    if (ev.a !== "lock") continue;
    const n = Number(ev.cleared ?? 0);
    if (n > 0) { lines += n; expected += smashClearPoints(levelForLines(lines)); }
  }
  assert.ok(expected > 0, "the bot run does clear lines");
  assert.equal(s2.score - s1.score, expected, "bonus equals exactly the log-attested smash clears");
});

test("smash bonus: hard drops that clear NOTHING pay no bonus", () => {
  // The golden run is 18 hard drops and zero clears — pure smashes, no bonus.
  const v1 = replayRun(golden.seed, golden.log, golden.summary, { v: 1 });
  const v2 = replayRun(golden.seed, golden.log, golden.summary, { v: 2 });
  assert.equal(v2.ok, true, v2.reason);
  assert.equal(v2.score, v1.score, "a smash only pays when it clears a line");
  assert.equal(v2.score, golden.score);
});

test("smash bonus: the log's hard-drop cells must agree with the summary", () => {
  const bad = { ...golden.summary, hardDropCells: golden.summary.hardDropCells + 7 };
  const r = replayRun(golden.seed, golden.log, bad, { v: 2 });
  assert.equal(r.ok, false, "a doctored summary is rejected");
  assert.match(r.reason ?? "", /hard-drop mismatch/);
});

test("smash bonus: SCORING_ALGO_V is the live version", () => {
  assert.equal(SCORING_ALGO_V, 2);
});
