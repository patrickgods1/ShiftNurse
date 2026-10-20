// @vitest-environment jsdom
import type { BacktestResult, ErrorSummary } from '@shiftnurse/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BacktestPanel } from './backtest-panel.js';

afterEach(cleanup);

const summary = (mae: number): ErrorSummary => ({
  samples: 5,
  meanAbsoluteError: mae,
  meanAbsolutePercentageError: 10,
  bias: 0,
});

function result(recorded: number, model: number): BacktestResult {
  return { recorded: summary(recorded), model: summary(model), byShiftType: {} };
}

describe('the forecast back-test verdict', () => {
  it('calls a tie a tie', () => {
    // 1.04 and 0.96 both print as 1.0 at one decimal.
    render(<BacktestPanel result={result(1.04, 0.96)} shiftTypesById={new Map()} />);
    expect(screen.getByText(/about as accurate/)).toBeTruthy();
    expect(screen.queryByText(/beat/)).toBeNull();
  });

  it('says the model wins when it is clearly closer', () => {
    render(<BacktestPanel result={result(2.5, 1.5)} shiftTypesById={new Map()} />);
    expect(screen.getByText(/The model beats the recorded forecasts/)).toBeTruthy();
  });

  it('says the manager wins when the recorded forecasts are clearly closer', () => {
    render(<BacktestPanel result={result(1.5, 2.5)} shiftTypesById={new Map()} />);
    expect(screen.getByText(/The recorded forecasts beat the model/)).toBeTruthy();
  });
});
