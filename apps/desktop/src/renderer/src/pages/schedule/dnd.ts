/**
 * Native HTML5 drag-and-drop envelope for the schedule grid.
 *
 * No DnD library is used (see the milestone brief) — `draggable`/`onDragStart`/`onDrop` only.
 * A drag either **moves** an existing assignment (picked up off a chip) or **creates** one
 * (picked up off the shift-type palette); every drop target decodes the same envelope and
 * branches on `kind` rather than having two separate wire formats to keep in sync.
 */

import type { Id } from '@shiftnurse/core';
import type { DragEvent } from 'react';

export type DragPayload =
  | { kind: 'move'; assignmentId: Id; shiftTypeId: Id }
  | { kind: 'create'; shiftTypeId: Id };

const DND_MIME = 'application/x-shiftnurse-assignment';

export function setDragPayload(event: DragEvent<HTMLElement>, payload: DragPayload): void {
  event.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = 'move';
}

/**
 * Only readable in `onDrop` (browsers withhold drag data during `dragover`/`dragenter` for
 * security), which is fine — cells only need to *allow* a drop during hover, and decode what
 * was actually dropped once it lands.
 */
export function readDragPayload(event: DragEvent<HTMLElement>): DragPayload | undefined {
  const raw = event.dataTransfer.getData(DND_MIME);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return undefined;
  }
}
