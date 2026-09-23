import { test } from "node:test";
import assert from "node:assert/strict";
import { containsProfanity, validateHandle } from "../lib/handle";

test("containsProfanity folds leetspeak, separators, and repeats", () => {
  assert.equal(containsProfanity("f_u_c_k_er"), true); // separators stripped
  assert.equal(containsProfanity("sh1t"), true); // 1 -> i
  assert.equal(containsProfanity("a55hole"), true); // 5 -> s
  assert.equal(containsProfanity("fuuuck"), true); // repeated letters collapsed
  assert.equal(containsProfanity("b1tch"), true);
});

test("containsProfanity leaves clean names alone", () => {
  for (const name of ["PixelDoopie", "DoodleFan42", "smash_king", "GoreLord"]) {
    assert.equal(containsProfanity(name), false, name);
  }
});

test("validateHandle accepts clean names and rejects profane ones", () => {
  assert.equal(validateHandle("PixelDoopie").ok, true);
  assert.equal(validateHandle("a55hole").ok, false);
});
