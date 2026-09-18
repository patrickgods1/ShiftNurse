/**
 * Shift-type chips a manager drags straight onto a cell to create an assignment. It shows the
 * same colour/abbreviation as a grid chip so the palette and the grid read as one visual
 * vocabulary rather than the palette being a separate little legend.
 */

import type { ShiftType } from '@shiftnurse/core';
import { useMemo } from 'react';
import { readableTextColor } from './colors.js';
import { setDragPayload } from './dnd.js';

interface ShiftPaletteProps {
  shiftTypes: readonly ShiftType[];
  readOnly: boolean;
}

export function ShiftPalette({ shiftTypes, readOnly }: ShiftPaletteProps) {
  const active = useMemo(
    () => [...shiftTypes].filter((st) => st.active).sort((a, b) => a.sortOrder - b.sortOrder),
    [shiftTypes],
  );

  if (active.length === 0) return null;

  return (
    <div
      data-testid="shift-palette"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-2"
    >
      <span className="text-xs font-medium text-text-muted">
        {readOnly ? 'Published — drag disabled' : 'Drag onto the grid to add a shift:'}
      </span>
      {active.map((shiftType) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: native HTML5 DnD only, same as the grid's own drop targets — see grid.tsx.
        <div
          key={shiftType.id}
          draggable={!readOnly}
          onDragStart={(event) => {
            if (readOnly) {
              event.preventDefault();
              return;
            }
            setDragPayload(event, { kind: 'create', shiftTypeId: shiftType.id });
          }}
          title={`${shiftType.name} · ${shiftType.durationHours}h${
            shiftType.isNight ? ' · night' : ''
          }`}
          className={`flex h-7 items-center rounded px-2 text-xs font-semibold ${
            readOnly ? 'cursor-not-allowed opacity-50' : 'cursor-grab active:cursor-grabbing'
          }`}
          style={{ backgroundColor: shiftType.color, color: readableTextColor(shiftType.color) }}
        >
          {shiftType.abbreviation}
        </div>
      ))}
    </div>
  );
}
