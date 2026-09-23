/* test/rfWeight.test.ts — Friend weight → fall speed, and unlock tiers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { weightClass, gravityScaleForWeight } from "../lib/rf/traits";
import { POWERUP_UNLOCK_RF } from "../lib/rf/economy-rules";
import { CATALOG } from "../lib/powerups";

test("earlier generations and higher activation tiers are heavier", () => {
  assert.equal(weightClass(6, 0), 1);
  assert.equal(weightClass(3, 0), 2);
  assert.equal(weightClass(1, 0), 3);
  assert.equal(weightClass(3, 4), 5); // capped
  assert.ok(weightClass(1, 1) > weightClass(6, 1));
});

test("heavier Friends fall slower, capped at 1.6x", () => {
  assert.equal(gravityScaleForWeight(1), 1);
  assert.equal(gravityScaleForWeight(5), 1.6);
  assert.equal(gravityScaleForWeight(99), 1.6);
  assert.ok(gravityScaleForWeight(3) > gravityScaleForWeight(2));
});

test("every active power-up has an unlock tier, ordered by power", () => {
  for (const p of CATALOG.filter((c) => c.active)) assert.ok(POWERUP_UNLOCK_RF[p.key] > 0, p.key);
  assert.ok(POWERUP_UNLOCK_RF.bomb > POWERUP_UNLOCK_RF.next_peek);
});
