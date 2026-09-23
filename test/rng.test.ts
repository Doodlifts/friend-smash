import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32, SevenBag, BAG_TYPES } from "../lib/rng";

test("mulberry32 is deterministic for a given seed", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1, `value ${v} out of [0,1)`);
  }
});

test("mulberry32 differs across seeds", () => {
  const a = mulberry32(1)();
  const b = mulberry32(2)();
  assert.notEqual(a, b);
});

test("SevenBag produces the same sequence for the same seed (replay contract)", () => {
  const a = new SevenBag(987654);
  const b = new SevenBag(987654);
  const seqA = Array.from({ length: 35 }, () => a.next());
  const seqB = Array.from({ length: 35 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test("SevenBag: every group of 7 is a permutation of all 7 types", () => {
  const bag = new SevenBag(42);
  for (let g = 0; g < 10; g++) {
    const group = Array.from({ length: 7 }, () => bag.next()).sort();
    assert.deepEqual(group, BAG_TYPES.slice().sort());
  }
});

test("SevenBag: no type appears twice within a single bag of 7", () => {
  const bag = new SevenBag(7);
  for (let g = 0; g < 10; g++) {
    const group = Array.from({ length: 7 }, () => bag.next());
    assert.equal(new Set(group).size, 7);
  }
});

test("SevenBag.preview matches the upcoming next() draws and does not consume", () => {
  const bag = new SevenBag(555);
  const peek = bag.preview(10);
  const drawn = Array.from({ length: 10 }, () => bag.next());
  assert.deepEqual(peek, drawn);
});

test("different seeds almost always yield different sequences", () => {
  const s1 = Array.from({ length: 14 }, ((b) => () => b.next())(new SevenBag(1)));
  const s2 = Array.from({ length: 14 }, ((b) => () => b.next())(new SevenBag(2)));
  assert.notDeepEqual(s1, s2);
});
