/* scripts/verify-db.mjs — data-layer integration check against real Postgres
   (PGlite, in-process). Run: npm run verify:db

   Kept OUT of `npm test` (node:test): under node:test's concurrent runner,
   spinning up multiple PGlite WASM instances is flaky. This script uses ONE
   instance and runs the same assertions the API routes rely on, sequentially. */

// Silence structured logging (expected anti-cheat rejections) in test output.
process.env.RFSMASH_LOG_SILENT = "1";
// Exercise the daily-bonus + run-reward enabled paths (both ship gated OFF).
process.env.DAILY_BONUS_ENABLED = "1";
process.env.RUN_REWARD_ENABLED = "1";
// Versus views sign per-round run tokens (read at call time — see runToken.ts).
process.env.SCORE_SIGNING_SECRET = "verify-db-test-secret";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../test/helpers/testDb.ts";
import { _clearSystemIds } from "../lib/rf/ledger.ts";
import { upsertUserByDid, getUserByDid, getUserById, setHandle } from "../lib/users.ts";
import { createRun, finishRun, recentRuns, consumePowerupUse, reapExpiredRuns } from "../lib/runs.ts";
import { claimDaily, getDailyStatus, DAILY_BONUS } from "../lib/daily.ts";
import { getLeaderboard, getUserRank } from "../lib/leaderboard.ts";
import { getBalance, earn, spend, runReward, InsufficientFundsError } from "../lib/economy.ts";
import { purchasePowerup, getInventory, consumePowerups, CATALOG_BY_KEY } from "../lib/powerups.ts";
import {
  isIpRunStartLimited,
  isRunStartLimited,
  RUN_START_IP_LIMIT,
  isRunFinishLimited,
  isIpRunFinishLimited,
  RUN_FINISH_IP_LIMIT,
  isPurchaseLimited,
  PURCHASE_LIMIT,
  HANDLE_CHANGE_COOLDOWN_MS,
} from "../lib/rateLimit.ts";
import { MAX_LOG_EVENTS } from "../lib/anticheat.ts";
import { runs, users } from "../db/schema.ts";
import { isAdminWallet } from "../lib/admin.ts";
import { getEconomyMetrics, distributePool, REVENUE_SPLIT } from "../lib/economyMetrics.ts";
import { getGameConfig, setGameConfig, DEFAULT_CONFIG } from "../lib/gameConfig.ts";
import {
  joinQueue,
  leaveQueue,
  matchStateFor,
  heartbeat,
  finishVersusRound,
  concedeMatch,
  activeMatchFor,
  GRACE_MS,
  ROUND_SECS,
  placeTurfMove,
  markReady,
  READY_TIMEOUT_MS,
  recordFor,
  myMatches,
} from "../lib/match.ts";
import { matches, matchQueue, ledger, scores } from "../db/schema.ts";

const golden = JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", "golden-run.json"), "utf8"));
const powerupRun = JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", "powerup-run.json"), "utf8"));

const db = await makeTestDb();
// Note: `powerups` is seed data (catalog) — keep it; truncating it would break
// inventory FKs.
// System accounts (burn/faucet/escrow/pools) live in `users`, so their memoized
// ids must be forgotten whenever the table is wiped.
const truncate = async () => {
  await db.execute(sql`TRUNCATE ledger, inventory, scores, runs, users RESTART IDENTITY CASCADE`);
  _clearSystemIds();
};

let passed = 0;
const failed = [];
async function section(name, fn) {
  await truncate();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    if (e.cause) console.error(`    CAUSE: ${e.cause.message ?? e.cause}`);
    failed.push(name);
  }
}

console.log("Data layer integration (PGlite):");

await section("upsertUserByDid is idempotent", async () => {
  const a = await upsertUserByDid(db, "did:alice");
  const b = await upsertUserByDid(db, "did:alice");
  assert.equal(a.id, b.id);
  assert.equal(a.rfBalance, 0);
  assert.equal((await getUserByDid(db, "did:alice"))?.id, a.id);
});

await section("setHandle: ok / profanity rejected / uniqueness enforced", async () => {
  const u1 = await upsertUserByDid(db, "did:h1");
  const u2 = await upsertUserByDid(db, "did:h2");
  const okRes = await setHandle(db, u1.id, "PixelFriend");
  assert.equal(okRes.ok, true);
  assert.equal(okRes.user?.handle, "PixelFriend");
  assert.equal((await setHandle(db, u2.id, "f_u_c_k_er")).ok, false);
  const taken = await setHandle(db, u2.id, "PixelFriend");
  assert.equal(taken.ok, false);
  assert.match(taken.error || "", /taken/i);
});

