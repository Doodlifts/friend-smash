/* ============================================================
   db/schema.ts — Drizzle schema (Postgres). Source of truth for the
   typed query layer. Mirrors BUILD_PLAN.md §2.

   Money-like values (rf_balance, ledger.delta) are INTEGERS, never floats.
   The ledger is the source of truth; users.rf_balance is a cached sum kept
   in step with ledger inserts inside a transaction.
   ============================================================ */

import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigserial,
  primaryKey,
  unique,
  index,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  // "friend:<tokenId>" — the player IS the Rare Friend (FriendSDK: items and
  // rewards belong to the NFT), so a sold Friend carries its balance with it.
  did: text("did").notNull().unique(),
  friendId: text("friend_id"), // decimal Generations token id
  ownerAddress: text("owner_address"), // wallet that last signed in (lowercase)
  friendWallet: text("friend_wallet"), // canonical token-bound account (future real RF payouts)
  handle: text("handle").unique(),
  // When the handle was last changed — drives the anti-churn cooldown.
  handleUpdatedAt: timestamp("handle_updated_at", { withTimezone: true }),
  // SIMULATED RF balance in integer units (1 unit = 0.01 RF; cached sum of the
  // ledger). See lib/rf/ledger.ts for the on-chain swap-in point.
  rfBalance: bigint("rf_balance", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  seed: bigint("seed", { mode: "number" }).notNull(), // server-issued RNG seed
  status: text("status").notNull(), // 'open' | 'submitted' | 'verified' | 'rejected'
  // null/'solo' = normal run. 'versus' = one player's 60s round inside a
  // match — verified by the SAME replay pipeline but never on the leaderboard.
  mode: text("mode"),
  matchId: uuid("match_id"), // set on versus rounds
  // 'ranked' runs paid a daily-pool entry; poolDay = the UTC day they count for.
  poolDay: text("pool_day"),
  score: integer("score"), // server-computed, authoritative
  lines: integer("lines"),
  durationMs: integer("duration_ms"),
  powerupsUsed: jsonb("powerups_used"),
  // Power-ups already consumed from inventory AT USE TIME during this run
  // ({key: count}). Finish/abandon reconcile against this so a reload/tab-kill
  // can never "refund" a spent power-up, and nothing double-consumes.
  powerupsConsumed: jsonb("powerups_consumed"),
  // Raw timestamped input log, captured for Phase-3 deterministic replay/audit.
  inputLog: jsonb("input_log"),
  // Game-config SNAPSHOT at run start (bonus tuning etc.) — the replay uses
  // this, never the live config, so tuning edits can't break in-flight runs.
  config: jsonb("config"),
  // Client IP at run-start, for per-IP rate limiting (best-effort).
  ip: text("ip"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const scores = pgTable(
  "scores",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    score: integer("score").notNull(),
    period: text("period").notNull(), // 'all' | 'weekly' | 'daily'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Leaderboard reads: top scores per period.
    periodScoreIdx: index("scores_period_score_idx").on(t.period, t.score),
    createdIdx: index("scores_created_idx").on(t.createdAt),
    // Per-user best lookup (getUserRank's "my best" query + rank subquery).
    userScoreIdx: index("scores_user_score_idx").on(t.userId, t.score),
  }),
);

export const powerups = pgTable("powerups", {
  key: text("key").primaryKey(), // 'slow_fall' | 'bomb' | 'reroll' | ...
  name: text("name").notNull(),
  description: text("description").notNull(),
  price: integer("price").notNull(), // in RF units (simulated)
  active: boolean("active").notNull().default(true),
});

export const inventory = pgTable(
  "inventory",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    powerupKey: text("powerup_key")
      .notNull()
      .references(() => powerups.key),
    qty: integer("qty").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.powerupKey] }),
  }),
);

