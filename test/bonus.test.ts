import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bonusRng,
  pickBonusKind,
  resolveBonus,
  occupiedCells,
  uniqueCells,
  sanitizeBonus,
  gutsForClear,
  meterTarget,
  applyBonusGravity,
  DEFAULT_BONUS,
  BONUS_ALGO_V,
  RAT_BITE,
} from "../lib/bonus";

const COLS = 10;
const TOTAL = 22;

/** Small synthetic board: bottom 4 rows half-filled. */
function board(): unknown[][] {
  const b: unknown[][] = Array.from({ length: TOTAL }, () => Array(COLS).fill(null));
  for (let y = TOTAL - 4; y < TOTAL; y++) for (let x = 0; x < COLS; x++) if ((x + y) % 2 === 0) b[y][x] = true;
  return b;
}

test("resolveBonus is fully deterministic for (seed, idx)", () => {
  const a = resolveBonus(board(), 12345, 0, 3, DEFAULT_BONUS, COLS, TOTAL);
  const b = resolveBonus(board(), 12345, 0, 3, DEFAULT_BONUS, COLS, TOTAL);
  assert.deepEqual(a, b); // identical kind, hits, deletions, points
  const c = resolveBonus(board(), 12345, 1, 3, DEFAULT_BONUS, COLS, TOTAL);
  // a different bonus index draws from a different stream
  assert.notDeepEqual({ k: a.kind, h: a.hits }, { k: c.kind, h: c.hits });
});

test("bonus rng stream is independent of the piece bag", () => {
  // Consuming the bonus stream must not be the same generator state as the bag:
  // two different indexes give different sequences from the same seed.
  const r0 = bonusRng(999, 0);
  const r1 = bonusRng(999, 1);
  assert.notEqual(r0(), r1());
});

test("arrow strikes only hit occupied cells; deletions are unique + scored", () => {
  const b = board();
  const occ = new Set(occupiedCells(b).map(([x, y]) => `${x},${y}`));
  // find a seed whose bonus #0 is arrows (DEFAULT_BONUS is v3 → 4-kind picker)
  let seed = 1;
  while (pickBonusKind(bonusRng(seed, 0), 3) !== "arrows") seed++;
  const res = resolveBonus(b, seed, 0, 2, DEFAULT_BONUS, COLS, TOTAL);
  assert.equal(res.kind, "arrows");
  assert.equal(res.hits.length, DEFAULT_BONUS.arrowCount);
  for (const [x, y] of res.hits) assert.ok(occ.has(`${x},${y}`), "arrow hit an empty cell");
  assert.equal(res.deleted.length, uniqueCells(res.hits).length);
  assert.equal(res.points, res.deleted.length * DEFAULT_BONUS.pointsPerBlock * 2);
});

test("sword cuts stay in bounds and only cut occupied cells", () => {
  const b = board();
  let seed = 1;
  while (pickBonusKind(bonusRng(seed, 0), 3) !== "swords") seed++;
  const res = resolveBonus(b, seed, 0, 1, DEFAULT_BONUS, COLS, TOTAL);
  assert.equal(res.kind, "swords");
  assert.ok(res.slashGroups && res.slashGroups.length === DEFAULT_BONUS.swordSlashes);
  for (const [x, y] of res.hits) {
    assert.ok(x >= 0 && x < COLS && y >= 0 && y < TOTAL, "cut out of bounds");
    assert.ok(b[y][x], "cut an empty cell");
  }
});

test("empty board resolves to zero deletions and zero points", () => {
  const empty: unknown[][] = Array.from({ length: TOTAL }, () => Array(COLS).fill(null));
  const res = resolveBonus(empty, 42, 0, 5, DEFAULT_BONUS, COLS, TOTAL);
  assert.equal(res.deleted.length, 0);
  assert.equal(res.points, 0);
});

test("sanitizeBonus clamps out-of-range values into safe bounds", () => {
  // legacy snapshot (fillLines, no fillGuts) keeps LINES mode
  const legacy = sanitizeBonus({ enabled: true, fillLines: 0, arrowCount: 9999, swordSlashes: -3, pointsPerBlock: 1e9 });
  assert.equal(legacy.fillLines, 4); // floor
  assert.equal(legacy.fillGuts, undefined); // stays legacy
  assert.equal(legacy.arrowCount, 40); // ceiling
  assert.equal(legacy.swordSlashes, 1); // floor
  assert.equal(legacy.pointsPerBlock, 100); // ceiling
  // guts mode clamps + wins when both fields are present
  assert.equal(sanitizeBonus({ fillGuts: 2 } as never).fillGuts, 6); // floor
  assert.equal(sanitizeBonus({ fillGuts: 9999 } as never).fillGuts, 200); // ceiling
  assert.equal(sanitizeBonus({ fillGuts: 30, fillLines: 10 } as never).fillGuts, 30);
  assert.deepEqual(sanitizeBonus(null), DEFAULT_BONUS);
});