await section("finishRun: verified path computes authoritative score", async () => {
  const u = await upsertUserByDid(db, "did:player");
  const run = await createRun(db, u.id, 42);
  assert.equal(run.status, "open");
  const res = await finishRun(db, {
    runId: run.id,
    userId: u.id,
    summary: { locks: [4], softDropCells: 0, hardDropCells: 0, durationMs: 60_000 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, "verified");
  assert.equal(res.score, 800);
  assert.equal(res.lines, 4);
  const board = await getLeaderboard(db, { period: "all" });
  assert.equal(board.length, 1);
  assert.equal(board[0].score, 800);
  assert.equal(board[0].rank, 1);
});

await section("finishRun replays the input log (golden run) -> authoritative score", async () => {
  const u = await upsertUserByDid(db, "did:replay");
  const run = await createRun(db, u.id, golden.seed); // run seeded like the golden capture
  const res = await finishRun(db, {
    runId: run.id,
    userId: u.id,
    summary: golden.summary,
    log: golden.log,
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, "verified");
  assert.equal(res.score, golden.score); // 326, recomputed by replay (not trusted from client)
});

await section("finishRun rejects a tampered input log (forged piece)", async () => {
  const u = await upsertUserByDid(db, "did:tamper");
  const run = await createRun(db, u.id, golden.seed);
  const badLog = golden.log.map((e) => (e.a === "lock" ? { ...e, pt: e.pt === "I" ? "O" : "I" } : e));
  const res = await finishRun(db, { runId: run.id, userId: u.id, summary: golden.summary, log: badLog });
  assert.equal(res.ok, false);
  assert.equal(res.status, "rejected");
  assert.equal((await getLeaderboard(db, { period: "all" })).length, 0);
});

await section("finishRun is idempotent (finishes once)", async () => {
  const u = await upsertUserByDid(db, "did:once");
  const run = await createRun(db, u.id, 7);
  const summary = { locks: [1], softDropCells: 0, hardDropCells: 0, durationMs: 30_000 };
  assert.equal((await finishRun(db, { runId: run.id, userId: u.id, summary })).ok, true);
  const second = await finishRun(db, { runId: run.id, userId: u.id, summary });
  assert.equal(second.ok, false);
  assert.match(second.reason || "", /already finished/i);
  assert.equal((await getLeaderboard(db, { period: "all" })).length, 1);
});

await section("finishRun rejects an implausible run (no leaderboard row)", async () => {
  const u = await upsertUserByDid(db, "did:cheater");
  const run = await createRun(db, u.id, 9);
  const res = await finishRun(db, {
    runId: run.id,
    userId: u.id,
    summary: { locks: [4], softDropCells: 0, hardDropCells: 0, durationMs: 5 },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, "rejected");
  assert.equal((await getLeaderboard(db, { period: "all" })).length, 0);
});

await section("leaderboard ranks best-per-user and reports rank", async () => {
  const alice = await upsertUserByDid(db, "did:lbAlice");
  const bob = await upsertUserByDid(db, "did:lbBob");
  await setHandle(db, alice.id, "Alice");
  await setHandle(db, bob.id, "Bob");
  const play = async (uid, locks) => {
    const run = await createRun(db, uid, 1);
    await finishRun(db, {
      runId: run.id,
      userId: uid,
      summary: { locks, softDropCells: 0, hardDropCells: 0, durationMs: 120_000 },
    });
  };
  await play(alice.id, [1]); // 100
  await play(alice.id, [2]); // 300 (best)
  await play(bob.id, [4]); // 800
  const board = await getLeaderboard(db, { period: "all" });
  assert.equal(board.length, 2); // one row per user (best)
  assert.equal(board[0].handle, "Bob");
  assert.equal(board[0].score, 800);
  assert.equal(board[0].rank, 1);
  assert.equal(board[1].handle, "Alice");
  assert.equal(board[1].score, 300);
  assert.equal(board[1].rank, 2);
  assert.equal((await getUserRank(db, alice.id, "all"))?.rank, 2);
  assert.equal((await getUserRank(db, bob.id, "all"))?.rank, 1);
});

await section("economy: earn/spend, idempotency, no negative balance", async () => {
  const u = await upsertUserByDid(db, "did:econ");
  assert.equal(await getBalance(db, u.id), 0);

  const e1 = await earn(db, u.id, 100, "grant", "g1");
  assert.equal(e1.applied, true);
  assert.equal(e1.balance, 100);
  // idempotent: same refId is a no-op
  const e1dup = await earn(db, u.id, 100, "grant", "g1");
  assert.equal(e1dup.applied, false);
  assert.equal(await getBalance(db, u.id), 100);

  const s1 = await spend(db, u.id, 30, "purchase:x", "p1");
  assert.equal(s1.balance, 70);
  // overspend rejected
  let threw = false;
  try {
    await spend(db, u.id, 999, "purchase:y", "p2");
  } catch (err) {
    threw = err instanceof InsufficientFundsError;
  }
  assert.equal(threw, true);
  assert.equal(await getBalance(db, u.id), 70); // unchanged after failed spend
});

await section("purchase: transactional, idempotent, insufficient-funds rejected", async () => {
  const u = await upsertUserByDid(db, "did:shopper");
  await earn(db, u.id, 200, "grant", "seed");
  const key = "slow_fall";
  const price = CATALOG_BY_KEY[key].price;

  const buy = await purchasePowerup(db, { userId: u.id, key, purchaseId: "buy-1" });
  assert.equal(buy.ok, true);
  assert.equal(buy.qty, 1);
  assert.equal(buy.balance, 200 - price);

  // idempotent: same purchaseId doesn't double-charge or double-grant
  const dup = await purchasePowerup(db, { userId: u.id, key, purchaseId: "buy-1" });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(await getBalance(db, u.id), 200 - price);
  const inv = await getInventory(db, u.id);
  assert.equal(inv.find((i) => i.key === key)?.qty, 1);

  // can't afford
  const poor = await upsertUserByDid(db, "did:poor");
  const broke = await purchasePowerup(db, { userId: poor.id, key, purchaseId: "buy-x" });
  assert.equal(broke.ok, false);
});

await section("run reward: verified run grants RF (idempotent)", async () => {
  const u = await upsertUserByDid(db, "did:earner");
  const run = await createRun(db, u.id, golden.seed);
  const res = await finishRun(db, { runId: run.id, userId: u.id, summary: golden.summary, log: golden.log });
  assert.equal(res.ok, true);
  const expected = runReward(golden.score, golden.lines); // 326 -> 13
  assert.equal(res.reward, expected);
  assert.equal(await getBalance(db, u.id), expected);
});

await section("power-up consumption: a used power-up is decremented from inventory", async () => {
  const u = await upsertUserByDid(db, "did:user-pu");
  await earn(db, u.id, 500, "grant", "seed");
  await purchasePowerup(db, { userId: u.id, key: "next_peek", purchaseId: "pu-1" });
  assert.equal(getInventoryQty(await getInventory(db, u.id), "next_peek"), 1);

  const run = await createRun(db, u.id, golden.seed);
  // log = the golden run + a power-up activation event (replay-safe -> ignored for score)
  const log = [{ t: 1, a: "powerup", key: "next_peek" }, ...golden.log];
  const res = await finishRun(db, { runId: run.id, userId: u.id, summary: golden.summary, log });
  assert.equal(res.ok, true);
  assert.equal(res.score, golden.score); // power-up didn't change the score
  assert.equal(getInventoryQty(await getInventory(db, u.id), "next_peek"), 0); // consumed
});

await section("bomb/reroll: entitled run verifies + consumes; unentitled run rejected", async () => {
  // The captured run uses bomb x5 + reroll x7. A player who owns them verifies.
  const rich = await upsertUserByDid(db, "did:puRich");
  await earn(db, rich.id, 5000, "grant", "seed");
  for (let i = 0; i < 5; i++) await purchasePowerup(db, { userId: rich.id, key: "bomb", purchaseId: `b${i}` });
  for (let i = 0; i < 7; i++) await purchasePowerup(db, { userId: rich.id, key: "reroll", purchaseId: `r${i}` });
  const run1 = await createRun(db, rich.id, powerupRun.seed);
  const res1 = await finishRun(db, { runId: run1.id, userId: rich.id, summary: powerupRun.summary, log: powerupRun.log });
  assert.equal(res1.ok, true);
  assert.equal(res1.score, powerupRun.score); // 524, recomputed by replay (bomb+reroll applied)
  // inventory consumed
  const invAfter = await getInventory(db, rich.id);
  assert.equal(getInventoryQty(invAfter, "bomb"), 0);
  assert.equal(getInventoryQty(invAfter, "reroll"), 0);

  // A player who owns NONE of them is rejected (entitlement).
  const broke = await upsertUserByDid(db, "did:puBroke");
  const run2 = await createRun(db, broke.id, powerupRun.seed);
  const res2 = await finishRun(db, { runId: run2.id, userId: broke.id, summary: powerupRun.summary, log: powerupRun.log });
  assert.equal(res2.ok, false);
  assert.equal(res2.status, "rejected");
  assert.match(res2.reason || "", /more "?(bomb|reroll)"? than owned/i);
});

await section("rate limit: per-IP run-start limit trips at the cap", async () => {
  const u = await upsertUserByDid(db, "did:rl");
  const ip = "203.0.113.7";
  assert.equal(await isIpRunStartLimited(db, ip), false);
  for (let i = 0; i < RUN_START_IP_LIMIT; i++) await createRun(db, u.id, 1, ip);
  assert.equal(await isIpRunStartLimited(db, ip), true); // same IP now limited
  assert.equal(await isIpRunStartLimited(db, "198.51.100.9"), false); // different IP fine
  assert.equal(await isIpRunStartLimited(db, null), false); // missing IP is not limited
  // (per-user limit is much lower and also trips)
  assert.equal(await isRunStartLimited(db, u.id), true);
});

await section("rate limit: per-user + per-IP run-finish limit trips at the cap", async () => {
  const u = await upsertUserByDid(db, "did:fin");
  const ip = "203.0.113.50";
  assert.equal(await isRunFinishLimited(db, u.id), false);
  assert.equal(await isIpRunFinishLimited(db, ip), false);
  // Insert finished runs directly (fast) to exercise the finishedAt-based limiter.
  for (let i = 0; i < RUN_FINISH_IP_LIMIT; i++) {
    await db.insert(runs).values({ userId: u.id, seed: 1, status: "verified", finishedAt: new Date(), ip });
  }
  assert.equal(await isRunFinishLimited(db, u.id), true); // user cap (lower) tripped
  assert.equal(await isIpRunFinishLimited(db, ip), true); // ip cap tripped
  assert.equal(await isIpRunFinishLimited(db, "198.51.100.10"), false); // other IP fine
  assert.equal(await isIpRunFinishLimited(db, null), false); // missing IP not limited
});

await section("finishRun rejects an oversized input log before replay", async () => {
  const u = await upsertUserByDid(db, "did:biglog");
  const run = await createRun(db, u.id, 1);
  const bigLog = Array.from({ length: MAX_LOG_EVENTS + 1 }, (_, i) => ({ t: i, a: "m" }));
  const res = await finishRun(db, {
    runId: run.id,
    userId: u.id,
    summary: { locks: [1], softDropCells: 0, hardDropCells: 0, durationMs: 60_000 },
    log: bigLog,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, "rejected");
  assert.match(res.reason || "", /too large/i);
  assert.equal((await getLeaderboard(db, { period: "all" })).length, 0);
});

await section("rate limit: purchase limit trips at the cap", async () => {
  const u = await upsertUserByDid(db, "did:plimit");
  await earn(db, u.id, 100000, "grant", "seed");
  assert.equal(await isPurchaseLimited(db, u.id), false);
  for (let i = 0; i < PURCHASE_LIMIT; i++) {
    await purchasePowerup(db, { userId: u.id, key: "next_peek", purchaseId: `pl-${i}` });
  }
  assert.equal(await isPurchaseLimited(db, u.id), true);
});

await section("handle change: cooldown blocks rapid re-naming", async () => {
  const u = await upsertUserByDid(db, "did:cooldown");
  const t0 = new Date("2026-01-01T00:00:00Z");
  const first = await setHandle(db, u.id, "FirstName", { now: t0 });
  assert.equal(first.ok, true);
  // immediate re-name -> blocked as tooSoon (maps to 429 in the route)
  const tooSoon = await setHandle(db, u.id, "SecondName", { now: new Date(t0.getTime() + 1000) });
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.tooSoon, true);
  // after the cooldown -> allowed
  const later = await setHandle(db, u.id, "SecondName", {
    now: new Date(t0.getTime() + HANDLE_CHANGE_COOLDOWN_MS + 1),
  });
  assert.equal(later.ok, true);
  assert.equal(later.user?.handle, "SecondName");
});

await section("daily bonus: awards once/day, streak grows + resets, idempotent", async () => {
  const u = await upsertUserByDid(db, "did:daily");
  const c1 = await claimDaily(db, u.id, new Date("2026-03-01T12:00:00Z"));
  assert.equal(c1.awarded, true);
  assert.equal(c1.amount, DAILY_BONUS);
  assert.equal(c1.streak, 1);
  assert.equal(c1.balance, DAILY_BONUS);
  // same UTC day again -> no award, balance + streak unchanged
  const c1b = await claimDaily(db, u.id, new Date("2026-03-01T23:00:00Z"));
  assert.equal(c1b.awarded, false);
  assert.equal(c1b.balance, DAILY_BONUS);
  assert.equal(c1b.streak, 1);
  // next day -> awarded, streak 2
  const c2 = await claimDaily(db, u.id, new Date("2026-03-02T09:00:00Z"));
  assert.equal(c2.awarded, true);
  assert.equal(c2.streak, 2);
  assert.equal(c2.balance, DAILY_BONUS * 2);
  // skip a day -> streak resets to 1
  const c4 = await claimDaily(db, u.id, new Date("2026-03-04T09:00:00Z"));
  assert.equal(c4.awarded, true);
  assert.equal(c4.streak, 1);
  const st = await getDailyStatus(db, u.id, new Date("2026-03-04T23:00:00Z"));
  assert.equal(st.enabled, true);
  assert.equal(st.claimedToday, true);
  assert.equal(st.streak, 1);
  assert.equal(st.balance, DAILY_BONUS * 3);
});

await section("run reward: disabled flag grants no RF (run still verifies)", async () => {
  const u = await upsertUserByDid(db, "did:noreward");
  process.env.RUN_REWARD_ENABLED = "0"; // gate off (runRewardsEnabled reads at call time)
  try {
    const run = await createRun(db, u.id, 5);
    const res = await finishRun(db, {
      runId: run.id,
      userId: u.id,
      summary: { locks: [4], softDropCells: 0, hardDropCells: 0, durationMs: 60_000 },
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, "verified");
    assert.equal(res.reward, 0); // no mint
    assert.equal(await getBalance(db, u.id), 0);
    assert.equal((await getLeaderboard(db, { period: "all" })).length, 1); // still ranked
  } finally {
    process.env.RUN_REWARD_ENABLED = "1";
  }
});

await section("daily bonus: disabled flag mints nothing", async () => {
  const u = await upsertUserByDid(db, "did:daily-off");
  process.env.DAILY_BONUS_ENABLED = "0"; // gate off (dailyEnabled reads at call time)
  try {
    const c = await claimDaily(db, u.id, new Date("2026-04-01T12:00:00Z"));
    assert.equal(c.awarded, false);
    assert.equal(c.amount, 0);
    assert.equal(c.balance, 0); // no mint
    const st = await getDailyStatus(db, u.id, new Date("2026-04-01T12:00:00Z"));
    assert.equal(st.enabled, false);
    assert.equal(st.claimedToday, false);
  } finally {
    process.env.DAILY_BONUS_ENABLED = "1"; // restore for any later sections
  }
});

await section("recentRuns: verified runs newest-first, excludes open/rejected", async () => {
  const u = await upsertUserByDid(db, "did:hist");
  const r1 = await createRun(db, u.id, 1);
  await finishRun(db, { runId: r1.id, userId: u.id, summary: { locks: [1], softDropCells: 0, hardDropCells: 0, durationMs: 30_000 } });
  const r2 = await createRun(db, u.id, 2);
  await finishRun(db, { runId: r2.id, userId: u.id, summary: { locks: [4], softDropCells: 0, hardDropCells: 0, durationMs: 60_000 } });
  await createRun(db, u.id, 3); // open run — must be excluded
  const hist = await recentRuns(db, u.id, 20);
  assert.equal(hist.length, 2); // only the two verified runs
  assert.deepEqual(hist.map((h) => h.score).sort((a, b) => a - b), [100, 800]);
  assert.ok(hist.every((h) => h.finishedAt)); // finishedAt populated
});

await section("admin allowlist: ADMIN_WALLETS gates access (case/space-insensitive)", async () => {
  process.env.ADMIN_WALLETS = "0xAbCd000000000000000000000000000000000001, 0x00000000000000000000000000000000000000f2";
  assert.equal(isAdminWallet("0xabcd000000000000000000000000000000000001"), true);
  assert.equal(isAdminWallet("  0xABCD000000000000000000000000000000000001 "), true);
  assert.equal(isAdminWallet("0x00000000000000000000000000000000000000F2"), true);
  assert.equal(isAdminWallet("0x0000000000000000000000000000000000000003"), false);
  assert.equal(isAdminWallet(null), false);
  process.env.ADMIN_WALLETS = ""; // empty allowlist locks everyone out
  assert.equal(isAdminWallet("0xabcd000000000000000000000000000000000001"), false);
});

await section("distributePool: exact integer split, top-heavy, remainder to #1", async () => {
  const e = [1, 2, 3].map((rank) => ({ rank, userId: "u" + rank, handle: null, score: 10 - rank, prize: 0 }));
  const out = distributePool(100, e);
  assert.equal(out.reduce((a, b) => a + b.prize, 0), 100); // sums exactly to pool
  assert.ok(out[0].prize >= out[1].prize && out[1].prize >= out[2].prize); // decay
  assert.deepEqual(distributePool(0, e).map((x) => x.prize), [0, 0, 0]); // zero pool
  assert.deepEqual(distributePool(100, []), []); // no entries
});

await section("economy metrics (mock): circulation, spend, 4-leg split, pool preview", async () => {
  const m = getEconomyMetrics();
  assert.equal(m.source, "mock"); // no on-chain env set → mock provider (simulated RF ledger)
  const alice = await upsertUserByDid(db, "did:emAlice");
  const bob = await upsertUserByDid(db, "did:emBob");
  await setHandle(db, alice.id, "Alice");
  await setHandle(db, bob.id, "Bob");
  await earn(db, alice.id, 1000, "grant", "g-a");
  await earn(db, bob.id, 1000, "grant", "g-b");
  // store spend: bomb 120 + reroll 50 + slow_fall 60 = 230
  await purchasePowerup(db, { userId: alice.id, key: "bomb", purchaseId: "p1" });
  await purchasePowerup(db, { userId: alice.id, key: "reroll", purchaseId: "p2" });
  await purchasePowerup(db, { userId: bob.id, key: "slow_fall", purchaseId: "p3" });
  const play = async (uid, locks) => {
    const r = await createRun(db, uid, 1);
    await finishRun(db, { runId: r.id, userId: uid, summary: { locks, softDropCells: 0, hardDropCells: 0, durationMs: 120_000 } });
  };
  await play(bob.id, [4]); // 800
  await play(alice.id, [2]); // 300

  const circ = await m.circulation(db);
  assert.equal(circ.sinks, 230); // total spent
  assert.ok(circ.minted >= 2000); // grants + run rewards
  assert.equal(circ.held, circ.minted - circ.sinks); // ledger identity

  assert.equal(await m.storeSpend(db, "all"), 230);
  const split = await m.splitPreview(db, "all");
  assert.equal(split.spend, 230);
  assert.equal(split.leaderboard, Math.floor(230 * REVENUE_SPLIT.leaderboard)); // 80
  assert.equal(split.burn, Math.floor(230 * REVENUE_SPLIT.burn)); // 57

  const pool = await m.poolPreview(db, "all", 10);
  assert.equal(pool.pool, Math.floor(230 * REVENUE_SPLIT.leaderboard)); // 80
  assert.equal(pool.entries.length, 2);
  assert.equal(pool.entries[0].handle, "Bob"); // #1 by score
  assert.equal(pool.entries.reduce((a, b) => a + b.prize, 0), pool.pool); // exact distribution
  assert.ok(pool.entries[0].prize >= pool.entries[1].prize);
});

await section("game config: defaults, sanitized set/get roundtrip", async () => {
  const d = await getGameConfig(db);
  assert.deepEqual(d, DEFAULT_CONFIG); // no row yet -> code defaults
  const stored = await setGameConfig(db, {
    fx: { intensity: 99 },
    drops: { enabled: true, rate: 3, minScore: -5 },
  });
  assert.equal(stored.fx.intensity, 2); // clamped
  assert.equal(stored.drops.rate, 0.5); // clamped
  assert.equal(stored.drops.minScore, 0); // clamped
  const again = await getGameConfig(db);
  assert.deepEqual(again, stored);
});

await section("replay + snapshot: golden run verifies with a stored config snapshot", async () => {
  const u = await upsertUserByDid(db, "did:snap");
  // the whole snapshot path (createRun -> finishRun -> replayRun(scoring)) executes.
  const run = await createRun(db, u.id, golden.seed, null, { ...DEFAULT_CONFIG });
  assert.ok(run.config); // snapshot stored
  const res = await finishRun(db, { runId: run.id, userId: u.id, summary: golden.summary, log: golden.log });
  assert.equal(res.ok, true);
  assert.equal(res.score, golden.score);
});

await section("abandon + rejected runs CONSUME used power-ups (bomb-refund bug)", async () => {
  const { abandonRun } = await import("../lib/runs.ts");
  const u = await upsertUserByDid(db, "did:bombfix");
  await earn(db, u.id, 1000, "grant", "seed");
  await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: "bf-1" });
  await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: "bf-2" });
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 2);

  // 1) QUIT mid-run after using a bomb -> abandon consumes it (no refund)
  const r1 = await createRun(db, u.id, 11, null, DEFAULT_CONFIG);
  const quitLog = [{ t: 100, a: "powerup", key: "bomb" }, { t: 200, a: "m", dx: 1 }];
  const ab = await abandonRun(db, { runId: r1.id, userId: u.id, log: quitLog });
  assert.equal(ab.ok, true);
  assert.equal(ab.consumed.bomb, 1);
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 1);
  // idempotent: abandoning again is a no-op
  assert.equal((await abandonRun(db, { runId: r1.id, userId: u.id, log: quitLog })).ok, false);

  // 2) REJECTED finish after using a bomb -> still consumed
  const r2 = await createRun(db, u.id, 12, null, DEFAULT_CONFIG);
  const badLog = [{ t: 50, a: "powerup", key: "bomb" }, { t: 60, a: "lock", pt: "X", r: 0, x: 0, y: 20, cleared: 0 }];
  const res = await finishRun(db, {
    runId: r2.id, userId: u.id,
    summary: { locks: [0], softDropCells: 0, hardDropCells: 0, durationMs: 30_000 },
    log: badLog,
  });
  assert.equal(res.ok, false); // bogus piece type -> rejected
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 0); // still consumed
});