export const ledger = pgTable(
  "ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    delta: bigint("delta", { mode: "number" }).notNull(), // +earned / -spent
    reason: text("reason").notNull(), // 'run_reward' | 'purchase:bomb' | 'grant'
    refId: text("ref_id"), // run id / purchase id (idempotency)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotency guard: a (user, reason, ref) can be applied at most once.
    uniqRef: unique("ledger_user_reason_ref_uniq").on(t.userId, t.reason, t.refId),
    userIdx: index("ledger_user_idx").on(t.userId),
  }),
);

/* ---------------- VERSUS (multiplayer) ----------------
   match_queue: one row per player waiting for an opponent at a wager tier.
   matches: the authoritative match state machine. Wagers are SIMULATED RF
   (ledger entries) — same rail as shop purchases; on-chain stays deferred.
   Round-by-round data lives in `rounds` jsonb:
     [{ n, seed, startsAt, deadline,
        p1: {runId, live, score, state:'playing'|'done'|'forfeit', rejected?},
        p2: {...}, winner: 'p1'|'p2'|'tie'|null }]
   Every player-round is ALSO a `runs` row (mode='versus') so the existing
   replay/anti-cheat pipeline verifies it — versus scores never touch the
   leaderboard. */

export const matchQueue = pgTable("match_queue", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  wager: integer("wager").notNull().default(0),
  mode: text("mode").notNull().default("speed"), // pairing matches mode + tier
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
});

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    status: text("status").notNull(), // 'active' | 'settled' | 'aborted'
    p1: uuid("p1").notNull().references(() => users.id),
    p2: uuid("p2").notNull().references(() => users.id),
    wager: integer("wager").notNull().default(0), // per player, SIMULATED RF
    // 'speed' = best-of-5 60s same-seed rounds. 'turf' = turn-based
    // shared-board TURF WAR (state in `turf`, refereed by lib/turf.ts).
    mode: text("mode").notNull().default("speed"),
    turf: jsonb("turf"), // TurfState — null on speed matches
    // Ready-up gate: {p1:bool,p2:bool}. Round/game 1 is created only when
    // BOTH are true; nobody's clock runs while someone is reading the rules.
    ready: jsonb("ready"),
    // Opponent W–L snapshot taken at pairing ({p1,p2}) — a record cannot
    // change mid-match, so the poll path reads this instead of re-aggregating
    // a lifetime history every second. NULL on pre-perf matches (computed).
    records: jsonb("records"),
    bestOf: integer("best_of").notNull().default(5),
    roundSecs: integer("round_secs").notNull().default(60),
    round: integer("round").notNull().default(1), // current round (1-based)
    rounds: jsonb("rounds").notNull(),
    p1Wins: integer("p1_wins").notNull().default(0),
    p2Wins: integer("p2_wins").notNull().default(0),
    winner: uuid("winner"), // set on settle; null = draw/abort
    // Versus tuning snapshot shared by every round of THIS match (bonus and
    // drops disabled). Each round's runs row also carries it for the replay.
    config: jsonb("config"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => ({
    p1StatusIdx: index("matches_p1_status_idx").on(t.p1, t.status),
    p2StatusIdx: index("matches_p2_status_idx").on(t.p2, t.status),
  }),
);

// Admin-tunable game configuration (single row, id=1). See lib/gameConfig.ts.
export const gameConfig = pgTable("game_config", {
  id: integer("id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Visual-asset OVERRIDES (admin ASSETS panel): swap piece art / the logo
// without a deploy. `key` is allowlisted in lib/assets.ts; `data` is base64
// (sprites are tens of KB — fine in Postgres); `meta` = {dx,dy,fw,fh} per the
// CLAUDE.md art convention. Absent row = the bundled asset ships.
export const assets = pgTable("assets", {
  key: text("key").primaryKey(),
  mime: text("mime").notNull(),
  data: text("data").notNull(),
  meta: jsonb("meta"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Match = typeof matches.$inferSelect;
export type MatchQueueRow = typeof matchQueue.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type Score = typeof scores.$inferSelect;
export type Powerup = typeof powerups.$inferSelect;
export type InventoryRow = typeof inventory.$inferSelect;
export type LedgerRow = typeof ledger.$inferSelect;
