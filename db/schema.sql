-- ============================================================
-- db/schema.sql — Friend Smash database schema (Postgres).
-- Mirrors db/schema.ts. Run once against your DATABASE_URL:
--   npm run db:setup          (applies this file)
-- or psql "$DATABASE_URL" -f db/schema.sql
-- Safe to re-run (IF NOT EXISTS everywhere).
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  did           text UNIQUE NOT NULL,        -- "friend:<tokenId>" (the player is the Friend)
  friend_id     text,                        -- Generations token id (decimal)
  owner_address text,                        -- wallet that last signed in (lowercase)
  friend_wallet text,                        -- canonical token-bound account (future real RF)
  handle        text UNIQUE,
  handle_updated_at timestamptz,             -- last handle change (anti-churn cooldown)
  rf_balance    bigint NOT NULL DEFAULT 0,   -- SIMULATED RF balance (1 unit = 0.01 RF)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  seed         bigint NOT NULL,              -- server-issued RNG seed
  status       text NOT NULL,               -- 'open' | 'submitted' | 'verified' | 'rejected'
  score        integer,                     -- server-computed, authoritative
  lines        integer,
  duration_ms  integer,
  powerups_used jsonb,
  powerups_consumed jsonb,                  -- consumed AT USE TIME ({key: count}); finish/abandon reconcile
  input_log    jsonb,                       -- raw input log for Phase-3 replay/audit
  config       jsonb,                       -- game-config snapshot at run start (replay uses this)
  ip           text,                        -- client IP at start (per-IP rate limiting)
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS pool_day text;   -- ranked daily-pool day (UTC)
CREATE INDEX IF NOT EXISTS runs_user_idx ON runs(user_id);
CREATE INDEX IF NOT EXISTS runs_ip_idx ON runs(ip);
-- additive for existing databases
ALTER TABLE runs ADD COLUMN IF NOT EXISTS config jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS powerups_consumed jsonb;

-- Admin-tunable game configuration (single row, id=1). See lib/gameConfig.ts.
CREATE TABLE IF NOT EXISTS game_config (
  id         integer PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scores (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  run_id     uuid NOT NULL REFERENCES runs(id),
  score      integer NOT NULL,
  period     text NOT NULL,                 -- 'all' | 'weekly' | 'daily'
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scores_period_score_idx ON scores(period, score);
CREATE INDEX IF NOT EXISTS scores_created_idx ON scores(created_at);
CREATE INDEX IF NOT EXISTS scores_user_score_idx ON scores(user_id, score);

CREATE TABLE IF NOT EXISTS powerups (
  key         text PRIMARY KEY,             -- 'slow_fall' | 'bomb' | 'reroll' | ...
  name        text NOT NULL,
  description text NOT NULL,
  price       integer NOT NULL,             -- in RF units (simulated)
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS inventory (
  user_id     uuid NOT NULL REFERENCES users(id),
  powerup_key text NOT NULL REFERENCES powerups(key),
  qty         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, powerup_key)
);

CREATE TABLE IF NOT EXISTS ledger (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  delta      bigint NOT NULL,               -- +earned / -spent
  reason     text NOT NULL,                 -- 'run_reward' | 'purchase:bomb' | 'grant'
  ref_id     text,                          -- run id / purchase id (idempotency)
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_user_reason_ref_uniq UNIQUE (user_id, reason, ref_id)
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger(user_id);

-- ---------------- VERSUS (multiplayer) ----------------
ALTER TABLE runs ADD COLUMN IF NOT EXISTS mode text;      -- null/'solo' | 'versus'
ALTER TABLE runs ADD COLUMN IF NOT EXISTS match_id uuid;  -- versus rounds only

CREATE TABLE IF NOT EXISTS match_queue (
  user_id     uuid PRIMARY KEY REFERENCES users(id),
  wager       integer NOT NULL DEFAULT 0,       -- SIMULATED RF tier (0/50/100/250)
  enqueued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status     text NOT NULL,                     -- 'active' | 'settled' | 'aborted'
  p1         uuid NOT NULL REFERENCES users(id),
  p2         uuid NOT NULL REFERENCES users(id),
  wager      integer NOT NULL DEFAULT 0,        -- per player, SIMULATED RF
  best_of    integer NOT NULL DEFAULT 5,
  round_secs integer NOT NULL DEFAULT 60,
  round      integer NOT NULL DEFAULT 1,
  rounds     jsonb NOT NULL,
  p1_wins    integer NOT NULL DEFAULT 0,
  p2_wins    integer NOT NULL DEFAULT 0,
  winner     uuid,
  config     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS matches_p1_status_idx ON matches(p1, status);
CREATE INDEX IF NOT EXISTS matches_p2_status_idx ON matches(p2, status);

-- ---------------- TURF WAR (mode #2) ----------------
ALTER TABLE matches     ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'speed';
ALTER TABLE matches     ADD COLUMN IF NOT EXISTS turf jsonb;   -- TurfState (lib/turf.ts)
ALTER TABLE match_queue ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'speed';

ALTER TABLE matches ADD COLUMN IF NOT EXISTS ready jsonb;  -- ready-up gate {p1,p2}

-- ---------------- POLL HOT PATHS (perf, additive) ----------------
-- Opponent W–L snapshot taken at pairing: {p1:{...},p2:{...}}. It cannot
-- change mid-match (both players are locked into this one), so recomputing a
-- LIFETIME aggregate on every 1s poll was pure waste. NULL on pre-existing
-- matches → the code falls back to computing it.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS records jsonb;

-- The lobby's "N smashing" counter and the age-cap sweep filter on status
-- alone; the (p1,status)/(p2,status) indexes can't serve that, so it was a
-- full scan of a forever-growing table on EVERY queued player's poll.
CREATE INDEX IF NOT EXISTS matches_active_idx ON matches(status) WHERE status = 'active';

-- Settlement closes a match's still-open runs while HOLDING the match row
-- lock — unindexed, that scan grows with total run history and stretches the
-- lock hold time for every wager settlement.
CREATE INDEX IF NOT EXISTS runs_match_idx ON runs(match_id) WHERE match_id IS NOT NULL;

-- Recently-settled result replay + /stats versus history: newest-first per player.
CREATE INDEX IF NOT EXISTS matches_p1_settled_idx ON matches(p1, settled_at DESC);
CREATE INDEX IF NOT EXISTS matches_p2_settled_idx ON matches(p2, settled_at DESC);

-- Rate-limit counters scan recent runs per user and per IP on every start/finish.
CREATE INDEX IF NOT EXISTS runs_user_started_idx ON runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_ip_started_idx ON runs(ip, started_at DESC);

-- ---------------- SIMULATED RF system accounts ----------------
-- (daily pools, system:pool:<day>, are created on first entry)
INSERT INTO users (did) VALUES ('system:burn'), ('system:faucet'), ('system:escrow') ON CONFLICT (did) DO NOTHING;