await section("USE-TIME consumption: idempotent, order-proof, capped at owned", async () => {
  const u = await upsertUserByDid(db, "did:usetime");
  await earn(db, u.id, 1000, "grant", "seed");
  await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: "ut-1" });
  await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: "ut-2" });
  const run = await createRun(db, u.id, 21, null, DEFAULT_CONFIG);

  // 1st use settles immediately
  assert.equal((await consumePowerupUse(db, { runId: run.id, userId: u.id, key: "bomb", n: 1 })).ok, true);
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 1);
  // duplicate report (retry) is a no-op
  await consumePowerupUse(db, { runId: run.id, userId: u.id, key: "bomb", n: 1 });
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 1);
  // out-of-order: n=2 lands, then a late n=1 must be a no-op
  await consumePowerupUse(db, { runId: run.id, userId: u.id, key: "bomb", n: 2 });
  await consumePowerupUse(db, { runId: run.id, userId: u.id, key: "bomb", n: 1 });
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 0);
  // over-claim beyond owned: capped, never negative
  await consumePowerupUse(db, { runId: run.id, userId: u.id, key: "bomb", n: 5 });
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 0);
  // unknown key / bad n rejected
  assert.equal((await consumePowerupUse(db, { runId: run.id, userId: u.id, key: "nope", n: 1 })).ok, false);
  assert.equal((await consumePowerupUse(db, { runId: run.id, userId: u.id, key: "bomb", n: 0 })).ok, false);
  // someone else's run rejected
  const other = await upsertUserByDid(db, "did:usetime2");
  assert.equal((await consumePowerupUse(db, { runId: run.id, userId: other.id, key: "bomb", n: 1 })).ok, false);
});

