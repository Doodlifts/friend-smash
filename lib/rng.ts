/* ============================================================
   lib/rng.ts — seeded PRNG + 7-bag piece generator.

   SHARED between client and server. The whole anti-cheat model
   depends on this being deterministic: given the same seed, the
   client and the server's replay MUST produce the exact same
   piece sequence. Do not introduce Math.random() or any other
   nondeterminism here.
   ============================================================ */

/** The 7 tetromino types, in canonical bag order (matches the engine's TYPES). */
export const BAG_TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'] as const;
export type PieceType = (typeof BAG_TYPES)[number];

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG.
 * Returns a function yielding floats in [0, 1). Deterministic for a given seed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * SevenBag — the standard 7-bag randomizer, driven by a seeded PRNG.
 *
 * Mirrors the original engine's refillBag(): a Fisher-Yates shuffle of the
 * seven types, refilled whenever empty. The ONLY change from the original is
 * that the random source is the seeded PRNG instead of Math.random(), so the
 * sequence is reproducible.
 */
export class SevenBag {
  private rng: () => number;
  private bag: PieceType[] = [];

  constructor(seed: number) {
    this.rng = mulberry32(seed >>> 0);
  }

  private refill(): void {
    const b = BAG_TYPES.slice() as PieceType[];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    this.bag.push(...b);
  }

  /** Draw the next piece type. */
  next(): PieceType {
    if (!this.bag.length) this.refill();
    return this.bag.shift() as PieceType;
  }

  /** Peek the next `count` upcoming types without consuming the draw state. */
  preview(count: number): PieceType[] {
    while (this.bag.length < count) this.refill();
    return this.bag.slice(0, count);
  }
}

/**
 * Generate a fresh non-cryptographic seed for a local (offline) run.
 * In server-issued runs the seed comes from the server instead; this is only
 * used when the client plays without a sanctioned run token (Phase 0/1).
 */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}
