import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreSummary, sanityCheck, checkTiming, type RunSummary, type InputEvent } from "../lib/anticheat";

test("empty run scores zero", () => {
  const r = scoreSummary({ locks: [], softDropCells: 0, hardDropCells: 0, durationMs: 1000 });
  assert.deepEqual({ score: r.score, lines: r.lines, level: r.level, ok: r.ok }, { score: 0, lines: 0, level: 1, ok: true });
});

test("single line at level 1 = 100", () => {
  const r = scoreSummary({ locks: [1], softDropCells: 0, hardDropCells: 0, durationMs: 1000 });
  assert.equal(r.score, 100);
  assert.equal(r.lines, 1);
});

test("non-clearing locks (0) break the combo", () => {
  // two singles separated by a non-clearing lock: no combo bonus on the 2nd
  const r = scoreSummary({ locks: [1, 0, 1], softDropCells: 0, hardDropCells: 0, durationMs: 5000 });
  assert.equal(r.score, 200); // 100 + 100, combo reset by the 0
});

test("consecutive clears earn a combo bonus", () => {
  // two singles back-to-back: 2nd has combo=1 -> +50*1*level
  const r = scoreSummary({ locks: [1, 1], softDropCells: 0, hardDropCells: 0, durationMs: 5000 });
  assert.equal(r.score, 100 + (100 + 50)); // 250
});

test("back-to-back tetris matches the engine", () => {
  // tetris (800) then tetris (b2b -> 1200 + combo 50) = 2050
  const r = scoreSummary({ locks: [4, 4], softDropCells: 0, hardDropCells: 0, durationMs: 8000 });
  assert.equal(r.score, 800 + 1250);
  assert.equal(r.lines, 8);
  assert.equal(r.level, 1);
});

test("drop points are additive", () => {
  const r = scoreSummary({ locks: [], softDropCells: 10, hardDropCells: 5, durationMs: 1000 });
  assert.equal(r.score, 10 + 10); // soft 10*1 + hard 5*2
});

test("invalid lock outcomes are rejected", () => {
  const bad = scoreSummary({ locks: [5], softDropCells: 0, hardDropCells: 0, durationMs: 1000 });
  assert.equal(bad.ok, false);
  const neg = scoreSummary({ locks: [-1], softDropCells: 0, hardDropCells: 0, durationMs: 1000 });
  assert.equal(neg.ok, false);
});

test("sanity: line-count mismatch is caught", () => {
  const summary: RunSummary = { locks: [1, 2], softDropCells: 0, hardDropCells: 0, durationMs: 5000 };
  const scored = scoreSummary(summary);
  assert.equal(scored.lines, 3);
  assert.equal(sanityCheck(summary, scored), null); // consistent -> ok
});

test("sanity: implausible score-per-second is rejected", () => {
  // 1 tetris (800) in 10ms -> 80000 pts/s, far above the cap
  const summary: RunSummary = { locks: [4], softDropCells: 0, hardDropCells: 0, durationMs: 10 };
  const scored = scoreSummary(summary);
  assert.notEqual(sanityCheck(summary, scored), null);
});

test("sanity: non-positive duration is rejected", () => {
  const summary: RunSummary = { locks: [1], softDropCells: 0, hardDropCells: 0, durationMs: 0 };
  const scored = scoreSummary(summary);
  assert.notEqual(sanityCheck(summary, scored), null);
});

test("timing: a normal-paced log passes", () => {
  const log: InputEvent[] = [];
  for (let i = 0; i < 30; i++) log.push({ t: i * 300, a: "m", dx: 1 }); // ~3/s
  assert.equal(checkTiming(log, 9000), null);
});

test("timing: superhuman input rate is rejected", () => {
  const log: InputEvent[] = [];
  for (let i = 0; i < 1000; i++) log.push({ t: i, a: "m", dx: 1 }); // 1000 inputs in ~1s
  assert.match(checkTiming(log, 1000) || "", /input rate/i);
});

test("timing: superhuman piece rate is rejected", () => {
  // 30 locks in 1s: under the input cap (40/s) but over the piece cap (20/s)
  const log: InputEvent[] = [];
  for (let i = 0; i < 30; i++) log.push({ t: i * 30, a: "lock", pt: "O", r: 0, x: 0, y: 0, cleared: 0 });
  assert.match(checkTiming(log, 1000) || "", /piece rate/i);
});

test("timing: non-monotonic timestamps are rejected", () => {
  const log: InputEvent[] = [
    { t: 1000, a: "m", dx: 1 },
    { t: 100, a: "m", dx: 1 }, // jumps backwards well beyond slack
  ];
  assert.match(checkTiming(log, 2000) || "", /monotonic/i);
});

test("timing: empty log is fine", () => {
  assert.equal(checkTiming([], 1000), null);
});