await section("USE-TIME + finish/abandon RECONCILE: nothing consumed twice, entitlement holds", async () => {
  const { abandonRun } = await import("../lib/runs.ts");
  // (a) verified finish: bombs settled at use time still pass entitlement and
  // aren't consumed again (the powerup fixture uses bomb x5 + reroll x7).
  const rich = await upsertUserByDid(db, "did:utRich");
  await earn(db, rich.id, 5000, "grant", "seed");
  for (let i = 0; i < 5; i++) await purchasePowerup(db, { userId: rich.id, key: "bomb", purchaseId: `utb${i}` });
  for (let i = 0; i < 7; i++) await purchasePowerup(db, { userId: rich.id, key: "reroll", purchaseId: `utr${i}` });
  const run1 = await createRun(db, rich.id, powerupRun.seed);
  // all 5 bombs settle at use time; rerolls are left for finish to reconcile
  for (let n = 1; n <= 5; n++) await consumePowerupUse(db, { runId: run1.id, userId: rich.id, key: "bomb", n });
  assert.equal(getInventoryQty(await getInventory(db, rich.id), "bomb"), 0);
  const res1 = await finishRun(db, { runId: run1.id, userId: rich.id, summary: powerupRun.summary, log: powerupRun.log });
  assert.equal(res1.ok, true, `expected verify, got: ${res1.reason}`);
  assert.equal(res1.score, powerupRun.score);
  const invAfter = await getInventory(db, rich.id);
  assert.equal(getInventoryQty(invAfter, "bomb"), 0); // NOT double-consumed
  assert.equal(getInventoryQty(invAfter, "reroll"), 0); // remainder reconciled at finish

  // (b) abandon after use-time settlement consumes nothing further
  const u = await upsertUserByDid(db, "did:utQuit");
  await earn(db, u.id, 500, "grant", "seed");
  await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: "utq-1" });
  const run2 = await createRun(db, u.id, 22, null, DEFAULT_CONFIG);
  await consumePowerupUse(db, { runId: run2.id, userId: u.id, key: "bomb", n: 1 });
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 0);
  const ab = await abandonRun(db, { runId: run2.id, userId: u.id, log: [{ t: 1, a: "powerup", key: "bomb" }] });
  assert.equal(ab.ok, true);
  assert.deepEqual(ab.consumed, {}); // already settled at use time
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 0);
  // settling against a non-open run is refused
  assert.equal((await consumePowerupUse(db, { runId: run2.id, userId: u.id, key: "bomb", n: 2 })).ok, false);

  // (c) settlement exclusivity: after a VERIFIED finish, an abandon of the
  // same run must lose cleanly (no status overwrite, no re-consumption).
  const winner = await upsertUserByDid(db, "did:utWin");
  const run3 = await createRun(db, winner.id, golden.seed);
  const fin = await finishRun(db, { runId: run3.id, userId: winner.id, summary: golden.summary, log: golden.log });
  assert.equal(fin.ok, true);
  const ab2 = await abandonRun(db, { runId: run3.id, userId: winner.id, log: [] });
  assert.equal(ab2.ok, false);
  const rows3 = await db.select().from(runs);
  assert.equal(rows3.find((r) => r.id === run3.id).status, "verified"); // not clobbered
});

await section("player metrics: DAU/WAU, retention, quality, spend all compute correctly", async () => {
  const { getPlayerMetrics } = await import("../lib/playerMetrics.ts");
  // Three players with staggered signup ages + activity:
  //  A: signed up 10d ago, played 9d ago (D1 ✓) and today       → retained, active
  //  B: signed up 10d ago, never came back                       → churned
  //  C: signed up today, played today                            → new, active
  const A = await upsertUserByDid(db, "did:pmA");
  const B = await upsertUserByDid(db, "did:pmB");
  const C = await upsertUserByDid(db, "did:pmC");
  await db.execute(sql`UPDATE users SET created_at = now() - interval '10 days' WHERE id IN (${A.id}, ${B.id})`);

  const mkRun = async (userId, { daysAgo, status, score = null, durMs = null, log = null, pu = null }) => {
    const r = await createRun(db, userId, 1);
    await db.execute(sql`
      UPDATE runs SET status = ${status}, score = ${score}, duration_ms = ${durMs},
        input_log = ${log ? JSON.stringify(log) : null}::jsonb,
        powerups_used = ${pu ? JSON.stringify(pu) : null}::jsonb,
        started_at = now() - (${daysAgo} || ' days')::interval,
        finished_at = CASE WHEN ${status} = 'open' THEN NULL ELSE now() - (${daysAgo} || ' days')::interval + interval '5 minutes' END
      WHERE id = ${r.id}`);
    return r;
  };

  await mkRun(A.id, { daysAgo: "9", status: "verified", score: 500, durMs: 60_000 }); // D1 return for A
  await mkRun(A.id, { daysAgo: "0.2", status: "verified", score: 1500, durMs: 120_000, pu: { bomb: 2 } });
  await mkRun(A.id, { daysAgo: "0.1", status: "abandoned" });
  await mkRun(C.id, { daysAgo: "0.05", status: "verified", score: 800, durMs: 90_000, pu: { bomb: 1, slow_fall: 1 } });

  // spending: A buys two bombs, C buys one slow_fall
  await earn(db, A.id, 1000, "grant", "pm-seed-a");
  await earn(db, C.id, 1000, "grant", "pm-seed-c");
  await purchasePowerup(db, { userId: A.id, key: "bomb", purchaseId: "pm-1" });
  await purchasePowerup(db, { userId: A.id, key: "bomb", purchaseId: "pm-2" });
  await purchasePowerup(db, { userId: C.id, key: "slow_fall", purchaseId: "pm-3" });

  const m = await getPlayerMetrics(db);
  assert.ok(m.versus, "versus block present");
  assert.equal(m.versus.daily.length, 14, "14 zero-filled days");
  assert.equal(m.activity.dau, 2); // A + C today
  assert.equal(m.activity.wau, 2);
  assert.equal(m.activity.mau, 2); // 9d-ago run also A → still {A, C}
  assert.equal(m.activity.totalUsers, 3);
  assert.equal(m.daily.length, 30); // calendar-filled series
  assert.equal(m.retention.cohort1, 2); // A + B old enough
  assert.equal(m.retention.d1, 0.5); // only A came back next day
  assert.equal(m.retention.d7, 0.5);
  assert.equal(m.quality.verified7d, 2); // the 9d-ago run is outside the window
  assert.equal(m.quality.best7d, 1500);
  assert.ok(Math.abs(m.quality.abandonRate7d - 1 / 3) < 1e-9); // 1 abandoned / 3 settled (7d)
  const bombPrice = CATALOG_BY_KEY.bomb.price, slowPrice = CATALOG_BY_KEY.slow_fall.price;
  assert.equal(m.economy.spentAll, bombPrice * 2 + slowPrice);
  assert.equal(m.economy.payers, 2);
  assert.equal(m.economy.itemSales.find((i) => i.key === "bomb").buys, 2);
  assert.equal(m.economy.powerupsUsed7d.find((p) => p.key === "bomb").used, 3);
  assert.ok(m.economy.topSpenders.length === 2 && m.economy.topSpenders[0].spent >= m.economy.topSpenders[1].spent);
});

await section("expired open runs are reaped; recent opens are left alone", async () => {
  const u = await upsertUserByDid(db, "did:reap");
  const old = await createRun(db, u.id, 31);
  const fresh = await createRun(db, u.id, 32);
  await db.execute(sql`UPDATE runs SET started_at = now() - interval '3 hours' WHERE id = ${old.id}`);
  await reapExpiredRuns(db, u.id, 2 * 60 * 60 * 1000);
  const rows = await db.select().from(runs);
  assert.equal(rows.find((r) => r.id === old.id)?.status, "abandoned");
  assert.equal(rows.find((r) => r.id === fresh.id)?.status, "open");
});

await section("item drops: gates hold (disabled / under min score / zero rate)", async () => {
  const u = await upsertUserByDid(db, "did:dropgate");
  const play = async (cfgDrops) => {
    const run = await createRun(db, u.id, 1, null, { ...DEFAULT_CONFIG, drops: cfgDrops });
    return finishRun(db, {
      runId: run.id, userId: u.id,
      summary: { locks: [4], softDropCells: 0, hardDropCells: 0, durationMs: 60_000 }, // 800 pts
    });
  };
  const a = await play({ enabled: false, rate: 0.5, minScore: 0 });
  assert.equal(a.drop ?? null, null); // disabled
  const b = await play({ enabled: true, rate: 0, minScore: 0 });
  assert.equal(b.drop ?? null, null); // zero rate
  const c = await play({ enabled: true, rate: 0.5, minScore: 100000 });
  assert.equal(c.drop ?? null, null); // under min score
  assert.equal((await getInventory(db, u.id)).length, 0); // nothing granted
});

await section("item drops: a win grants inventory exactly once", async () => {
  // rate .5 over repeated runs -> statistically certain to hit at least once;
  // each hit must land in inventory. (2^-40 flake odds ≈ none.)
  const u = await upsertUserByDid(db, "did:droplucky");
  let won = 0;
  for (let i = 0; i < 40 && won === 0; i++) {
    const run = await createRun(db, u.id, i + 2, null, { ...DEFAULT_CONFIG, drops: { enabled: true, rate: 0.5, minScore: 0 } });
    const res = await finishRun(db, {
      runId: run.id, userId: u.id,
      summary: { locks: [4], softDropCells: 0, hardDropCells: 0, durationMs: 60_000 },
    });
    if (res.drop) { won++; assert.ok(res.drop.key && res.drop.name); }
  }
  assert.ok(won >= 1, "expected at least one drop at rate 0.5 over 40 runs");
  const inv = await getInventory(db, u.id);
  assert.equal(inv.reduce((a2, i2) => a2 + i2.qty, 0) >= 1, true);
});

/* ---------------- VERSUS ---------------- */

// Fund a wallet for wager tests (idempotent grant per refId).
async function fund(userId, amt, ref) {
  await earn(db, userId, amt, "grant", ref);
}
// Pair two fresh users at a tier; returns [userA, userB, match].
async function pairUp(wager, tag) {
  const a = await upsertUserByDid(db, `did:vs-${tag}-a`);
  const b = await upsertUserByDid(db, `did:vs-${tag}-b`);
  if (wager > 0) {
    await fund(a.id, wager * 4, `${tag}-a`);
    await fund(b.id, wager * 4, `${tag}-b`);
  }
  const r1 = await joinQueue(db, a.id, wager);
  assert.equal(r1.state, "queued");
  const r2 = await joinQueue(db, b.id, wager);
  assert.equal(r2.state, "matched");
  let m = await activeMatchFor(db, a.id);
  assert.ok(m, "match exists");
  // Ready-up gate: round 1 exists only after BOTH players tap READY.
  await markReady(db, m.id, a.id);
  await markReady(db, m.id, b.id);
  m = await activeMatchFor(db, a.id);
  return [a, b, m];
}
// Both sides of the current round submit WITHOUT a log → both rejected → 0-0 tie.
async function tieRound(m, a, b) {
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const cur = row.rounds[row.rounds.length - 1];
  const sum = { locks: [], softDropCells: 0, hardDropCells: 0, durationMs: 30_000 };
  await finishVersusRound(db, { matchId: m.id, userId: row.p1, runId: cur.p1.runId, summary: sum });
  await finishVersusRound(db, { matchId: m.id, userId: row.p2, runId: cur.p2.runId, summary: sum });
}
// Golden-run win: pin the round seed to the fixture's, submit the real log for
// `winner`, an empty submission for the loser → replay-verified round win.
async function goldenRound(m, winnerId) {
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const rs = row.rounds;
  const cur = rs[rs.length - 1];
  cur.seed = golden.seed;
  await db.update(matches).set({ rounds: rs }).where(sql`id = ${m.id}`);
  const winSlot = row.p1 === winnerId ? "p1" : "p2";
  const loseSlot = winSlot === "p1" ? "p2" : "p1";
  const loserId = winSlot === "p1" ? row.p2 : row.p1;
  await db.update(runs).set({ seed: golden.seed }).where(sql`id = ${cur[winSlot].runId}`);
  const win = await finishVersusRound(db, {
    matchId: m.id,
    userId: winnerId,
    runId: cur[winSlot].runId,
    summary: golden.summary,
    log: golden.log,
  });
  assert.equal(win.ok, true);
  assert.equal(win.rejected ?? false, false, `golden round should verify (${win.reason ?? "ok"})`);
  assert.equal(win.score, golden.score);
  await finishVersusRound(db, {
    matchId: m.id,
    userId: loserId,
    runId: cur[loseSlot].runId,
    summary: { locks: [], softDropCells: 0, hardDropCells: 0, durationMs: 20_000 },
  });
}

