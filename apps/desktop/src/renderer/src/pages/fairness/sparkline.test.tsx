// @vitest-environment jsdom
/** The trend line sits on a fixed 0-100 axis so a one-point change does not look like a collapse. */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sparkline } from './sparkline.js';

afterEach(cleanup);

const pathOf = (container: HTMLElement) => container.querySelector('path')?.getAttribute('d');

describe('score sparkline', () => {
  it('draws a one-point rise as a small step, not a full-height climb', () => {
    const { container } = render(<Sparkline values={[98, 99]} />);
    expect(pathOf(container)).toBe('M3.0,3.4 L93.0,3.2');
  });

  it('draws a real climb from 20 to 99 as a long one', () => {
    const { container } = render(<Sparkline values={[20, 99]} />);
    expect(pathOf(container)).toBe('M3.0,20.6 L93.0,3.2');
  });
});