test("guts weighting: multi-line clears race the meter; meterTarget picks mode", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(gutsForClear), [0, 2, 5, 9, 14]);
  assert.ok(gutsForClear(4) > 4 * gutsForClear(1) / 2, "tetris is super-linear vs singles");
  assert.deepEqual(meterTarget(DEFAULT_BONUS), { mode: "guts", target: 20 });
  assert.deepEqual(
    meterTarget({ enabled: true, fillLines: 18, arrowCount: 12, swordSlashes: 3, pointsPerBlock: 10 }),
    { mode: "lines", target: 18 },
  );
});

/* ---------------- v2: versioning, anchored slashes, gravity ---------------- */

const V1: typeof DEFAULT_BONUS = { ...DEFAULT_BONUS, v: 1 };
const V2: typeof DEFAULT_BONUS = { ...DEFAULT_BONUS, v: 2 };

/** The tester's whiff scenario: a LOW, sparse stack (bottom 3 rows only). */
function lowBoard(): unknown[][] {
  const b: unknown[][] = Array.from({ length: TOTAL }, () => Array(COLS).fill(null));
  for (let y = TOTAL - 3; y < TOTAL; y++) for (let x = 0; x < COLS; x++) if ((x * 3 + y) % 4 === 0) b[y][x] = true;
  return b;
}

test("algorithm version: snapshots default to v1, live config to current", () => {
  assert.equal(sanitizeBonus({ enabled: true }, { snapshot: true }).v, 1); // pre-v2 snapshot
  assert.equal(sanitizeBonus({ enabled: true }).v, BONUS_ALGO_V); // live/client
  assert.equal(sanitizeBonus({ enabled: true, v: 1 }, { snapshot: true }).v, 1); // explicit sticks
  assert.equal(sanitizeBonus({ enabled: true, v: 2 }, { snapshot: true }).v, 2);
  assert.equal(sanitizeBonus({ enabled: true, v: 99 }).v, BONUS_ALGO_V); // clamped
  assert.equal(sanitizeBonus({ enabled: true, v: -3 }).v, 1);
  assert.equal(sanitizeBonus(null, { snapshot: true }).v, 1);
});

test("resolveBonus reports gravity per version", () => {
  assert.equal(resolveBonus(board(), 7, 0, 1, V1, COLS, TOTAL).gravity, false);
  assert.equal(resolveBonus(board(), 7, 0, 1, V2, COLS, TOTAL).gravity, true);
});

test("v2 swords NEVER whiff: every slash cuts ≥1 cell on a non-empty board", () => {
  const b = lowBoard();
  let swordRounds = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const res = resolveBonus(b, seed, 0, 1, V2, COLS, TOTAL);
    if (res.kind !== "swords") continue;
    swordRounds++;
    assert.equal(res.slashGroups!.length, V2.swordSlashes);
    assert.equal(res.slashLines!.length, V2.swordSlashes);
    for (const grp of res.slashGroups!) assert.ok(grp.length >= 1, `seed ${seed}: a slash whiffed under v2`);
    for (const [x, y] of res.hits) assert.ok(b[y][x], "cut an empty cell");
    assert.ok(res.points > 0, "sword round scored 0 under v2");
  }
  assert.ok(swordRounds > 100, "expected plenty of sword rounds in the sample");
});

test("v1 swords CAN whiff on a low stack (the bug v2 fixes) — semantics preserved", () => {
  const b = lowBoard();
  let whiffedRounds = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const res = resolveBonus(b, seed, 0, 1, V1, COLS, TOTAL);
    if (res.kind !== "swords") continue;
    if (res.deleted.length === 0) whiffedRounds++;
  }
  assert.ok(whiffedRounds > 0, "v1 should still reproduce the historical whiff (old snapshots replay this)");
});

test("v2 sword geometry is deterministic and its lines match its cuts", () => {
  const b = board();
  let seed = 1;
  while (pickBonusKind(bonusRng(seed, 0)) !== "swords") seed++;
  const a = resolveBonus(b, seed, 0, 2, V2, COLS, TOTAL);
  const c = resolveBonus(b, seed, 0, 2, V2, COLS, TOTAL);
  assert.deepEqual(a, c);
  // every cut cell lies inside its slash's 2-tall band
  a.slashGroups!.forEach((grp, s) => {
    const { y0, sl } = a.slashLines![s];
    for (const [x, y] of grp) {
      const band = y0 + Math.floor((x * sl) / 2);
      assert.ok(y === band || y === band + 1, "cut outside its slash band");
    }
  });
});

test("applyBonusGravity: survivors fall, per-column order + identity preserved", () => {
  const b: unknown[][] = Array.from({ length: 6 }, () => Array(3).fill(null));
  const top = { id: 1 }, mid = { id: 2 }, low = { id: 3 };
  b[0][0] = top; b[2][0] = mid; b[4][0] = low; // column 0: gaps everywhere
  b[5][1] = true; // column 1: already settled
  applyBonusGravity(b, 3, 6);
  assert.equal(b[5][0], low, "lowest survivor sits on the floor");
  assert.equal(b[4][0], mid, "order within the column preserved");
  assert.equal(b[3][0], top, "cell OBJECTS move intact (renderer needs identity)");
  assert.equal(b[0][0], null);
  assert.equal(b[2][0], null);
  assert.equal(b[5][1], true, "settled columns untouched");
  assert.equal(b[5][2], null, "empty columns untouched");
});

