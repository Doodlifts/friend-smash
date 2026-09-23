/* ============================================================
   scripts/stress-db.mjs — REAL-POSTGRES CONCURRENCY HARNESS.

   Why this exists: verify-db runs on PGlite, which SERIALIZES everything, so
   it proves logic and can NEVER prove interleaving. The one real concurrency
   failure this project has had (a physically impossible overlapping turf
   placement) reached production undetected. This harness is the missing test:
   many genuinely parallel connections against an actual Postgres, hammering
   each money/state invariant, asserting the invariant AFTER the storm.

   Run against a SCRATCH database — never production:
     STRESS_DATABASE_URL=postgres://postgres:doopie@localhost:55432/doopie_test \
       npm run stress:db

   Each scenario: build a fixture, fire N concurrent workers, then assert what
   must be true no matter how the requests interleaved.
   ============================================================ */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { STATES } from "../lib/pieces.ts";
import { matches, ledger, runs, users, inventory, matchQueue } from "../db/schema.ts";
import { seedPowerups, purchasePowerup, consumePowerups, getInventory } from "../lib/powerups.ts";
import { upsertUserByDid } from "../lib/users.ts";
import { getBalance, earn } from "../lib/economy.ts";
import {
  joinQueue,
  matchStateFor,
  activeMatchFor,
  concedeMatch,
  markReady,
  placeTurfMove,
} from "../lib/match.ts";

const url = process.env.STRESS_DATABASE_URL;
if (!url) {
  console.error(
    "STRESS_DATABASE_URL is required (a SCRATCH database — never production).\n" +
      "  docker run -d --name doopie-pg-test -e POSTGRES_PASSWORD=doopie \\\n" +
      "    -e POSTGRES_DB=doopie_test -p 55432:5432 postgres:16-alpine\n" +
      "  STRESS_DATABASE_URL=postgres://postgres:doopie@localhost:55432/doopie_test npm run stress:db",
  );
  process.exit(1);
}
if (/railway|neon|supabase|amazonaws|prod/i.test(url)) {
  console.error("Refusing to stress what looks like a hosted/production database.");
  process.exit(1);
}

// A REAL pool: every worker gets its own connection, so transactions actually
// run concurrently (this is the whole point — PGlite cannot do this).
const POOL = 24;
const client = postgres(url, { max: POOL, prepare: false, onnotice: () => {} });
const db = drizzle(client, { schema });

const ddl = readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8");
await client.unsafe(ddl);
await seedPowerups(db);