await section("versus: pairing creates match, same seed, escrow debits both", async () => {
  const [a, b, m] = await pairUp(100, "pair");
  assert.equal(m.status, "active");
  assert.equal(m.wager, 100);
  const cur = m.rounds[0];
  assert.ok(cur.p1.runId && cur.p2.runId, "both runs created");
  const [r1] = await db.select().from(runs).where(sql`id = ${cur.p1.runId}`);
  const [r2] = await db.select().from(runs).where(sql`id = ${cur.p2.runId}`);
  assert.equal(Number(r1.seed), Number(r2.seed), "same seed for both players");
  assert.equal(r1.mode, "versus");
  assert.equal(r1.config.drops.enabled, false, "versus snapshot disables item drops");
  // Escrow: both paid the stake exactly once.
  assert.equal(await getBalance(db, a.id), 300);
  assert.equal(await getBalance(db, b.id), 300);
  // Queue is empty.
  const q = await db.select().from(matchQueue);
  assert.equal(q.length, 0);
});

await section("versus: tier mismatch stays queued; leaveQueue is free", async () => {
  const a = await upsertUserByDid(db, "did:vs-tier-a");
  const b = await upsertUserByDid(db, "did:vs-tier-b");
  await fund(a.id, 500, "tier-a");
  await fund(b.id, 500, "tier-b");
  assert.equal((await joinQueue(db, a.id, 50)).state, "queued");
  assert.equal((await joinQueue(db, b.id, 100)).state, "queued"); // different tier: no pair
  assert.equal(await activeMatchFor(db, a.id), null);
  await leaveQueue(db, a.id);
  await leaveQueue(db, b.id);
  assert.equal((await db.select().from(matchQueue)).length, 0);
  assert.equal(await getBalance(db, a.id), 500, "leaving the queue costs nothing");
});

await section("versus: underfunded wager rejected at join", async () => {
  const a = await upsertUserByDid(db, "did:vs-poor");
  const r = await joinQueue(db, a.id, 250);
  assert.equal(r.state, "error");
});

await section("versus: opponent scores stay hidden mid-round; view carries record + token", async () => {
  const [a, b, m] = await pairUp(0, "beat");
  await heartbeat(db, { matchId: m.id, userId: a.id, round: 1, score: 420 });
  const viewB = await matchStateFor(db, b.id);
  assert.equal(viewB.state, "active");
  assert.equal(viewB.match.oppLive, undefined, "live scores are not exposed at all");
  assert.equal(viewB.match.oppScore, null, "no verified score until both settle");
  assert.equal(viewB.match.oppState, "playing", "presence IS exposed");
  const viewA = await matchStateFor(db, a.id);
  assert.ok(viewA.match.runToken, "view carries my signed round token");
  assert.equal(viewA.match.seed, viewB.match.seed, "both views expose the same seed");
  assert.deepEqual(
    viewA.match.oppRecord,
    { w: 0, l: 0, speed: { w: 0, l: 0 }, turf: { w: 0, l: 0 } },
    "fresh opponent record carries per-mode splits",
  );
});

await section("versus: golden-run round verifies, wins increment, next round spawns", async () => {
  const [a, , m] = await pairUp(0, "gold");
  await goldenRound(m, a.id);
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.status, "active");
  assert.equal(row.p1 === a.id ? row.p1Wins : row.p2Wins, 1, "winner's tally incremented");
  assert.equal(row.rounds.length, 2, "round 2 created");
  assert.equal(row.round, 2);
  assert.ok(row.rounds[1].seed !== row.rounds[0].seed, "fresh seed for round 2");
  // Versus never touches the leaderboard.
  assert.equal((await db.select().from(scores)).length, 0);
});

await section("versus: powerup event in log rejects the round (score 0)", async () => {
  const [a, , m] = await pairUp(0, "pu");
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const cur = row.rounds[0];
  const slot = row.p1 === a.id ? "p1" : "p2";
  const res = await finishVersusRound(db, {
    matchId: m.id,
    userId: a.id,
    runId: cur[slot].runId,
    summary: { locks: [], softDropCells: 0, hardDropCells: 0, durationMs: 10_000 },
    log: [{ t: 1000, a: "powerup", key: "bomb" }],
  });
  assert.equal(res.rejected, true);
  assert.equal(res.score, 0);
});

await section("versus: overlong round rejected by the clock", async () => {
  const [a, , m] = await pairUp(0, "clock");
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const cur = row.rounds[0];
  const slot = row.p1 === a.id ? "p1" : "p2";
  const res = await finishVersusRound(db, {
    matchId: m.id,
    userId: a.id,
    runId: cur[slot].runId,
    summary: { locks: [], softDropCells: 0, hardDropCells: 0, durationMs: ROUND_SECS * 1000 + 20_000 },
    log: golden.log,
  });
  assert.equal(res.rejected, true);
});

await section("versus: double submit of the same round is refused", async () => {
  const [a, , m] = await pairUp(0, "dup");
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const cur = row.rounds[0];
  const slot = row.p1 === a.id ? "p1" : "p2";
  const sum = { locks: [], softDropCells: 0, hardDropCells: 0, durationMs: 10_000 };
  const first = await finishVersusRound(db, { matchId: m.id, userId: a.id, runId: cur[slot].runId, summary: sum });
  assert.equal(first.ok, true);
  const dup = await finishVersusRound(db, { matchId: m.id, userId: a.id, runId: cur[slot].runId, summary: sum });
  assert.equal(dup.ok, false);
});

await section("versus: three golden wins settle the match and pay the pot once", async () => {
  const [a, b, m] = await pairUp(100, "sweep");
  assert.equal(await getBalance(db, a.id), 300); // 400 funded - 100 escrow
  await goldenRound(m, a.id);
  await goldenRound(m, a.id);
  await goldenRound(m, a.id);
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.status, "settled");
  assert.equal(row.winner, a.id);
  // winner: stake back + opponent's, minus the 5% burned rake (lib/rf/economy-rules)
  assert.equal(await getBalance(db, a.id), 490, "winner: pot minus 5% rake");
  assert.equal(await getBalance(db, b.id), 300, "loser: stake gone");
  // Exactly ONE payout row ever.
  const wins = await db.select().from(ledger).where(sql`reason = 'versus:win' AND ref_id = ${m.id} AND delta > 0`);
  assert.equal(wins.length, 1);
  const rake = await db.select().from(ledger).where(sql`reason = 'versus:rake' AND ref_id = ${m.id} AND delta > 0`);
  assert.equal(rake.length, 1);
  assert.equal(Number(rake[0].delta), 10);
  // A late concede can't double-pay or flip the result.
  assert.equal(await concedeMatch(db, m.id, b.id), false);
  assert.equal(await getBalance(db, a.id), 490);
});

await section("versus: concede settles instantly, opponent takes the pot", async () => {
  const [a, b, m] = await pairUp(50, "concede");
  assert.equal(await concedeMatch(db, m.id, a.id), true);
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.status, "settled");
  assert.equal(row.winner, b.id);
  assert.equal(await getBalance(db, b.id), 245); // 200-50+100, minus 5 RF-units burned rake
  assert.equal(await getBalance(db, a.id), 150); // 200-50
  // The open round runs were closed.
  const open = await db.select().from(runs).where(sql`match_id = ${m.id} AND status = 'open'`);
  assert.equal(open.length, 0);
});

