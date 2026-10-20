// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InfoTip, TipProvider } from './field-help.js';

afterEach(cleanup);

describe('InfoTip', () => {
  it('the ⓘ tip is a 24-pixel target', () => {
    render(
      <TipProvider>
        <InfoTip label="Minimum rest">Hours between shifts.</InfoTip>
      </TipProvider>,
    );
    // jsdom has no layout, so the target size can only be pinned through its classes:
    // Tailwind h-6/w-6 are 1.5rem = 24px (WCAG 2.2 SC 2.5.8).
    const classes = screen.getByRole('button', { name: 'About Minimum rest' }).className.split(' ');
    expect(classes).toContain('h-6');
    expect(classes).toContain('w-6');
  });
});
