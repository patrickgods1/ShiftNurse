import type { Id, IsoDate } from '@shiftnurse/core';

/** Options shared by the demo and test-scenario seeders. */
export interface SeedOptions {
  /** PRNG seed. Same seed, same database. */
  seed?: number;
  /** The "current" date the dataset is built around. Defaults to the host clock. */
  today?: IsoDate;
  /** Whole pay periods of history to generate. */
  historyPeriods?: number;
}

export interface SeedResult {
  unitId: Id;
  draftPeriodId: Id;
  draftStart: IsoDate;
  draftEnd: IsoDate;
  counts: Record<string, number>;
}