test("arrows land on the post-clear board the same in v1 and v2 (only swords/gravity changed)", () => {
  let seed = 1;
  while (pickBonusKind(bonusRng(seed, 0)) !== "arrows") seed++;
  const a1 = resolveBonus(board(), seed, 0, 2, V1, COLS, TOTAL);
  const a2 = resolveBonus(board(), seed, 0, 2, V2, COLS, TOTAL);
  assert.deepEqual(a1.hits, a2.hits);
  assert.deepEqual(a1.deleted, a2.deleted);
  assert.equal(a1.points, a2.points);
});

/* ---------------- v3: rat attack, banana banger, 4-way pick ---------------- */

const V3: typeof DEFAULT_BONUS = { ...DEFAULT_BONUS, v: 3 };

test("v3 draws all FOUR kinds; v1/v2 snapshots never see the new ones", () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= 400; seed++) seen.add(pickBonusKind(bonusRng(seed, 0), 3));
  assert.deepEqual([...seen].sort(), ["arrows", "banana", "rats", "swords"]);
  for (let seed = 1; seed <= 400; seed++) {
    const k2 = resolveBonus(board(), seed, 0, 1, V2, COLS, TOTAL).kind;
    assert.ok(k2 === "arrows" || k2 === "swords", "v2 snapshot produced a v3 kind");
  }
});

test("rat attack: anchored, contiguous, same-row bites of ≤ RAT_BITE occupied cells", () => {
  const b = lowBoard();
  let ratRounds = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const res = resolveBonus(b, seed, 0, 1, V3, COLS, TOTAL);
    if (res.kind !== "rats") continue;
    ratRounds++;
    assert.equal(res.ratRuns!.length, V3.ratCount);
    for (const run of res.ratRuns!) {
      assert.ok(run.cells.length >= 1 && run.cells.length <= RAT_BITE, "bite size out of range");
      for (let i = 0; i < run.cells.length; i++) {
        const [x, y] = run.cells[i];
        assert.ok(b[y][x], "gnawed an empty cell");
        assert.equal(y, run.y, "left its row");
        if (i > 0) assert.equal(x, run.cells[i - 1][0] + run.dir, "bite not contiguous in travel direction");
      }
    }
    assert.ok(res.points > 0);
  }
  assert.ok(ratRounds > 50, "expected plenty of rat rounds in the sample");
});

test("banana banger: exactly bananaShots strikes, occupied only, deterministic", () => {
  const b = board();
  let seed = 1;
  while (pickBonusKind(bonusRng(seed, 0), 3) !== "banana") seed++;
  const a = resolveBonus(b, seed, 0, 2, V3, COLS, TOTAL);
  const c = resolveBonus(b, seed, 0, 2, V3, COLS, TOTAL);
  assert.deepEqual(a, c);
  assert.equal(a.kind, "banana");
  assert.equal(a.hits.length, V3.bananaShots);
  for (const [x, y] of a.hits) assert.ok(b[y][x], "shot an empty cell");
  assert.equal(a.points, a.deleted.length * V3.pointsPerBlock * 2);
  assert.equal(a.gravity, true);
});

test("LIVE config version is code-owned: a stored v:2 can never pin production", async () => {
  // The previous deploy persisted bonus.v into game_config on admin saves.
  // The live sanitize must override it to the CURRENT algorithm, or bumping
  // BONUS_ALGO_V silently never activates (review finding). Snapshots keep
  // their played version — that's the per-run path, not the live one.
  const { sanitizeConfig } = await import("../lib/gameConfig");
  const live = sanitizeConfig({ bonus: { enabled: true, v: 2, fillGuts: 20 } });
  assert.equal(live.bonus.v, BONUS_ALGO_V);
  assert.equal(sanitizeBonus({ enabled: true, v: 2 }, { snapshot: true }).v, 2); // snapshots unaffected
});

test("sanitize clamps the new tuning + empty-board rat round is graceful", () => {
  assert.equal(sanitizeBonus({ enabled: true, ratCount: 999 }).ratCount, 12);
  assert.equal(sanitizeBonus({ enabled: true, ratCount: 0 }).ratCount, 1);
  assert.equal(sanitizeBonus({ enabled: true, bananaShots: 999 }).bananaShots, 30);
  assert.equal(sanitizeBonus({ enabled: true, bananaShots: -1 }).bananaShots, 1);
  const empty: unknown[][] = Array.from({ length: TOTAL }, () => Array(COLS).fill(null));
  let seed = 1;
  while (pickBonusKind(bonusRng(seed, 0), 3) !== "rats") seed++;
  const res = resolveBonus(empty, seed, 0, 1, V3, COLS, TOTAL);
  assert.equal(res.deleted.length, 0);
  assert.equal(res.points, 0);
});
