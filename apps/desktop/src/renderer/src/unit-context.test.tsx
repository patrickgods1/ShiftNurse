// @vitest-environment jsdom
/**
 * Which unit the whole app works on. A VA install lists a float sibling beside the home unit,
 * and the app once opened whichever name sorted first, so renaming the home unit handed every
 * page to the sibling.
 */

import type { Unit } from '@shiftnurse/core';
import { isoDate } from '@shiftnurse/core';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from './test/fake-bridge.js';
import { renderWithApp } from './test/render.js';
import { UnitProvider, useUnit } from './unit-context.js';

function ShowName() {
  return <p>{useUnit().name}</p>;
}

const unitNamed = (id: string, name: string): Unit => ({
  id,
  name,
  unitType: 'Medical-Surgical',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
});

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('the unit the app opens', () => {
  it('renaming the home unit keeps it open when a float unit sorts first', async () => {
    const homeUnit = unitNamed('unit-4a', 'Medicine-Surgery 4A');
    const floatUnit = unitNamed('unit-4b', '4B Telemetry');
    bridge.respond('units', 'home', homeUnit);
    bridge.respond('units', 'list', [floatUnit, homeUnit]);

    renderWithApp(
      <UnitProvider>
        <ShowName />
      </UnitProvider>,
    );

    expect(await screen.findByText('Medicine-Surgery 4A')).toBeTruthy();
    expect(screen.queryByText('4B Telemetry')).toBeNull();
  });
});
