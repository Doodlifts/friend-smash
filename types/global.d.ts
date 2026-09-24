/* Ambient globals shared between the engine (components/engine.ts) and the
   React controllers (AuthBar, RunController). */

export {};

interface RfSmashRun {
  /** Returns a prefetched server-sanctioned run and clears it (sync). */
  takeRun: () => { seed: number; runId: string; runToken: string; config?: unknown } | null;
  /** Fire-and-forget submission of a finished run for authoritative scoring. */
  finish: (payload: {
    runId: string;
    runToken: string;
    seed: number;
    summary: unknown;
    log: unknown;
    clientScore: number;
  }) => void;
  /** Fire-and-forget report of a quit/restarted run so used power-ups are
   *  consumed server-side (no score). `beacon` = page teardown: cached token
   *  + keepalive fetch + minimal (powerup-only) log. */
  abandon: (payload: { runId: string; runToken: string; log: unknown; beacon?: boolean }) => void;
  /** Fire-and-forget USE-TIME power-up settlement ({key, n} with n = the
   *  cumulative uses of `key` this run). Idempotent server-side; finish/
   *  abandon reconcile anything this misses. */
  consume: (payload: { runId: string; runToken: string; key: string; n: number }) => void;
}

interface RfSmashMatch {
  /** True once the wallet session is ready and the player is signed in. */
  authed: () => boolean;
  /** Start/stop the 2s match-state poll (lobby open or match live). */
  start: () => void;
  stop: () => void;
  /** Last polled MatchView (see lib/match.ts), or null before the first poll. */
  latest: () => any;
  /** Server-corrected clock (Date.now() + poll offset) — round timing uses this. */
  now: () => number;
  /** Join the queue at a wager tier; resolves {state:'queued'|'matched'|'error', error?}. */
  queue: (wager: number) => Promise<{ state: string; error?: string }>;
  /** Leave the queue (no refund needed — escrow only happens at pairing). */
  cancel: () => Promise<void>;
  /** Throttled live-score tick (display only). */
  heartbeat: (matchId: string, round: number, score: number) => void;
  /** Keepalive + retry + stash delivery of my side of the round. */
  finishRound: (payload: { matchId: string; runId: string; runToken: string; summary: unknown; log: unknown }) => void;
  /** TURF WAR: submit my turn (idempotent on moveN); resolves the place
   *  result with a fresh view attached, or null after retries failed. */
  place: (payload: { matchId: string; moveN: number; t: string; r: number; x: number; y: number; rulesV: number }) => Promise<any>;
  /** Ready-up: flag me ready; resolves true when accepted. */
  ready: (matchId: string) => Promise<boolean>;
  /** Concede the match — opponent takes the pot. */
  concede: (matchId: string) => Promise<void>;
}

declare global {
  interface Window {
    /** Run-lifecycle bridge set by RunController (auth tree) and read by the engine. */
    __RFSMASH_RUN?: RfSmashRun;
    /** VERSUS bridge set by MatchController (auth tree) and read by the engine. */
    __RFSMASH_MATCH?: RfSmashMatch;
    /** Engine test/debug hook (set by startEngine). */
    __DS?: any;
  }
}
