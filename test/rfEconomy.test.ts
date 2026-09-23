/* test/rfEconomy.test.ts — the SIMULATED RF economy against real SQL (PGlite).

   Covers the double-entry invariant (all balances sum to zero), starter/daily
   faucet idempotency, power-up burns, ranked pool entry (80/20 split),
   settlement (top-heavy, idempotent, oldest-first rollover) and the versus rake. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { makeTestDb } from "./helpers/testDb";
import type { DrizzleDb } from "../lib/db";
import { runs, scores } from "../db/schema";
import { upsertUserByDid } from "../lib/users";
import { _clearSystemIds, grantFromFaucet, systemBalance, SYSTEM, balanceOf } from "../lib/rf/ledger";
import { purchasePowerup } from "../lib/powerups";
import { enterPool, settleDuePools, poolStatus, splitPool, poolPeriod } from "../lib/rf/pool";
import { POOL_BURN, POOL_ENTRY, POOL_SHARE, STARTER_GRANT, versusRake } from "../lib/rf/economy-rules";
import { claimDaily } from "../lib/daily";

async function fresh(): Promise<DrizzleDb> {
  _clearSystemIds();
  return makeTestDb();
}

async function sumAll(db: DrizzleDb): Promise<number> {
  const r = (await db.execute(sql`select coalesce(sum(rf_balance),0) as s from users`)) as unknown as { rows: { s: unknown }[] };
  return Number(r.rows[0].s);
}

async function ledgerSum(db: DrizzleDb): Promise<number> {
  const r = (await db.execute(sql`select coalesce(sum(delta),0) as s from ledger`)) as unknown as { rows: { s: unknown }[] };
  return Number(r.rows[0].s);
}

async function friend(db: DrizzleDb, id: number, rf = 0) {
  const u = await upsertUserByDid(db, `friend:${id}`);
  if (rf) await grantFromFaucet(db, u.id, rf, "starter_grant", "starter");
  return u;
}

async function openRun(db: DrizzleDb, userId: string, startedAt = new Date()) {
  const [r] = await db.insert(runs).values({ userId, seed: 1, status: "open", startedAt }).returning();
  return r;
}

test("starter grant is idempotent and balanced by the faucet", async () => {
  const db = await fresh();
  const u = await friend(db, 1);
  const a = await grantFromFaucet(db, u.id, STARTER_GRANT, "starter_grant", "starter");
  const b = await grantFromFaucet(db, u.id, STARTER_GRANT, "starter_grant", "starter");
  assert.equal(a.applied, true);
  assert.equal(b.applied, false);
  assert.equal(await balanceOf(db, u.id), STARTER_GRANT);
  assert.equal(await systemBalance(db, SYSTEM.faucet), -STARTER_GRANT);
  assert.equal(await sumAll(db), 0);
  assert.equal(await ledgerSum(db), 0);
});

test("daily claims from two Friends on the same day don't collide", async () => {
  process.env.DAILY_BONUS_ENABLED = "1";
  const db = await fresh();
  const a = await friend(db, 1);
  const b = await friend(db, 2);
  const now = new Date("2026-09-22T12:00:00Z");
  assert.equal((await claimDaily(db, a.id, now)).awarded, true);
  assert.equal((await claimDaily(db, b.id, now)).awarded, true);
  assert.equal((await claimDaily(db, a.id, now)).awarded, false);
  const s = await claimDaily(db, a.id, now);
  assert.equal(s.streak, 1);
  assert.equal(await sumAll(db), 0);
});

test("power-up purchases burn 100%, retries don't double-charge", async () => {
  const db = await fresh();
  const u = await friend(db, 1, 500);
  const r1 = await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: "p1" });
  const r2 = await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: "p1" });
  assert.equal(r1.ok, true);
  assert.equal(r2.duplicate, true);
  assert.equal(await balanceOf(db, u.id), 500 - 120);
  assert.equal(await systemBalance(db, SYSTEM.burn), 120);
  // two Friends reusing the same purchase id still both burn
  const v = await friend(db, 2, 500);
  assert.equal((await purchasePowerup(db, { userId: v.id, key: "bomb", purchaseId: "p1" })).ok, true);
  assert.equal(await systemBalance(db, SYSTEM.burn), 240);
  const broke = await friend(db, 3, 10);
  const r3 = await purchasePowerup(db, { userId: broke.id, key: "bomb", purchaseId: "p9" });
  assert.equal(r3.ok, false);
  assert.equal(await balanceOf(db, broke.id), 10);
  assert.equal(await sumAll(db), 0);
});

test("ranked entry splits 80% pool / 20% burn, idempotent, needs funds", async () => {
  const db = await fresh();
  const now = new Date("2026-09-22T10:00:00Z");
  const u = await friend(db, 1, 1000);
  const run = await openRun(db, u.id, now);
  const e1 = await enterPool(db, { userId: u.id, runId: run.id, now });
  const e2 = await enterPool(db, { userId: u.id, runId: run.id, now });
  assert.equal(e1.ok, true);
  assert.equal(e2.ok && e2.duplicate, true);
  assert.equal(await balanceOf(db, u.id), 1000 - POOL_ENTRY);
  assert.equal(await systemBalance(db, SYSTEM.pool("2026-09-22")), POOL_SHARE);
  assert.equal(await systemBalance(db, SYSTEM.burn), POOL_BURN);

  const poor = await friend(db, 2, 20);
  const r2 = await openRun(db, poor.id, now);
  const e3 = await enterPool(db, { userId: poor.id, runId: r2.id, now });
  assert.equal(e3.ok, false);
  assert.equal(!e3.ok && e3.status, 402);

  const stale = await openRun(db, u.id, new Date(now.getTime() - 60 * 60 * 1000));
  const e4 = await enterPool(db, { userId: u.id, runId: stale.id, now });
  assert.equal(e4.ok, false);
  assert.equal(await sumAll(db), 0);
});

test("pool settles top-heavy after the grace period, exactly once", async () => {
  const db = await fresh();
  const day = "2026-09-22";
  const now = new Date(`${day}T10:00:00Z`);
  const players = [];
  for (let i = 1; i <= 4; i++) {
    const u = await friend(db, i, 1000);
    const r = await openRun(db, u.id, now);
    assert.equal((await enterPool(db, { userId: u.id, runId: r.id, now })).ok, true);
    await db.insert(scores).values({ userId: u.id, runId: r.id, score: 1000 * i, period: poolPeriod(day) });
    players.push(u);
  }
  const pot = 4 * POOL_SHARE;
  assert.equal(await systemBalance(db, SYSTEM.pool(day)), pot);

  // before the grace period: nothing moves
  assert.deepEqual(await settleDuePools(db, new Date(`${day}T23:59:00Z`)), []);
  assert.deepEqual(await settleDuePools(db, new Date("2026-09-23T01:00:00Z")), []);

  const after = new Date("2026-09-23T03:00:00Z");
  assert.deepEqual(await settleDuePools(db, after), [day]);
  assert.deepEqual(await settleDuePools(db, after), []); // idempotent
  assert.equal(await systemBalance(db, SYSTEM.pool(day)), 0);

  const expected = splitPool(pot, 4); // [64, 48, 32, 16]
  assert.deepEqual(expected, [64, 48, 32, 16]);
  // players[3] had the best score
  assert.equal(await balanceOf(db, players[3].id), 1000 - POOL_ENTRY + expected[0]);
  assert.equal(await balanceOf(db, players[0].id), 1000 - POOL_ENTRY + expected[3]);

  const st = await poolStatus(db, { now: after });
  assert.equal(st.yesterday?.winners.length, 4);
  assert.equal(st.totals.prizesPaid, pot);
  assert.equal(st.totals.burned, 4 * POOL_BURN);
  assert.equal(await sumAll(db), 0);
});

test("an empty pool rolls over oldest-first into the next day", async () => {
  const db = await fresh();
  const u = await friend(db, 1, 1000);
  // Day A: entry but no finished score → rolls to day B
  const a = "2026-09-20";
  const ra = await openRun(db, u.id, new Date(`${a}T10:00:00Z`));
  await enterPool(db, { userId: u.id, runId: ra.id, now: new Date(`${a}T10:00:00Z`) });
  // Day B: one finisher
  const b = "2026-09-21";
  const rb = await openRun(db, u.id, new Date(`${b}T10:00:00Z`));
  await enterPool(db, { userId: u.id, runId: rb.id, now: new Date(`${b}T10:00:00Z`) });
  await db.insert(scores).values({ userId: u.id, runId: rb.id, score: 500, period: poolPeriod(b) });

  await settleDuePools(db, new Date("2026-09-23T12:00:00Z"));
  assert.equal(await systemBalance(db, SYSTEM.pool(a)), 0);
  assert.equal(await systemBalance(db, SYSTEM.pool(b)), 0);
  // the single finisher of day B received both days' pots
  assert.equal(await balanceOf(db, u.id), 1000 - 2 * POOL_ENTRY + 2 * POOL_SHARE);
  assert.equal(await sumAll(db), 0);
});

test("versus rake is 5% of the pot, floored", () => {
  assert.equal(versusRake(50), 5);
  assert.equal(versusRake(100), 10);
  assert.equal(versusRake(250), 25);
  assert.equal(versusRake(0), 0);
});

test("splitPool always pays out the whole pot", () => {
  for (const [pot, n] of [[1, 3], [7, 10], [4000, 10], [399, 7]] as const) {
    const s = splitPool(pot, n);
    assert.equal(s.reduce((a, b) => a + b, 0), pot);
    for (let i = 1; i < s.length; i++) assert.ok(s[i] <= s[i - 1]);
  }
});
