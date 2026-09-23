import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LINE_CLEAR_BASE,
  scoreClear,
  softDropPoints,
  hardDropPoints,
  levelForLines,
  gravityMs,
} from "../lib/scoring";

test("base line-clear values match the original engine", () => {
  assert.deepEqual([...LINE_CLEAR_BASE], [0, 100, 300, 500, 800]);
});

test("single clear at level 1, first clear (combo starts at -1)", () => {
  const r = scoreClear(1, { level: 1, b2b: false, combo: -1 });
  assert.equal(r.points, 100); // 100*1, combo becomes 0 (no combo bonus)
  assert.equal(r.combo, 0);
  assert.equal(r.b2b, false);
});

test("tetris at level 1, no prior b2b", () => {
  const r = scoreClear(4, { level: 1, b2b: false, combo: -1 });
  assert.equal(r.points, 800);
  assert.equal(r.b2b, true);
  assert.equal(r.combo, 0);
});

test("back-to-back tetris applies 1.5x then combo bonus", () => {
  // second consecutive tetris: combo was 0, b2b true
  const r = scoreClear(4, { level: 1, b2b: true, combo: 0 });
  // 800*1 -> floor(800*1.5)=1200, combo->1 (>0) -> +50*1*1=50 => 1250
  assert.equal(r.points, 1250);
  assert.equal(r.b2b, true);
  assert.equal(r.combo, 1);
});

test("combo bonus scales with level", () => {
  // 2nd clear (combo was 0) of a single line at level 2
  const r = scoreClear(1, { level: 2, b2b: false, combo: 0 });
  // base 100*2=200, combo->1 (>0) -> +50*1*2=100 => 300
  assert.equal(r.points, 300);
  assert.equal(r.combo, 1);
});

test("triple clear at level 3", () => {
  const r = scoreClear(3, { level: 3, b2b: false, combo: -1 });
  assert.equal(r.points, 500 * 3); // 1500, no combo bonus
  assert.equal(r.b2b, false);
});

test("b2b breaks on a non-tetris clear", () => {
  const r = scoreClear(2, { level: 1, b2b: true, combo: 0 });
  // double does NOT get b2b multiplier; b2b flag becomes false
  assert.equal(r.b2b, false);
});

test("drop points", () => {
  assert.equal(softDropPoints(1), 1);
  assert.equal(softDropPoints(5), 5);
  assert.equal(hardDropPoints(5), 10);
  assert.equal(hardDropPoints(0), 0);
});

test("level progression every 10 lines", () => {
  assert.equal(levelForLines(0), 1);
  assert.equal(levelForLines(9), 1);
  assert.equal(levelForLines(10), 2);
  assert.equal(levelForLines(19), 2);
  assert.equal(levelForLines(25), 3);
});

test("gravity curve: level 1 is 1000ms and it accelerates", () => {
  assert.equal(gravityMs(1), 1000);
  assert.ok(gravityMs(2) < gravityMs(1));
  assert.ok(gravityMs(5) < gravityMs(2));
  assert.ok(gravityMs(10) > 0);
});


/* The public config feeds UNRANKED play; if it omits the scoring version,
   free games score under v1 while ranked runs use the live algorithm — the
   same displayed number meaning different things depending on sign-in. */
test("publicConfig exposes the scoring version to unranked play", async () => {
  const { publicConfig, DEFAULT_CONFIG, sanitizeConfig } = await import("../lib/gameConfig");
  const { SCORING_ALGO_V } = await import("../lib/scoring");
  const pub = publicConfig(DEFAULT_CONFIG);
  assert.equal(pub.scoring.v, SCORING_ALGO_V, "live version reaches the client");
  // and a stored doc can never pin the LIVE config to an old algorithm
  const stale = sanitizeConfig({ scoring: { v: 1 } });
  assert.equal(publicConfig(stale).scoring.v, SCORING_ALGO_V, "live version is code-owned");
});
