/**
 * The realistic demo units offered on the welcome screen, and how to seed one.
 *
 * Each is a `DemoProfile` (`demo/profiles.ts`) run through one engine (`demo/engine.ts`). The
 * summaries here are what the welcome screen lists, so a manager can pick the unit that looks
 * most like their own. The rigged dataset the tests are built on is `scenarios.ts`, not these.
 */

import type { DbLike } from '../client.js';
import { type DemoProfile, seedFromProfile } from './demo/engine.js';
import { CA_ICU, COMMUNITY_MED_SURG, DEMO_PROFILES, VA_SF_MED_SURG } from './demo/profiles.js';
import type { SeedOptions, SeedResult } from './types.js';

export type { DemoProfile } from './demo/engine.js';
export { CA_ICU, COMMUNITY_MED_SURG, VA_SF_MED_SURG } from './demo/profiles.js';

export type DemoId = (typeof DEMO_PROFILES)[number]['id'];

export const DEFAULT_DEMO_ID: DemoId = 'community-med-surg';

/** One entry in the welcome screen's list of demo units. */
export interface DemoSummary {
  id: DemoId;
  name: string;
  /** Where a unit like this is found. */
  setting: string;
  summary: string;
  /** What makes this unit's rules and operations different, one line each. */
  highlights: string[];
}

export const DEMO_SUMMARIES: readonly DemoSummary[] = [
  {
    id: 'community-med-surg',
    name: COMMUNITY_MED_SURG.unit.name,
    setting: 'Community hospital · adult medical-surgical · 28 beds',
    summary:
      'The most common inpatient unit: 49 RNs and CNAs on 12-hour days and nights, with travelers and per-diem staff covering the gaps.',
    highlights: [
      '12-hour day and night shifts, six-week schedules',
      'RN ratios 1:5 / 1:4 / 1:3 by acuity',
      'Seniority step pay; flat night, weekend and charge differentials',
      'Overtime after 40 hours a week; six hospital holidays',
    ],
  },
  {
    id: 'va-sf-med-surg',
    name: VA_SF_MED_SURG.unit.name,
    setting: 'VA medical center, San Francisco · medicine-surgery ward · 24 beds',
    summary:
      'A federal ward run on VA practice: 8-hour day, evening and night tours, RNs with LVNs and nursing assistants, staffed to nursing hours per patient day.',
    highlights: [
      '8-hour tours (07:30, 15:30, 23:30) on the federal pay calendar, four-week schedules',
      'No legislated ratios: VHA staffs to nursing hours per patient day (Directive 1351)',
      'Title 38 pay: 10% night differential, 25% weekend premium, double-time holidays',
      'Overtime after 8 hours a day or 40 a week; all 11 federal holidays',
    ],
  },
  {
    id: 'ca-icu',
    name: CA_ICU.unit.name,
    setting: 'California community hospital · intensive care · 12 beds',
    summary:
      'A critical-care unit where ratios are law: two patients per nurse at most, one when a patient is unstable.',
    highlights: [
      'California Title 22 ratios: ICU 1:2, critical 1:1',
      'All-RN care with one ICU technician; ACLS for every RN, four per shift',
      '12-hour alternative workweek: overtime after 12 hours a day or 40 a week',
      'Critical-care pay scale and CCRN certifications',
    ],
  },
];

export function isDemoId(value: string): value is DemoId {
  return DEMO_PROFILES.some((p) => p.id === value);
}

/** Seed one demo unit: the community med-surg unit unless another is named. */
export function seedDemoUnit(
  db: DbLike,
  options: SeedOptions & { demo?: DemoId } = {},
): SeedResult {
  const id = options.demo ?? DEFAULT_DEMO_ID;
  const profile: DemoProfile | undefined = DEMO_PROFILES.find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown demo unit "${id}"`);
  return seedFromProfile(db, profile, options);
}
