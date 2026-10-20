// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Column, DataTable } from './data-table.js';

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  employeeId: string;
}

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sortValue: (r) => r.name },
  {
    key: 'employeeId',
    header: 'Employee ID',
    render: (r) => r.employeeId,
    sortValue: (r) => r.employeeId,
  },
  { key: 'note', header: 'Note', render: () => 'ok' },
];

const row = (name: string, employeeId: string): Row => ({ id: employeeId, name, employeeId });

/** Text of one cell (default the first) of each body row, in display order. */
function order(cell = 0): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((tr) => tr.querySelectorAll('td')[cell]?.textContent ?? '');
}

describe('DataTable', () => {
  it('sorts employee E9 before E10, the way a person reads them', () => {
    const rows = [row('A', 'E10'), row('B', 'E9'), row('C', 'E2')];
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole('button', { name: /Employee ID/ }));
    expect(order(1)).toEqual(['E2', 'E9', 'E10']);
  });

  it('sorts an accented surname with the plain letters', () => {
    const rows = [row('Zimmer', 'E1'), row('Ödegaard', 'E2'), row('Adams', 'E3')];
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} initialSortKey="name" />);
    expect(order()).toEqual(['Adams', 'Ödegaard', 'Zimmer']);
  });

  it('tells a screen reader which column is sorted and which way', () => {
    const rows = [row('Adams', 'E1'), row('Baker', 'E2')];
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} initialSortKey="name" />);
    const th = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) });
    expect(th('Name').getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(th('Name').getAttribute('aria-sort')).toBe('descending');
    expect(th('Employee ID').getAttribute('aria-sort')).toBe('none');
    expect(th('Note').hasAttribute('aria-sort')).toBe(false);
  });

  it("keeps a clickable roster row's cells as table cells", () => {
    const rows = [row('Adams', 'E1'), row('Baker', 'E2')];
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={() => {}} />);
    expect(screen.getAllByRole('row')[1]?.hasAttribute('role')).toBe(false);
    expect(screen.getAllByRole('cell')).toHaveLength(rows.length * columns.length);
  });

  it('opens a nurse through the name button', () => {
    const rows = [row('Adams', 'E1'), row('Baker', 'E2')];
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={onRowClick}
        rowLabel={(r) => `Open ${r.name}`}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Adams' }));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);

    onRowClick.mockClear();
    fireEvent.click(screen.getAllByRole('cell')[1]!);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  it('keeps nurses with the same employee ID in the order they were listed', () => {
    const rows = [
      { id: 'a', name: 'Zed', employeeId: 'E5' },
      { id: 'b', name: 'Amy', employeeId: 'E5' },
      { id: 'c', name: 'Moe', employeeId: 'E5' },
    ];
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole('button', { name: /Employee ID/ }));
    expect(order()).toEqual(['Zed', 'Amy', 'Moe']);
  });

  it('sorts a column that mixes numbers and text as text', () => {
    // '10' vs 'abc' compare as strings; numeric collation puts 2 before 10 before abc.
    const mixed: Column<{ id: string; v: string | number }>[] = [
      { key: 'v', header: 'Value', render: (r) => String(r.v), sortValue: (r) => r.v },
    ];
    const rows = [
      { id: '1', v: 'abc' },
      { id: '2', v: 10 },
      { id: '3', v: 2 },
    ];
    render(<DataTable columns={mixed} rows={rows} rowKey={(r) => r.id} initialSortKey="v" />);
    expect(order()).toEqual(['2', '10', 'abc']);
  });

  it('says so when there is nothing to show', () => {
    render(
      <DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyLabel="No nurses match." />,
    );
    expect(screen.getByText('No nurses match.')).toBeTruthy();
  });
});