let passed = 0;
const failed = [];
async function scenario(name, fn) {
  // Fresh slate per scenario so counts are unambiguous.
  await client.unsafe(
    `TRUNCATE ledger, inventory, scores, runs, match_queue, matches, users RESTART IDENTITY CASCADE`,
  );
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}
const assert = {
  equal(a, b, msg) {
    if (a !== b) throw new Error(`${msg ?? "assert"}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  },
  ok(v, msg) {
    if (!v) throw new Error(msg ?? "assert.ok failed");
  },
};
/** Open every pool connection up front. Without this, postgres-js establishes
 *  connections lazily and the FIRST burst of transactions serializes — which
 *  silently robs every scenario of the interleaving it exists to test (caught
 *  by mutation-testing this harness against the un-fixed code). */
async function warmPool() {
  await Promise.all(
    Array.from({ length: POOL }, () => client`SELECT pg_sleep(0.05)`),
  );
}

/** Fire `n` copies of `fn` truly concurrently; collect results and errors. */
async function storm(n, fn) {
  await warmPool();
  const out = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  return {
    ok: out.filter((r) => r.status === "fulfilled").map((r) => r.value),
    err: out.filter((r) => r.status === "rejected").map((r) => r.reason),
  };
}
const fund = (id, amt, ref) => earn(db, id, amt, "grant", ref);

console.log(`\nREAL-POSTGRES CONCURRENCY STRESS (pool=${POOL})\n`);

/* ---------------------------------------------------------------- money */

await scenario("POWER-UPS: 16 parallel runs cannot consume more than one purchased bomb", async () => {
  const u = await upsertUserByDid(db, "did:stress-bomb");
  await fund(u.id, 500, "sb");
  await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: "sb-1" });
  assert.equal(getInventoryQty(await getInventory(db, u.id), "bomb"), 1, "owns exactly 1");

  // THE ATTACK: N simultaneous consumes, each in its own transaction on its own
  // connection — exactly the parallel-runs exploit the audit described.
  const res = await storm(16, () => db.transaction((tx) => consumePowerups(tx, u.id, { bomb: 1 })));
  const totalTaken = res.ok.reduce((n, a) => n + (a.bomb ?? 0), 0);
  const left = getInventoryQty(await getInventory(db, u.id), "bomb");
  assert.equal(totalTaken, 1, `exactly ONE bomb consumed across all workers (took ${totalTaken})`);
  assert.equal(left, 0, "inventory drained to exactly 0");
  assert.ok(left >= 0, "inventory never negative");
});

await scenario("POWER-UPS: multi-key parallel consumes don't deadlock (sorted lock order)", async () => {
  const u = await upsertUserByDid(db, "did:stress-multi");
  await fund(u.id, 2000, "sm");
  for (let i = 0; i < 6; i++) {
    await purchasePowerup(db, { userId: u.id, key: "bomb", purchaseId: `sm-b${i}` });
    await purchasePowerup(db, { userId: u.id, key: "reroll", purchaseId: `sm-r${i}` });
  }
  // Half the workers ask {bomb,reroll}, half {reroll,bomb} — opposite orders,
  // the classic deadlock setup. The sorted iteration must prevent it.
  const res = await storm(16, (i) =>
    db.transaction((tx) =>
      consumePowerups(tx, u.id, i % 2 ? { bomb: 1, reroll: 1 } : { reroll: 1, bomb: 1 }),
    ),
  );
  const deadlocks = res.err.filter((e) => /deadlock/i.test(String(e?.message ?? e)));
  assert.equal(deadlocks.length, 0, `no deadlocks (${deadlocks.length} seen)`);
  const took = res.ok.reduce((n, a) => n + (a.bomb ?? 0) + (a.reroll ?? 0), 0);
  const left =
    getInventoryQty(await getInventory(db, u.id), "bomb") +
    getInventoryQty(await getInventory(db, u.id), "reroll");
  assert.equal(took + left, 12, `conservation: ${took} taken + ${left} left must equal 12`);
});

await scenario("SETTLEMENT: 12 concurrent concedes pay the pot exactly once", async () => {
  const [a, b, m] = await stressPair(100, "settle");
  const before = (await getBalance(db, a.id)) + (await getBalance(db, b.id));
  // Both players' clients AND retries all conceding at once.
  await storm(12, (i) => concedeMatch(db, m.id, i % 2 ? a.id : b.id));
  const wins = await db.select().from(ledger).where(sql`reason = 'versus:win' AND ref_id = ${m.id}`);
  const refunds = await db.select().from(ledger).where(sql`reason = 'versus:refund' AND ref_id = ${m.id}`);
  assert.ok(wins.length + refunds.length > 0, "the pot settled");
  assert.equal(wins.length <= 1, true, `at most ONE win leg (${wins.length})`);
  assert.equal(refunds.length === 0 || wins.length === 0, true, "never both win AND refund legs");
  const after = (await getBalance(db, a.id)) + (await getBalance(db, b.id));
  assert.equal(after - before, 200, `exactly the 200 pot returned (delta ${after - before})`);
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.status, "settled");
});

await scenario("SETTLEMENT: concedes racing liveness polls never mint money", async () => {
  const [a, b, m] = await stressPair(50, "race");
  const before = (await getBalance(db, a.id)) + (await getBalance(db, b.id));
  // Expire the round so polls want to forfeit, while concedes fly in.
  const [row0] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const rs = row0.rounds;
  rs[rs.length - 1].deadline = new Date(Date.now() - 60_000).toISOString();
  await db.update(matches).set({ rounds: rs }).where(sql`id = ${m.id}`);
  await storm(16, (i) =>
    i % 3 === 0 ? concedeMatch(db, m.id, a.id) : matchStateFor(db, i % 2 ? a.id : b.id),
  );
  const legs = await db
    .select()
    .from(ledger)
    .where(sql`ref_id = ${m.id} AND reason IN ('versus:win','versus:refund')`);
  const credited = legs.reduce((n, l) => n + Number(l.delta), 0);
  assert.ok(credited <= 100, `credited ${credited} must never exceed the 100 pot`);
  const after = (await getBalance(db, a.id)) + (await getBalance(db, b.id));
  assert.equal(after - before, 100, `pot conserved exactly (delta ${after - before})`);
});

/* ------------------------------------------------------------- pipeline */

await scenario("LIVENESS: a score committed mid-flight is ADOPTED, never overwritten by forfeit", async () => {
  // The audit's critical finding, forced DETERMINISTICALLY instead of hoping
  // for a sub-millisecond coincidence: a separate transaction HOLDS the runs
  // row, so the liveness poll is guaranteed to be mid-flight when the score
  // commits. Without the lock+rowcount fix, the poll writes forfeit/0 over a
  // delivered score and the pot pays the wrong player.
  const [a, b, m] = await stressPair(50, "adopt");
  const [row0] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const rs = row0.rounds;
  const cur = rs[rs.length - 1];
  const slotA = row0.p1 === a.id ? "p1" : "p2";
  const runId = cur[slotA].runId;
  cur.deadline = new Date(Date.now() - 1_000).toISOString(); // polls want to forfeit
  await db.update(matches).set({ rounds: rs }).where(sql`id = ${m.id}`);

  // T1: hold the run row, then flip it to verified and commit.
  const holder = client.begin(async (tx) => {
    await tx`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
    await tx`SELECT pg_sleep(0.5)`; // the poll runs into this window
    await tx`UPDATE runs SET status = 'verified', score = 7777, finished_at = now() WHERE id = ${runId}`;
  });
  await new Promise((r) => setTimeout(r, 120)); // let T1 take the lock first
  const polls = [matchStateFor(db, b.id), matchStateFor(db, a.id)];
  await Promise.allSettled([holder, ...polls]);

  const [runRow] = await db.select().from(runs).where(sql`id = ${runId}`);
  assert.equal(runRow.status, "verified", "fixture: the score did commit");
  const [row1] = await db.select().from(matches).where(sql`id = ${m.id}`);
  const r0 = row1.rounds[0];
  assert.ok(
    r0[slotA].state !== "forfeit",
    `run verified(7777) but the match recorded a FORFEIT — the wrong-payout bug`,
  );
  assert.equal(Number(r0[slotA].score), 7777, "the delivered score is what settled");
  assert.equal(r0.winner, slotA, "the round went to the player who actually played");
  // And the money followed the truth.
  const wins = await db.select().from(ledger).where(sql`reason = 'versus:win' AND ref_id = ${m.id}`);
  if (wins.length) assert.equal(wins[0].userId, a.id, "the pot went to the player with the score");
});

