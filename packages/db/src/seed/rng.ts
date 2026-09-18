/**
 * A small seeded pseudo-random number generator for the demo data seeder.
 *
 * ## Why determinism matters here
 *
 * The demo dataset is not just a pile of plausible-looking rows — it is the fixture golden-file
 * solver tests run against, and it is what a developer stares at after making a change to ask
 * "did my change do that, or did the data just happen to look different this time?" `Math.random()`
 * answers neither question: two runs would produce different rosters, different historical
 * schedules and different census numbers, so a diff in solver output could never be attributed to
 * the code change versus the data change, and a golden file compared against yesterday's seed
 * would fail for no reason connected to a regression.
 *
 * A seeded PRNG makes "run the seeder twice, get byte-identical output" true by construction. It
 * also means the *shape* of the randomness (which nurses become night-shift regulars, which
 * weekend gets the pending-request pile-up) is reviewable and reproducible rather than a fresh
 * roll every time someone runs `npm run seed:demo`.
 *
 * This is mulberry32: a 32-bit state, integer-only, xorshift-style generator. It is not
 * cryptographically secure and must never be used for anything security-sensitive — it exists
 * solely to turn one integer seed into a long, well-distributed, exactly-repeatable sequence of
 * floats for building demo data.
 */

/** One float in `[0, 1)` from a 32-bit state, per call. */
type FloatSource = () => number;

/** The mulberry32 step function. Pure and side-effect-free on everything but the closed-over state. */
function mulberry32(seed: number): FloatSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A weighted candidate for {@link Rng.weightedPick}. */
export interface WeightedEntry<T> {
  readonly value: T;
  /** Relative weight. Must be positive; entries are drawn proportionally to this. */
  readonly weight: number;
}

/**
 * A deterministic source of every random choice the seeder makes. Every call advances the
 * internal state, so the *order* choices are made in is part of what determinism captures —
 * reordering seeder logic changes the resulting dataset even with the same seed, which is
 * expected and is exactly why the seeder's structure, once settled, should not be reshuffled
 * casually.
 */
export class Rng {
  private readonly next: FloatSource;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** A float in `[0, 1)`. The primitive every other method is built from. */
  nextFloat(): number {
    return this.next();
  }

  /** An integer in `[min, max]`, inclusive on both ends. */
  nextInt(min: number, max: number): number {
    if (max < min) throw new RangeError(`nextInt: max (${max}) is less than min (${min})`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** A boolean that is `true` with probability `p` (default 0.5). */
  chance(p = 0.5): boolean {
    return this.next() < p;
  }

  /** One uniformly random element. Throws on an empty array — there is nothing sensible to return. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick: array is empty');
    const item = items[this.nextInt(0, items.length - 1)];
    // items.length was checked above, so this index is always in range.
    return item as T;
  }

  /** One element drawn proportionally to weight. Weights need not sum to 1. */
  weightedPick<T>(entries: readonly WeightedEntry<T>[]): T {
    if (entries.length === 0) throw new RangeError('weightedPick: no entries');
    const total = entries.reduce((sum, e) => sum + e.weight, 0);
    if (!(total > 0)) throw new RangeError('weightedPick: total weight must be positive');
    let roll = this.next() * total;
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll <= 0) return entry.value;
    }
    // Floating-point rounding can leave `roll` fractionally positive after the last subtraction;
    // the last entry is the correct answer in that case.
    const last = entries[entries.length - 1];
    return (last as WeightedEntry<T>).value;
  }

  /** Fisher-Yates shuffle. Returns a new array; the input is left untouched. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }
}
