/* ============================================================
   lib/gameConfig.ts — admin-tunable game configuration.

   One JSON document in the `game_config` table (single row, id=1) that the
   owner edits from /admin — so gameplay numbers can be tuned without code
   changes. Everything is sanitized into hard bounds on read AND write, so a
   bad value can never brick the game or the replay.

   REPLAY RULE: anything that affects scoring/board state (the bonus tuning)
   is SNAPSHOT onto each run row at run start (runs.config). The replay uses
   the snapshot, never the live config — tuning changes apply to NEW runs only.
   Cosmetic values (gore intensity) and server-only values (item drops) don't
   need snapshots.
   ============================================================ */

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "./db";
import { gameConfig } from "@/db/schema";
import { sanitizeBonus, type BonusTuning, DEFAULT_BONUS, BONUS_ALGO_V } from "./bonus";
import { SCORING_ALGO_V } from "./scoring";

export interface GoreTuning {
  /** 0.25–2 multiplier on droplet/bone counts (cosmetic only). */
  intensity: number;
}
export interface DropTuning {
  enabled: boolean;
  /** Chance (0–0.5) of a power-up drop on a qualifying verified run. */
  rate: number;
  /** Minimum verified score to qualify for a drop roll. */
  minScore: number;
}

/** Scoring rules that can change over time; per-run snapshots pin `v`. */
export interface ScoringTuning {
  /** Algorithm version the run was PLAYED under (see SCORING_ALGO_V). */
  v: number;
}

export interface GameConfig {
  bonus: BonusTuning;
  gore: GoreTuning;
  drops: DropTuning;
  scoring: ScoringTuning;
}

export const DEFAULT_CONFIG: GameConfig = {
  bonus: { ...DEFAULT_BONUS },
  gore: { intensity: 1 },
  drops: { enabled: true, rate: 0.05, minScore: 300 },
  scoring: { v: SCORING_ALGO_V },
};

const clampNum = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

/** Sanitize an arbitrary (admin-supplied / DB-loaded) doc into a valid config. */
export function sanitizeConfig(raw: unknown): GameConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<GameConfig>;
  const gore = (r.gore ?? {}) as Partial<GoreTuning>;
  const drops = (r.drops ?? {}) as Partial<DropTuning>;
  // Like bonus.v, the LIVE scoring version is CODE-OWNED — a stored value must
  // never pin production to an old algorithm. Snapshots keep theirs (see
  // sanitizeScoring below, used by the replay path).
  return {
    // The LIVE config's algorithm version is CODE-OWNED: a stored/echoed `v`
    // must never pin production to an old algorithm (the previous deploy
    // persisted v into game_config on every admin save — without this
    // override, bumping BONUS_ALGO_V would silently never activate). Only
    // per-run SNAPSHOTS keep their played version (sanitizeBonus(...,
    // {snapshot:true}) in the replay path).
    bonus: { ...sanitizeBonus(r.bonus), v: BONUS_ALGO_V },
    scoring: { v: SCORING_ALGO_V },
    gore: { intensity: clampNum(gore.intensity, 0.25, 2, DEFAULT_CONFIG.gore.intensity) },
    drops: {
      enabled: typeof drops.enabled === "boolean" ? drops.enabled : DEFAULT_CONFIG.drops.enabled,
      rate: clampNum(drops.rate, 0, 0.5, DEFAULT_CONFIG.drops.rate),
      minScore: Math.trunc(clampNum(drops.minScore, 0, 1_000_000, DEFAULT_CONFIG.drops.minScore)),
    },
  };
}

/** Load the live config (defaults when the row doesn't exist yet). */
export async function getGameConfig(db: DrizzleDb): Promise<GameConfig> {
  const [row] = await db.select().from(gameConfig).where(eq(gameConfig.id, 1)).limit(1);
  return sanitizeConfig(row?.data);
}

/** Overwrite the config (sanitized). Returns what was stored. */
export async function setGameConfig(db: DrizzleDb, raw: unknown): Promise<GameConfig> {
  const cfg = sanitizeConfig(raw);
  await db
    .insert(gameConfig)
    .values({ id: 1, data: cfg, updatedAt: new Date() })
    .onConflictDoUpdate({ target: gameConfig.id, set: { data: cfg, updatedAt: new Date() } });
  return cfg;
}

/** The subset the CLIENT engine needs (safe to expose publicly). Item-drop
 *  odds stay server-side. */
export function publicConfig(cfg: GameConfig): {
  bonus: BonusTuning;
  gore: GoreTuning;
  scoring: ScoringTuning;
} {
  // `scoring` MUST ride along: unranked play reads this endpoint, and without
  // it free games would silently score under the OLD algorithm while ranked
  // runs (which get a snapshot from /api/run/start) used the new one.
  return { bonus: cfg.bonus, gore: cfg.gore, scoring: cfg.scoring };
}

/**
 * Sanitize a per-run scoring SNAPSHOT for replay. A missing/invalid `v` means
 * the run predates snapshotting and was therefore PLAYED under v1 — it must be
 * re-scored under v1, or historical scores would silently change.
 */
export function sanitizeScoring(raw: unknown): ScoringTuning {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ScoringTuning>;
  const v = typeof r.v === "number" && Number.isFinite(r.v) ? Math.floor(r.v) : 1;
  return { v: Math.min(SCORING_ALGO_V, Math.max(1, v)) };
}