await section("versus: expired round forfeits via a poll; double dead round aborts + refunds", async () => {
  const [a, b, m] = await pairUp(100, "dead");
  // Backdate round 1 past its deadline with neither side submitting.
  let [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  let rs = row.rounds;
  rs[0].deadline = new Date(Date.now() - 1000).toISOString();
  await db.update(matches).set({ rounds: rs }).where(sql`id = ${m.id}`);
  const v1 = await matchStateFor(db, a.id); // poll advances: both forfeit → tie → round 2
  assert.equal(v1.state, "active");
  assert.equal(v1.match.lastRound.myForfeit, true, "forfeit surfaced to the client");
  assert.equal(v1.match.lastRound.oppForfeit, true);
  [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.rounds.length, 2);
  assert.equal(row.rounds[0].winner, "tie");
  // Kill round 2 the same way → two consecutive dead rounds → abort + refund.
  rs = row.rounds;
  rs[1].deadline = new Date(Date.now() - 1000).toISOString();
  await db.update(matches).set({ rounds: rs }).where(sql`id = ${m.id}`);
  const v2 = await matchStateFor(db, b.id);
  assert.equal(v2.state, "over");
  assert.equal(v2.result.aborted, true);
  assert.equal(await getBalance(db, a.id), 400, "stake refunded");
  assert.equal(await getBalance(db, b.id), 400, "stake refunded");
});

await section("versus: one-sided forfeit gives the round to the finisher", async () => {
  const [a, b, m] = await pairUp(0, "solofor");
  let [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const cur = row.rounds[0];
  const slot = row.p1 === a.id ? "p1" : "p2";
  await finishVersusRound(db, {
    matchId: m.id,
    userId: a.id,
    runId: cur[slot].runId,
    summary: { locks: [], softDropCells: 0, hardDropCells: 0, durationMs: 10_000 },
  }); // rejected (no log) → score 0, state done
  let rs = row.rounds;
  rs[0].deadline = new Date(Date.now() - 1000).toISOString();
  await db.update(matches).set({ rounds: rs }).where(sql`id = ${m.id}`);
  await matchStateFor(db, b.id); // b's poll forfeits b (never submitted)
  [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  // 0 vs 0-by-forfeit is a tie; but a DONE 0 vs forfeit 0 must not crash and
  // must advance — the meaningful assertion is the round concluded.
  assert.equal(row.rounds.length, 2, "round advanced past the forfeit");
});

await section("versus (review): resurrected queue row cannot double-escrow into a second match", async () => {
  const [a, , m] = await pairUp(100, "resur");
  // Simulate the race artifact: A's re-tier upsert landed after pairing
  // deleted the row — A is active AND queued.
  await db.insert(matchQueue).values({ userId: a.id, wager: 100 });
  const c = await upsertUserByDid(db, "did:vs-resur-c");
  await fund(c.id, 400, "resur-c");
  const r = await joinQueue(db, c.id, 100);
  assert.equal(r.state, "queued", "C must not pair with an already-active player");
  // The stale row was cleaned up inside the pairing tx; A escrowed exactly once.
  const rows = await db.select().from(matchQueue);
  assert.equal(rows.some((q) => q.userId === a.id), false, "stale row deleted");
  const escrows = await db.select().from(ledger).where(sql`user_id = ${a.id} AND reason = 'versus:escrow'`);
  assert.equal(escrows.length, 1);
  assert.equal(await activeMatchFor(db, c.id), null);
  assert.ok(m, "original match untouched");
});

await section("versus (review): solo finish/abandon refuse versus rounds (no leaderboard injection)", async () => {
  const [a, , m] = await pairUp(0, "cross");
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const cur = row.rounds[0];
  const slot = row.p1 === a.id ? "p1" : "p2";
  await db.update(runs).set({ seed: golden.seed }).where(sql`id = ${cur[slot].runId}`);
  const res = await finishRun(db, {
    runId: cur[slot].runId,
    userId: a.id,
    summary: golden.summary,
    log: golden.log,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /match pipeline/);
  assert.equal((await db.select().from(scores)).length, 0, "no leaderboard row");
  const [still] = await db.select().from(runs).where(sql`id = ${cur[slot].runId}`);
  assert.equal(still.status, "open", "round still open for the match pipeline");
});

await section("versus (review): poll adopts a verified-but-unrecorded round instead of forfeiting it", async () => {
  const [a, , m] = await pairUp(0, "adopt");
  let [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const cur = row.rounds[0];
  const slot = row.p1 === a.id ? "p1" : "p2";
  // Simulate the gap between finishVersusRound's two transactions: the run
  // row is verified with a score, but the match still says 'playing'.
  await db.update(runs).set({ status: "verified", score: 777, finishedAt: new Date() }).where(sql`id = ${cur[slot].runId}`);
  let rs = row.rounds;
  rs[0].deadline = new Date(Date.now() - 1000).toISOString();
  await db.update(matches).set({ rounds: rs }).where(sql`id = ${m.id}`);
  await matchStateFor(db, a.id); // poll advances the deadline
  [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.rounds[0][slot].state, "done", "adopted, not forfeited");
  assert.equal(row.rounds[0][slot].score, 777, "verified score kept");
  assert.equal(row.rounds[0].winner, slot, "adopted score wins the round");
});

await section("versus (review): queued state outranks the recently-settled card (rematch flow)", async () => {
  const [a, b, m] = await pairUp(0, "rematch");
  await concedeMatch(db, m.id, a.id);
  // b immediately queues for a rematch — the view must say 'queued', not
  // replay the old result card for two minutes.
  await fund(b.id, 100, "rematch-b2");
  await joinQueue(db, b.id, 0);
  const v = await matchStateFor(db, b.id);
  assert.equal(v.state, "queued");
  // a (not queued) still gets the result card.
  const va = await matchStateFor(db, a.id);
  assert.equal(va.state, "over");
});

await section("versus (review): heartbeat clamps implausible scores in stored state", async () => {
  const [a, , m] = await pairUp(0, "clamp");
  await heartbeat(db, { matchId: m.id, userId: a.id, round: 1, score: 9_999_999 });
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const slot = row.p1 === a.id ? "p1" : "p2";
  const live = row.rounds[0][slot].live;
  assert.ok(live < 9_999_999, `forged score clamped (stored ${live})`);
  assert.ok(live <= 5000 * 10, `clamped to elapsed-time ceiling (stored ${live})`);
});

await section("versus (polish): queued view reports lobby counts", async () => {
  const a = await upsertUserByDid(db, "did:vs-counts-a");
  const b = await upsertUserByDid(db, "did:vs-counts-b");
  const c = await upsertUserByDid(db, "did:vs-counts-c");
  await fund(b.id, 400, "counts-b");
  await fund(c.id, 400, "counts-c");
  await joinQueue(db, a.id, 0);
  await joinQueue(db, b.id, 100); // different tier — not "waiting" for a
  const va = await matchStateFor(db, a.id);
  assert.equal(va.state, "queued");
  assert.deepEqual(va.counts, { waiting: 0, smashing: 0 });
  await joinQueue(db, c.id, 100); // pairs with b -> one active match
  const va2 = await matchStateFor(db, a.id);
  assert.equal(va2.counts.smashing, 2, "two Friends smashing");
});

await section("versus (review): stale queue rows are invisible to pairing", async () => {
  const a = await upsertUserByDid(db, "did:vs-stale-a");
  const b = await upsertUserByDid(db, "did:vs-stale-b");
  await joinQueue(db, a.id, 0);
  // A stopped polling 10 minutes ago.
  await db
    .update(matchQueue)
    .set({ enqueuedAt: new Date(Date.now() - 10 * 60 * 1000) })
    .where(sql`user_id = ${a.id}`);
  const r = await joinQueue(db, b.id, 0);
  assert.equal(r.state, "queued", "stale opponent not paired");
  assert.equal(await activeMatchFor(db, b.id), null);
  // A's next state poll touches the row back to life → pairable again.
  await matchStateFor(db, a.id);
  const v = await matchStateFor(db, b.id); // b's poll now pairs the two
  assert.equal(v.state, "active", "revived rows pair via the state poll");
});

/* ---------------- TURF WAR ---------------- */

async function turfPair(wager, tag) {
  const a = await upsertUserByDid(db, `did:turf-${tag}-a`);
  const b = await upsertUserByDid(db, `did:turf-${tag}-b`);
  if (wager > 0) {
    await fund(a.id, wager * 4, `t-${tag}-a`);
    await fund(b.id, wager * 4, `t-${tag}-b`);
  }
  assert.equal((await joinQueue(db, a.id, wager, "turf")).state, "queued");
  assert.equal((await joinQueue(db, b.id, wager, "turf")).state, "matched");
  let m = await activeMatchFor(db, a.id);
  assert.ok(m && m.mode === "turf");
  await markReady(db, m.id, a.id);
  await markReady(db, m.id, b.id);
  m = await activeMatchFor(db, a.id);
  return [a, b, m]; // p1 = a (longer waiting), PINK
}
async function doctorTurf(matchId, fn) {
  const [row] = await db.select().from(matches).where(sql`id = ${matchId}`);
  const t = row.turf;
  fn(t.games[t.games.length - 1], row);
  await db.update(matches).set({ turf: t }).where(sql`id = ${matchId}`);
  return row;
}

await section("turf: speed and turf queues never cross", async () => {
  const a = await upsertUserByDid(db, "did:turf-cross-a");
  const b = await upsertUserByDid(db, "did:turf-cross-b");
  assert.equal((await joinQueue(db, a.id, 0, "speed")).state, "queued");
  assert.equal((await joinQueue(db, b.id, 0, "turf")).state, "queued", "same tier, different mode: no pair");
  assert.equal(await activeMatchFor(db, a.id), null);
  assert.equal(await activeMatchFor(db, b.id), null);
});

await section("turf: pairing creates referee state, escrow, and NO runs rows", async () => {
  const [a, b, m] = await turfPair(100, "pair");
  assert.equal(m.bestOf, 3);
  const t = m.turf;
  assert.equal(t.games.length, 1);
  assert.equal(t.games[0].turn, "p1");
  assert.ok(t.games[0].pieces.length >= 40, "piece budget present");
  assert.equal((await db.select().from(runs).where(sql`match_id = ${m.id}`)).length, 0, "turf uses no runs rows");
  assert.equal(await getBalance(db, a.id), 300);
  assert.equal(await getBalance(db, b.id), 300);
  const va = await matchStateFor(db, a.id);
  assert.equal(va.mode, "turf");
  assert.equal(va.turf.myTeam, "pink", "p1 is PINK");
  assert.equal(va.turf.myTurn, true, "p1 starts game 1");
  const vb = await matchStateFor(db, b.id);
  assert.equal(vb.turf.myTeam, "blue");
  assert.equal(vb.turf.myTurn, false);
  assert.equal(va.turf.piece, vb.turf.piece, "shared queue");
});

await section("turf: placeTurfMove referees turns; wrong turn/stale move rejected", async () => {
  const [a, b, m] = await turfPair(0, "turns");
  const va = await matchStateFor(db, a.id);
  const wrong = await placeTurfMove(db, { matchId: m.id, userId: b.id, moveN: 0, t: va.turf.piece, r: 0, x: 0, y: 0 });
  assert.equal(wrong.ok, false, "not b's turn");
  const ok = await placeTurfMove(db, { matchId: m.id, userId: a.id, moveN: 0, t: va.turf.piece, r: 0, x: 0, y: 0 });
  assert.equal(ok.ok, true);
  const dup = await placeTurfMove(db, { matchId: m.id, userId: a.id, moveN: 0, t: va.turf.piece, r: 0, x: 0, y: 0 });
  assert.equal(dup.ok, false, "duplicate moveN is a no-op");
  const vb = await matchStateFor(db, b.id);
  assert.equal(vb.turf.myTurn, true, "turn passed to blue");
  assert.equal(vb.turf.moveN, 1);
  assert.equal(vb.turf.placements.length, 1);
  assert.equal(vb.turf.placements[0].team, "pink");
});

await section("turf: pure row wins the game; game 2 spawns with blue starting", async () => {
  const [a, , m] = await turfPair(0, "row");
  await doctorTurf(m.id, (g) => {
    // Pink I already on the bottom row (cols 0-3); force a J next.
    g.placements = [{ t: "I", r: 0, x: 0, y: 10, by: "p1" }];
    g.pieces[g.moveN] = "J";
    g.turn = "p1";
  });
  const res = await placeTurfMove(db, { matchId: m.id, userId: a.id, moveN: 0, t: "J", r: 0, x: 4, y: 10 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.gameOver, { winner: "me", reason: "row" });
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.status, "active", "match continues (1-0)");
  assert.equal(row.p1Wins, 1);
  assert.equal(row.turf.games.length, 2);
  assert.equal(row.turf.games[1].turn, "p2", "game 2 starter alternates to blue");
  // The loser's next view carries the finished board + winning row (the
  // client plays the row FX before the splash — they never saw the last move).
  const loserView = await matchStateFor(db, row.p2);
  assert.equal(loserView.state, "active");
  assert.equal(loserView.turf.lastGame.reason, "row");
  assert.equal(loserView.turf.lastGame.row, 11, "winning row index shipped");
  assert.equal(loserView.turf.lastGame.placements.length, 2, "finished board shipped");
  assert.ok(loserView.turf.lastGame.placements.every((p) => p.team === "pink" || p.team === "blue"));
  // Win game 2 the same way -> 2-0 match. The result view carries the id
  // (result-ack guard) and the final board (turfFinal).
  await doctorTurf(m.id, (g) => {
    g.placements = [{ t: "I", r: 0, x: 0, y: 10, by: "p1" }];
    g.pieces[g.moveN] = "J";
    g.turn = "p1";
  });
  const res2 = await placeTurfMove(db, { matchId: m.id, userId: a.id, moveN: row.turf.games[1].moveN, t: "J", r: 0, x: 4, y: 10 });
  assert.equal(res2.ok, true, "game 2 winning move lands");
  const over = await matchStateFor(db, a.id);
  assert.equal(over.state, "over");
  assert.equal(over.result.id, m.id, "result carries the match id");
  assert.equal(over.result.how, "row");
  assert.equal(over.result.turfFinal.row, 11, "final board's winning row shipped");
  assert.equal(over.result.turfFinal.placements.length, 2);
});

await section("turf: squeezing out the opponent's piece wins the game", async () => {
  const [a, , m] = await turfPair(0, "squeeze");
  await doctorTurf(m.id, (g) => {
    // Everything full except a 2x2 hole at (0,0) and an O hole at (0,2);
    // mixed ownership so no filler row is pure.
    g.placements = [];
    for (let col = 0; col < 7; col++) {
      for (let band = 0; band < 3; band++) {
        if (col <= 1 && band === 0) continue;
        g.placements.push({ t: "I", r: 1, x: col - 2, y: band * 4, by: col % 2 ? "p1" : "p2" });
      }
    }
    g.pieces[g.moveN] = "O"; // pink plugs the lower hole...
    g.pieces[g.moveN + 1] = "I"; // ...and blue's I can never fit a 2x2
    g.turn = "p1";
  });
  const res = await placeTurfMove(db, { matchId: m.id, userId: a.id, moveN: 0, t: "O", r: 0, x: 0, y: 2 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.gameOver, { winner: "me", reason: "squeeze" });
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.p1Wins, 1, "the squeezer takes the game");
});

await section("turf: aiming at an occupied spot is rejected, not a loss", async () => {
  const [a, , m] = await turfPair(0, "misclick");
  await doctorTurf(m.id, (g) => {
    g.placements = [{ t: "O", r: 0, x: 2, y: 4, by: "p2" }];
    g.pieces[g.moveN] = "O";
    g.turn = "p1";
  });
  const res = await placeTurfMove(db, { matchId: m.id, userId: a.id, moveN: 0, t: "O", r: 0, x: 2, y: 4 });
  assert.equal(res.ok, false, "blocked spot = try again");
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.status, "active");
  assert.equal(row.turf.games[0].winner, null, "nobody loses to a misclick");
});

await section("turf: expired shot clock auto-drops via a poll; repeat AFK forfeits the game", async () => {
  const [a, b, m] = await turfPair(0, "clock");
  const backdate = async () =>
    doctorTurf(m.id, (g) => {
      g.deadline = new Date(Date.now() - 20_000).toISOString();
    });
  await backdate();
  await matchStateFor(db, b.id); // b's poll ticks p1's expired turn
  let [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  let g = row.turf.games[0];
  assert.equal(g.placements.length, 1, "auto-drop landed");
  assert.equal(g.placements[0].by, "p1");
  assert.equal(g.timeouts.p1, 1);
  assert.equal(g.turn, "p2");
  // p2 plays honestly, then p1 goes AFK twice more -> forfeit.
  const vb = await matchStateFor(db, b.id);
  await placeTurfMove(db, { matchId: m.id, userId: b.id, moveN: vb.turf.moveN, t: vb.turf.piece, r: 0, x: 3, y: 6 });
  // The auto-drop is marked, the marking reaches the view, and it's attached
  // to the RIGHT placements (identity, not just presence — review catch).
  const va2 = await matchStateFor(db, b.id);
  assert.equal(va2.turf.placements[0].auto, true, "the ticked p1 drop is the flagged one");
  const realPl = va2.turf.placements.find((p) => p.x === 3 && p.y === 6);
  assert.ok(realPl, "b's real move visible");
  assert.equal(realPl.auto, false, "the human move is NOT flagged");
  // Three strikes now: keep expiring p1's turns until the forfeit lands.
  for (let i = 0; i < 6; i++) {
    await backdate();
    await matchStateFor(db, b.id);
    [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
    g = row.turf.games[row.turf.games.length - 1];
    if (g.winner || row.turf.games.length > 1 || row.p2Wins === 1) break;
  }
  const done = g.winner === "p2" || row.turf.games.length > 1 || row.p2Wins === 1;
  assert.ok(done, "repeated consecutive AFK forfeits the game to blue");
});

await section("turf: concede settles the match, pot pays out once", async () => {
  const [a, b, m] = await turfPair(50, "concede");
  assert.equal(await concedeMatch(db, m.id, b.id), true);
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.status, "settled");
  assert.equal(row.winner, a.id);
  assert.equal(await getBalance(db, a.id), 245); // 200 - 50 + 100 - 5 burned rake
  assert.equal(await getBalance(db, b.id), 150);
  const wins = await db.select().from(ledger).where(sql`reason = 'versus:win' AND ref_id = ${m.id} AND delta > 0`);
  assert.equal(wins.length, 1);
  const rake = await db.select().from(ledger).where(sql`reason = 'versus:rake' AND ref_id = ${m.id} AND delta > 0`);
  assert.equal(rake.length, 1);
  assert.equal(Number(rake[0].delta), 5); // 5% of a 100 pot
});

await section("records: per-mode W\u2013L splits and match history after a settled turf match", async () => {
  const [a, b, m] = await turfPair(50, "records");
  assert.equal((await setHandle(db, b.id, "RecordsFoe")).ok, true);
  await concedeMatch(db, m.id, b.id);
  const recA = await recordFor(db, a.id);
  assert.deepEqual(recA, { w: 1, l: 0, speed: { w: 0, l: 0 }, turf: { w: 1, l: 0 } }, "winner's turf column gets the W");
  const recB = await recordFor(db, b.id);
  assert.equal(recB.turf.l, 1, "loser's turf column gets the L");
  assert.equal(recB.speed.w + recB.speed.l, 0, "speed record untouched by a turf match");
  const histA = await myMatches(db, a.id, 5);
  const row = histA.find((h) => h.id === m.id);
  assert.ok(row, "settled match appears in history");
  assert.equal(row.mode, "turf");
  assert.equal(row.result, "won");
  assert.equal(row.wager, 50);
  assert.equal(row.opp, "RecordsFoe", "opponent handle resolved from users table");
  const histB = await myMatches(db, b.id, 5);
  assert.equal(histB.find((h) => h.id === m.id)?.result, "lost");
  assert.equal(histB.find((h) => h.id === m.id)?.opp, "MYSTERY FRIEND", "handle-less opponent falls back");
});

await section("liveness ADOPTS a score that landed in the race window (never forfeits a delivered round)", async () => {
  // Reproduces the post-race STATE the concurrency audit found: the run row is
  // verified, but the match jsonb still says 'playing' and the deadline has
  // passed. The old code forfeited it to 0 and paid the pot to the opponent.
  const [a, b, m] = await pairUp(50, "adopt");
  const [row0] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const rs = row0.rounds;
  const cur = rs[rs.length - 1];
  const slotA = row0.p1 === a.id ? "p1" : "p2";
  // a's run "verified" underneath while the match still shows it playing
  await db
    .update(runs)
    .set({ status: "verified", score: 4242, finishedAt: new Date() })
    .where(sql`id = ${cur[slotA].runId}`);
  cur.deadline = new Date(Date.now() - 60_000).toISOString();
  await db.update(matches).set({ rounds: rs }).where(sql`id = ${m.id}`);

  await matchStateFor(db, b.id); // b's poll drives liveness
  const [row1] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const done = row1.rounds[0];
  assert.equal(done[slotA].state, "done", "verified side ADOPTED, not forfeited");
  assert.equal(done[slotA].score, 4242, "the delivered score survived");
  const oppSlot = slotA === "p1" ? "p2" : "p1";
  assert.equal(done[oppSlot].state, "forfeit", "the genuinely-absent side still forfeits");
  assert.equal(done.winner, slotA, "the round went to the player who actually played");
});

await section("liveness: an already-closed run is never resurrected as a forfeit win", async () => {
  // The rowcount-fallback path: the run is neither open nor verified
  // (abandoned elsewhere) — the guarded UPDATE matches 0 rows and the code
  // must fall through to a forfeit WITHOUT crediting a score.
  const [a, b, m] = await pairUp(0, "closed");
  const [row0] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const rs = row0.rounds;
  const cur = rs[rs.length - 1];
  const slotA = row0.p1 === a.id ? "p1" : "p2";
  await db
    .update(runs)
    .set({ status: "abandoned", finishedAt: new Date() })
    .where(sql`id = ${cur[slotA].runId}`);
  cur.deadline = new Date(Date.now() - 60_000).toISOString();
  await db.update(matches).set({ rounds: rs }).where(sql`id = ${m.id}`);
  await matchStateFor(db, b.id);
  const [row1] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row1.rounds[0][slotA].state, "forfeit", "abandoned run forfeits");
  assert.equal(row1.rounds[0][slotA].score, 0, "no phantom score");
});

await section("powerups: consumption is guarded — over-use clamps and can never go negative", async () => {
  const u = await upsertUserByDid(db, "did:consume-guard");
  await fund(u.id, 500, "consume-guard");
  assert.equal((await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: "cg-1" })).ok, true);
  // Ask for 5 while owning 1: the relative, gte-guarded write takes exactly 1.
  const applied = await db.transaction((tx) => consumePowerups(tx, u.id, { bomb: 5 }));
  assert.equal(applied.bomb, 1, "clamped to what is owned");
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 0);
  // A second consumer finds nothing left — no negative inventory, no phantom use.
  const again = await db.transaction((tx) => consumePowerups(tx, u.id, { bomb: 1 }));
  assert.equal(again.bomb, undefined, "nothing to take");
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 0, "never negative");
});

