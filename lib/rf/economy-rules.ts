/* ============================================================
   lib/rf/economy-rules.ts — every RF number in the game, in one place.

   Units: 1 unit = 1 RF (see lib/rf/format.ts). All SIMULATED.
   These are the exact terms published in the vibeathon submission README.
   ============================================================ */

/** Ranked daily pool: price of ONE ranked run. */
export const POOL_ENTRY = 50; // 50 RF
/** Of each entry: this much funds today's prize pool… */
export const POOL_SHARE = 40; // 40 RF (80%)
/** …and this much is burned forever. */
export const POOL_BURN = POOL_ENTRY - POOL_SHARE; // 10 RF (20%)

/** Paid places per daily pool (top-heavy linear split, remainder to #1). */
export const POOL_PAID_PLACES = 10;
/**
 * A day's pool settles this long after 00:00 UTC closes it, so ranked runs
 * entered just before midnight can still finish (run tokens live 2h).
 */
export const POOL_SETTLE_GRACE_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;
/** Ranked entries must be claimed within this long of the run opening. */
export const POOL_ENTRY_WINDOW_MS = 10 * 60 * 1000;

/** Versus wagers: share of the pot burned on a decisive result (draws/aborts refund in full). */
export const VERSUS_RAKE_BPS = 500; // 5%

/** Power-ups (practice + versus only): 100% of the price is burned. */
export const POWERUP_BURN_BPS = 10_000;

/**
 * Power-up UNLOCKS by REAL $RAREFRIENDS held in the Friend's own wallet (its
 * token-bound account, read on-chain; never moved). Buying the power-up still
 * costs SIMULATED RF. Whole RF.
 */
export const POWERUP_UNLOCK_RF: Record<string, number> = {
  next_peek: 1_000, // Friend Radar
  slow_fall: 10_000, // Nap Time
  reroll: 50_000, // Swap Friend
  bomb: 100_000, // Pixel Bomb
};

/** Simulated faucet — stands in for buying RF on the market. */
export const STARTER_GRANT = 1_000; // 1,000 RF, once per Friend
export const DAILY_GRANT = 100; // 100 RF per UTC day (DAILY_BONUS_ENABLED=1)

/** UTC day key, e.g. "2026-09-22". */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function nextUtcDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDay(d);
}

/** When a day's pool closes to new entries (next 00:00 UTC). */
export function poolClosesAt(day: string): Date {
  return new Date(`${nextUtcDay(day)}T00:00:00.000Z`);
}

/** When a day's pool pays out. */
export function poolSettlesAt(day: string): Date {
  return new Date(poolClosesAt(day).getTime() + POOL_SETTLE_GRACE_MS);
}

/** Rake on a versus pot of 2×wager, rounded down (never exceeds the pot). */
export function versusRake(wager: number): number {
  return Math.floor((wager * 2 * VERSUS_RAKE_BPS) / 10_000);
}