/* ----------------------------------------------------------- pairing */

await scenario("PAIRING: 10 players storming the queue never double-escrow or self-pair", async () => {
  const players = [];
  for (let i = 0; i < 10; i++) {
    const u = await upsertUserByDid(db, `did:stress-q${i}`);
    await fund(u.id, 500, `q${i}`);
    players.push(u);
  }
  // Everyone queues at the same tier simultaneously, then everyone polls hard.
  await storm(10, (i) => joinQueue(db, players[i].id, 50, "speed"));
  await storm(30, (i) => matchStateFor(db, players[i % 10].id));
  const rows = await db.select().from(matches);
  for (const m of rows) assert.ok(m.p1 !== m.p2, "never self-paired");
  // Each player: at most one active match, and escrow charged at most once.
  for (const p of players) {
    const mine = rows.filter((m) => (m.p1 === p.id || m.p2 === p.id) && m.status === "active");
    assert.ok(mine.length <= 1, `${p.id} in ${mine.length} active matches`);
    const esc = await db
      .select()
      .from(ledger)
      .where(sql`user_id = ${p.id} AND reason = 'versus:escrow'`);
    const perMatch = new Map();
    for (const e of esc) perMatch.set(e.refId, (perMatch.get(e.refId) ?? 0) + 1);
    for (const [ref, n] of perMatch) assert.equal(n, 1, `escrow charged once per match (${ref} x${n})`);
    const bal = await getBalance(db, p.id);
    assert.equal(bal, 500 - esc.length * 50, `balance matches escrow count for ${p.id}`);
  }
  const q = await db.select().from(matchQueue);
  for (const row of q) {
    const active = rows.find((m) => (m.p1 === row.userId || m.p2 === row.userId) && m.status === "active");
    assert.ok(!active, "a paired player is never left sitting in the queue");
  }
});

/* -------------------------------------------------------------- turf */

await scenario("TURF: concurrent places + polls never store an overlapping placement", async () => {
  // The class of bug that actually reached production once.
  const [a, b, m] = await stressTurfPair(0, "overlap");
  for (let round = 0; round < 12; round++) {
    const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
    if (row.status !== "active") break;
    const g = row.turf.games[row.turf.games.length - 1];
    if (!g || g.winner) break;
    const view = await matchStateFor(db, g.turn === "p1" ? a.id : b.id);
    if (!view.turf) break;
    const mover = g.turn === "p1" ? a.id : b.id;
    const other = g.turn === "p1" ? b.id : a.id;
    // The mover fires the SAME move many times (retries) while the opponent
    // spams places of their own and both sides poll.
    await storm(14, (i) => {
      if (i % 7 === 6) return matchStateFor(db, other);
      const who = i % 3 === 2 ? other : mover; // wrong-turn attempts too
      return placeTurfMove(db, {
        matchId: m.id,
        userId: who,
        moveN: view.turf.moveN,
        t: view.turf.piece,
        r: 0,
        x: 1 + (i % 3),
        y: 3 + (i % 4),
      }).catch(() => null);
    });
    // INVARIANT: no cell is ever claimed twice.
    const [after] = await db.select().from(matches).where(sql`id = ${m.id}`);
    for (const game of after.turf.games) {
      const seen = new Map();
      for (const p of game.placements ?? []) {
        for (const [fx, fy] of cellsOf(p.t, p.r)) {
          const key = `${p.x + fx},${p.y + fy}`;
          assert.ok(!seen.has(key), `cell ${key} claimed twice (${seen.get(key)} then ${p.by} ${p.t})`);
          seen.set(key, p.by);
        }
      }
      // moveN must never exceed the placement count it indexes
      assert.ok(
        (game.placements ?? []).length >= game.moveN,
        `moveN ${game.moveN} ahead of ${game.placements?.length} placements`,
      );
    }
  }
});