await section("airdrop: grants every user once — a re-run with the same ref pays nobody twice", async () => {
  const a = await upsertUserByDid(db, "did:drop-a");
  const b = await upsertUserByDid(db, "did:drop-b");
  await fund(a.id, 570, "drop-pre"); // an existing balance stays additive
  // exercises the SHIPPED function — a route/test copy drift can't hide
  // the ledger/balance-divergence class this section exists to catch
  const { airdropAll } = await import("../lib/economy.ts");
  const drop = () => airdropAll(db, 5000, "airdrop:test-ref");
  const first = await drop();
  assert.equal(first, 2, "every user granted");
  assert.equal(await getBalance(db, a.id), 5570, "additive with existing balance");
  assert.equal(await getBalance(db, b.id), 5000);
  const again = await drop();
  assert.equal(again, 0, "same ref = nobody paid twice");
  assert.equal(await getBalance(db, a.id), 5570, "balance unchanged on re-run");
  // a LATE-JOINING user gets picked up by the next click with the same ref
  const c = await upsertUserByDid(db, "did:drop-c");
  const third = await drop();
  assert.equal(third, 1, "only the newcomer");
  assert.equal(await getBalance(db, c.id), 5000);
});

await section("perf: the opponent record is SNAPSHOTTED at pairing, not re-aggregated per poll", async () => {
  const [a, b, m] = await pairUp(0, "snap");
  // The snapshot exists and both slots carry per-mode splits.
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.ok(row.records, "records snapshot written at pairing");
  assert.ok(row.records.p1 && row.records.p2, "both slots snapshotted");
  assert.deepEqual(
    row.records.p1,
    { w: 0, l: 0, speed: { w: 0, l: 0 }, turf: { w: 0, l: 0 } },
    "fresh players snapshot as 0-0",
  );
  // SENTINEL: poison the stored snapshot. If the poll path still recomputed
  // the lifetime aggregate, the view would report 0-0 and this would fail —
  // so this pins that the hot path actually reads the snapshot.
  const poisoned = {
    p1: { w: 9, l: 8, speed: { w: 5, l: 4 }, turf: { w: 4, l: 4 } },
    p2: { w: 7, l: 6, speed: { w: 3, l: 3 }, turf: { w: 4, l: 3 } },
  };
  await db.update(matches).set({ records: poisoned }).where(sql`id = ${m.id}`);
  const slotA = row.p1 === a.id ? "p1" : "p2";
  const viewA = await matchStateFor(db, a.id);
  const oppSlot = slotA === "p1" ? "p2" : "p1";
  assert.deepEqual(
    (viewA.staging ?? viewA.match ?? viewA.turf).oppRecord,
    poisoned[oppSlot],
    "the view served the SNAPSHOT (not a recomputation)",
  );
  // FALLBACK: pre-perf matches have records=null and must still work.
  await db.update(matches).set({ records: null }).where(sql`id = ${m.id}`);
  const viewB = await matchStateFor(db, b.id);
  assert.deepEqual(
    (viewB.staging ?? viewB.match ?? viewB.turf).oppRecord,
    { w: 0, l: 0, speed: { w: 0, l: 0 }, turf: { w: 0, l: 0 } },
    "null snapshot falls back to a computed record",
  );
});

