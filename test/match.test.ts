/* test/match.test.ts — pure VERSUS logic: round decisions, match verdicts,
   and the versus config snapshot. DB flows live in scripts/verify-db.mjs. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRound,
  matchVerdict,
  versusConfig,
  WAGER_TIERS,
  WINS_NEEDED,
  BEST_OF,
  MAX_ROUNDS,
} from "../lib/match";
import { DEFAULT_CONFIG } from "../lib/gameConfig";

test("decideRound: higher score wins, equal is a tie", () => {
  assert.equal(decideRound(100, 50), "p1");
  assert.equal(decideRound(50, 100), "p2");
  assert.equal(decideRound(0, 0), "tie");
  assert.equal(decideRound(1234, 1234), "tie");
});

test("matchVerdict: first to WINS_NEEDED takes it", () => {
  assert.equal(matchVerdict(WINS_NEEDED, 0, WINS_NEEDED), "p1");
  assert.equal(matchVerdict(0, WINS_NEEDED, WINS_NEEDED), "p2");
  assert.equal(matchVerdict(WINS_NEEDED - 1, WINS_NEEDED - 1, BEST_OF - 1), null);
});

test("matchVerdict: ties extend past BEST_OF (sudden death) until MAX_ROUNDS draw", () => {
  // 2-2 after 5 rounds (one tie) → keep playing.
  assert.equal(matchVerdict(2, 2, BEST_OF), null);
  // Ahead after 5 without reaching 3 (ties ate rounds) → leader takes it.
  assert.equal(matchVerdict(2, 1, BEST_OF), "p1");
  assert.equal(matchVerdict(1, 2, BEST_OF), "p2");
  // All-tie apocalypse → draw at the cap, never an infinite match.
  assert.equal(matchVerdict(0, 0, MAX_ROUNDS), "draw");
  assert.equal(matchVerdict(2, 2, MAX_ROUNDS), "draw");
});

test("versusConfig: bonus + drops disabled, base tuning otherwise intact", () => {
  const cfg = versusConfig(DEFAULT_CONFIG);
  assert.equal(cfg.bonus.enabled, false);
  assert.equal(cfg.drops.enabled, false);
  assert.equal(cfg.gore.intensity, DEFAULT_CONFIG.gore.intensity);
  // Base solo config must be untouched (no shared-reference mutation).
  assert.equal(DEFAULT_CONFIG.bonus.enabled, false);
  assert.equal(DEFAULT_CONFIG.drops.enabled, true);
});

test("wager tiers include free play and are ascending", () => {
  assert.equal(WAGER_TIERS[0], 0);
  for (let i = 1; i < WAGER_TIERS.length; i++) assert.ok(WAGER_TIERS[i] > WAGER_TIERS[i - 1]);
});