await scenario("TURF: simultaneous READY taps mint exactly one game with one clock", async () => {
  const a = await upsertUserByDid(db, "did:stress-ra");
  const b = await upsertUserByDid(db, "did:stress-rb");
  await joinQueue(db, a.id, 0, "turf");
  await joinQueue(db, b.id, 0, "turf");
  const m = await activeMatchFor(db, a.id);
  await storm(12, (i) => markReady(db, m.id, i % 2 ? a.id : b.id));
  const [row] = await db.select().from(matches).where(sql`id = ${m.id}`);
  assert.equal(row.turf.games.length, 1, `exactly one game minted (${row.turf.games.length})`);
  assert.equal(row.turf.games[0].n, 1);
  assert.equal((row.turf.games[0].placements ?? []).length, 0, "no phantom placements");
});

/* ------------------------------------------------------------ airdrop */

await scenario("AIRDROP: 10 concurrent clicks grant each user exactly once", async () => {
  const { airdropAll } = await import("../lib/economy.ts");
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push((await upsertUserByDid(db, `did:stress-drop${i}`)).id);
  const res = await storm(10, () => airdropAll(db, 5000, "airdrop:stress"));
  const deadlocks = res.err.filter((e) => /deadlock/i.test(String(e?.message ?? e)));
  const granted = res.ok.reduce((n, v) => n + v, 0);
  assert.equal(granted, 8, `exactly 8 grants total across 10 clicks (got ${granted})`);
  for (const id of ids) {
    assert.equal(await getBalance(db, id), 5000, "each user credited exactly once");
    const rows = await db
      .select()
      .from(ledger)
      .where(sql`user_id = ${id} AND ref_id = 'airdrop:stress'`);
    assert.equal(rows.length, 1, "one ledger row per user");
  }
  if (deadlocks.length) console.log(`      (note: ${deadlocks.length} transient deadlock(s), retry-safe)`);
});

/* -------------------------------------------------------------- helpers */

function getInventoryQty(inv, key) {
  return inv.find((i) => i.key === key)?.qty ?? 0;
}
/** Cell offsets for a piece rotation (the server referee's own table). */
function cellsOf(t, r) {
  return STATES[t][r].cells;
}
async function stressPair(wager, tag) {
  const a = await upsertUserByDid(db, `did:sp-${tag}-a`);
  const b = await upsertUserByDid(db, `did:sp-${tag}-b`);
  if (wager > 0) {
    await fund(a.id, 100 + wager, `${tag}-a`);
    await fund(b.id, 100 + wager, `${tag}-b`);
  }
  await joinQueue(db, a.id, wager, "speed");
  await joinQueue(db, b.id, wager, "speed");
  const m = await activeMatchFor(db, a.id);
  if (!m) throw new Error("pairing failed in fixture");
  // The ready gate mints round 1 — without it rounds[] is empty.
  await markReady(db, m.id, a.id);
  await markReady(db, m.id, b.id);
  const [live] = await db.select().from(matches).where(sql`id = ${m.id}`);
  return [a, b, live];
}
async function stressTurfPair(wager, tag) {
  const a = await upsertUserByDid(db, `did:st-${tag}-a`);
  const b = await upsertUserByDid(db, `did:st-${tag}-b`);
  if (wager > 0) {
    await fund(a.id, 100 + wager, `${tag}-a`);
    await fund(b.id, 100 + wager, `${tag}-b`);
  }
  await joinQueue(db, a.id, wager, "turf");
  await joinQueue(db, b.id, wager, "turf");
  const m = await activeMatchFor(db, a.id);
  if (!m) throw new Error("turf pairing failed in fixture");
  await markReady(db, m.id, a.id);
  await markReady(db, m.id, b.id);
  return [a, b, m];
}


console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log("FAILED:", failed.join(" | "));
}
await client.end();
process.exit(failed.length ? 1 : 0);