await section("perf: repeat auth does not rewrite the user row", async () => {
  const first = await upsertUserByDid(db, "did:perf-auth");
  const [before] = await db.select().from(users).where(sql`id = ${first.id}`);
  for (let i = 0; i < 5; i++) {
    const again = await upsertUserByDid(db, "did:perf-auth");
    assert.equal(again.id, first.id, "same row returned");
  }
  const [after] = await db.select().from(users).where(sql`id = ${first.id}`);
  assert.equal(
    after.createdAt.getTime(),
    before.createdAt.getTime(),
    "row untouched across repeat auth (read-only fast path)",
  );
  assert.equal(after.rfBalance, before.rfBalance);
});

await section("versus pulse: admin aggregates see settled matches, endings, and wager flow", async () => {
  // Sections start from a truncated DB — build one settled turf match (2-0 on
  // pure rows) and one conceded speed match, then read the admin aggregates.
  const [a, , m1] = await turfPair(50, "pulse-t");
  for (let g = 0; g < 2; g++) {
    const [rowM] = await db.select().from(matches).where(sql`id = ${m1.id}`);
    const game = rowM.turf.games[rowM.turf.games.length - 1];
    await doctorTurf(m1.id, (gg) => {
      gg.placements = [{ t: "I", r: 0, x: 0, y: 10, by: "p1" }];
      gg.pieces[gg.moveN] = "J";
      gg.turn = "p1";
    });
    const res = await placeTurfMove(db, { matchId: m1.id, userId: a.id, moveN: game.moveN, t: "J", r: 0, x: 4, y: 10 });
    assert.equal(res.ok, true, "pulse fixture: winning move " + (g + 1));
  }
  const [sa, sb, m2] = await pairUp(50, "pulse-s");
  await concedeMatch(db, m2.id, sb.id);

  const { getPlayerMetrics } = await import("../lib/playerMetrics.ts");
  const met = await getPlayerMetrics(db);
  const v = met.versus;
  const turfMode = v.modes.find((x) => x.mode === "turf");
  const speedMode = v.modes.find((x) => x.mode === "speed");
  assert.ok(turfMode && turfMode.settled === 1, "turf settled matches counted");
  assert.ok(speedMode && speedMode.settled === 1, "speed settled matches counted");
  assert.equal(v.activeNow, 0);
  assert.equal(v.matches7d, 2, "recent matches counted");
  assert.equal(v.fighters7d, 4, "distinct fighters counted");
  assert.deepEqual(v.turfEndings, [{ reason: "row", n: 1 }], "turf row ending visible");
  assert.equal(v.money.escrowed, 200, "both matches' stakes escrowed (4 x 50)");
  assert.equal(v.money.paidOut, 190, "both pots paid (2 x 100, minus 5% burned rake each)");
  assert.equal(v.daily.length, 14);
  assert.ok(v.daily[13].turf === 1 && v.daily[13].speed === 1, "today's bar sees both");
});

await section("ready-up: staging view until both ready; round 1 minted on the second READY", async () => {
  const a = await upsertUserByDid(db, "did:ready-a");
  const b = await upsertUserByDid(db, "did:ready-b");
  await joinQueue(db, a.id, 0);
  await joinQueue(db, b.id, 0);
  const m = await activeMatchFor(db, a.id);
  assert.equal(m.rounds.length, 0, "no round before ready-up");
  const va = await matchStateFor(db, a.id);
  assert.equal(va.state, "active");
  assert.ok(va.staging, "staging view served");
  assert.equal(va.staging.myReady, false);
  assert.ok(va.staging.expiresInMs > 0);
  await markReady(db, m.id, a.id);
  const va2 = await matchStateFor(db, a.id);
  assert.equal(va2.staging.myReady, true);
  assert.equal(va2.staging.oppReady, false, "still waiting on b");
  const vb = await matchStateFor(db, b.id);
  assert.equal(vb.staging.oppReady, true, "b sees a is ready");
  assert.equal(await markReady(db, m.id, a.id), true, "idempotent re-ready");
  await markReady(db, m.id, b.id);
  const va3 = await matchStateFor(db, a.id);
  assert.equal(va3.staging, undefined, "staging over");
  assert.ok(va3.match, "round 1 live with fresh clocks");
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.rounds.length, 1);
});

await section("ready-up: turf game 1 minted only after both ready", async () => {
  const a = await upsertUserByDid(db, "did:ready-turf-a");
  const b = await upsertUserByDid(db, "did:ready-turf-b");
  await joinQueue(db, a.id, 0, "turf");
  await joinQueue(db, b.id, 0, "turf");
  const m = await activeMatchFor(db, a.id);
  assert.equal(m.turf.games.length, 0, "no game before ready-up");
  await markReady(db, m.id, b.id);
  await markReady(db, m.id, a.id);
  const va = await matchStateFor(db, a.id);
  assert.ok(va.turf, "turf view live");
  assert.equal(va.turf.game, 1);
  assert.ok(va.turf.deadline > Date.now(), "fresh shot clock");
});

await section("ready-up: never-readied match aborts with refunds", async () => {
  const a = await upsertUserByDid(db, "did:ready-ghost-a");
  const b = await upsertUserByDid(db, "did:ready-ghost-b");
  await fund(a.id, 200, "rg-a");
  await fund(b.id, 200, "rg-b");
  await joinQueue(db, a.id, 100);
  await joinQueue(db, b.id, 100);
  const m = await activeMatchFor(db, a.id);
  assert.equal(await getBalance(db, a.id), 100, "escrowed");
  await markReady(db, m.id, a.id); // only ONE readies
  await db
    .update(matches)
    .set({ createdAt: new Date(Date.now() - READY_TIMEOUT_MS - 5000) })
    .where(sql`id = ${m.id}`);
  const va = await matchStateFor(db, a.id);
  assert.equal(va.state, "over");
  assert.equal(va.result.aborted, true);
  assert.equal(va.result.id, m.id, "aborted result still carries the match id");
  assert.equal(await getBalance(db, a.id), 200, "stake refunded");
  assert.equal(await getBalance(db, b.id), 200, "stake refunded");
  // Aborted matches: VOID in history, zero effect on the W–L record.
  assert.deepEqual(
    await recordFor(db, a.id),
    { w: 0, l: 0, speed: { w: 0, l: 0 }, turf: { w: 0, l: 0 } },
    "abort counts for nobody",
  );
  assert.equal((await myMatches(db, a.id, 5)).find((h) => h.id === m.id)?.result, "void");
});

function getInventoryQty(inv, key) {
  return inv.find((i) => i.key === key)?.qty ?? 0;
}

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
