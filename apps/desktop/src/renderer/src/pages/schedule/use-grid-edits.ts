/**
 * Every way the manager changes the grid: drop, move, lock, charge, overtime, remove, swap. Holds
 * the in-flight bookkeeping (chips dimmed while their write runs, ghosts standing in for a shift
 * that has not landed yet) and the reason gate a published period puts in front of each edit.
 * One home, so the handlers keep stable identities for the memoised grid rows and a change to
 * how edits work does not mean reading the whole page.
 *
 * Each successful edit also records its inverse and offers it as an "Undo" toast, and Ctrl/Cmd-Z
 * runs the latest. The inverse is built from the rows the board already holds, taken just before
 * the edit runs, plus what the mutation returned: a move is delete + create on the server, so the
 * moved shift has a new id and undoing it means moving *that* id back. Running an inverse never
 * records another entry (undo is not redo), and one that fails — the row changed or went in the
 * meantime — surfaces through `failedEdit` like any edit and is simply dropped.
 */

import type { Assignment, Id, IsoDate, Nurse, SchedulePeriod, ShiftType } from '@shiftnurse/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useCreateAssignment,
  useDeleteAssignment,
  useMoveAssignment,
  useSetLocked,
  useSwapAssignments,
  useUpdateAssignment,
} from '../../api-schedule.js';
import { useConfirm } from '../../components/confirm.js';
import { useToast } from '../../components/toast.js';
import { formatDateWithWeekday } from '../../format.js';
import { makePendingId } from './grid-utils.js';

interface GridEditsArgs {
  period: SchedulePeriod;
  unitId: Id;
  readOnly: boolean;
  published: boolean;
  /** The unit asks for the nurse's recorded agreement before a posted shift is changed. */
  requireConsent?: boolean;
  /** The grid's current rows: where a shift stood before an edit is what its undo restores. */
  assignments: readonly Assignment[] | undefined;
  /** Names for the undo toast; a lookup that misses reads as a generic phrase, not an error. */
  nurses: readonly Nurse[] | undefined;
  shiftTypes: readonly ShiftType[] | undefined;
  /** Called when a removal starts, so the board can close the popover of the shift going away. */
  onRemoveStart?: () => void;
}

const MAX_UNDO = 20;

interface UndoEntry {
  /** Runs the inverse edit. `reason` is already "Undo: …" on a published period. */
  inverse: (reason: string | undefined) => void;
  reason: string | undefined;
  toastId: string | undefined;
}

/** Whether a keystroke belongs to a text field: Ctrl-Z there is the field's own undo. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  // jsdom has no `isContentEditable`, so the attribute is checked as well.
  const editable = target.closest('[contenteditable]');
  return (
    target.isContentEditable === true ||
    (editable !== null && editable.getAttribute('contenteditable') !== 'false')
  );
}

/**
 * Per-call work for one edit: `onSuccess` with the result, then `cleanup` whatever happened.
 * The rejection is swallowed on purpose — the mutation hook has already put it in `failedEdit`
 * (`meta.inlineError`), and an unhandled rejection would only add a console error.
 */
function settle<T>(
  call: Promise<T>,
  onSuccess: ((result: T) => void) | undefined,
  cleanup: (() => void) | undefined,
): void {
  call
    .then(
      (result) => {
        onSuccess?.(result);
      },
      () => {},
    )
    .finally(cleanup);
}

function makeGhost(
  periodId: Id,
  input: { nurseId: Id; date: IsoDate; shiftTypeId: Id },
): Assignment {
  return {
    id: makePendingId(),
    periodId,
    nurseId: input.nurseId,
    shiftTypeId: input.shiftTypeId,
    date: input.date,
    source: 'manual',
    isLocked: false,
    isCharge: false,
    isOvertime: false,
  };
}

export function useGridEdits({
  period,
  unitId,
  readOnly,
  published,
  requireConsent = false,
  assignments,
  nurses,
  shiftTypes,
  onRemoveStart,
}: GridEditsArgs) {
  const confirm = useConfirm();
  const toast = useToast();
  const createAssignment = useCreateAssignment(period.id, unitId);
  const moveAssignment = useMoveAssignment(period.id, unitId);
  const updateAssignment = useUpdateAssignment(period.id, unitId);
  const deleteAssignment = useDeleteAssignment(period.id, unitId);
  const swapAssignments = useSwapAssignments(period.id, unitId);
  const setLocked = useSetLocked(period.id, unitId);
  // The handlers below depend on `mutateAsync`, which TanStack keeps stable (it is the observer's
  // own bound method), not on the mutation objects, which change identity with every state
  // change and would re-render every grid row. Async, because per-call callbacks passed to
  // `mutate` fire only for the latest call: a second drag before the first settled left the
  // first one's ghost on the grid for good and its undo unrecorded.
  const createMutate = createAssignment.mutateAsync;
  const moveMutate = moveAssignment.mutateAsync;
  const updateMutate = updateAssignment.mutateAsync;
  const deleteMutate = deleteAssignment.mutateAsync;
  const lockMutate = setLocked.mutateAsync;
  const swapMutate = swapAssignments.mutateAsync;

  // Refs, not dependencies: the handlers must keep their identity as rows arrive, or every grid
  // row re-renders on every edit. They are read when an edit runs, which is when they matter.
  const assignmentsRef = useRef(assignments);
  assignmentsRef.current = assignments;
  const nursesRef = useRef(nurses);
  nursesRef.current = nurses;
  const shiftTypesRef = useRef(shiftTypes);
  shiftTypesRef.current = shiftTypes;
  const undoStack = useRef<UndoEntry[]>([]);

  const [pendingIds, setPendingIds] = useState<ReadonlySet<Id>>(new Set());
  const [pendingCreates, setPendingCreates] = useState<readonly Assignment[]>([]);
  /** An edit waiting on its reason. Set only on a published period. */
  const [pendingEdit, setPendingEdit] = useState<
    | { title: string; run: (reason: string | undefined, consent: string | undefined) => void }
    | undefined
  >(undefined);

  // On a draft the edit runs at once; on a published period it waits for the reason dialog.
  const withReason = useCallback(
    (title: string, run: (reason: string | undefined, consent: string | undefined) => void) => {
      if (published) setPendingEdit({ title, run });
      else run(undefined, undefined);
    },
    [published],
  );

  const markPending = useCallback((id: Id) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const clearPending = useCallback((id: Id) => {
    setPendingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const heldAssignment = useCallback(
    (id: Id) => assignmentsRef.current?.find((a) => a.id === id),
    [],
  );
  const nurseName = useCallback((id: Id) => {
    const nurse = nursesRef.current?.find((n) => n.id === id);
    return nurse ? `${nurse.firstName} ${nurse.lastName}` : 'a nurse';
  }, []);
  const shiftName = useCallback(
    (id: Id) => shiftTypesRef.current?.find((st) => st.id === id)?.name ?? 'a shift',
    [],
  );

  const undoEntry = useCallback(
    (entry: UndoEntry) => {
      const at = undoStack.current.indexOf(entry);
      // Already undone, pushed off the end, or cleared by a saved Generate: nothing to reverse.
      if (at === -1) return;
      undoStack.current = undoStack.current.filter((e) => e !== entry);
      if (entry.toastId !== undefined) toast.dismiss(entry.toastId);
      entry.inverse(entry.reason === undefined ? undefined : `Undo: ${entry.reason}`);
    },
    [toast],
  );
  const undoLatest = useCallback(() => {
    const latest = undoStack.current[undoStack.current.length - 1];
    if (latest) undoEntry(latest);
  }, [undoEntry]);
  const clearUndo = useCallback(() => {
    // Their toasts go too: an Undo button that does nothing reads as a broken one.
    for (const entry of undoStack.current) {
      if (entry.toastId !== undefined) toast.dismiss(entry.toastId);
    }
    undoStack.current = [];
  }, [toast]);

  const record = useCallback(
    (message: string, reason: string | undefined, inverse: UndoEntry['inverse']) => {
      const entry: UndoEntry = { inverse, reason, toastId: undefined };
      undoStack.current = [...undoStack.current, entry].slice(-MAX_UNDO);
      entry.toastId = toast.show({
        message,
        action: { label: 'Undo', onClick: () => undoEntry(entry) },
      });
    },
    [toast, undoEntry],
  );

  // The inverses run through the same mutations, so a failure reaches `failedEdit` unchanged.
  const inverseDelete = useCallback(
    (assignmentId: Id, reason: string | undefined, consent: string | undefined) => {
      markPending(assignmentId);
      settle(deleteMutate({ assignmentId, reason, consent }), undefined, () =>
        clearPending(assignmentId),
      );
    },
    [deleteMutate, markPending, clearPending],
  );
  const inverseMove = useCallback(
    (assignmentId: Id, to: Assignment, reason: string | undefined, consent: string | undefined) => {
      markPending(assignmentId);
      settle(
        moveMutate({
          assignmentId,
          nurseId: to.nurseId,
          shiftTypeId: to.shiftTypeId,
          date: to.date,
          reason,
          consent,
        }),
        undefined,
        () => clearPending(assignmentId),
      );
    },
    [moveMutate, markPending, clearPending],
  );
  const inversePatch = useCallback(
    (
      assignmentId: Id,
      patch: { isCharge: boolean } | { isOvertime: boolean },
      reason: string | undefined,
      consent: string | undefined,
    ) => {
      markPending(assignmentId);
      settle(updateMutate({ assignmentId, patch, reason, consent }), undefined, () =>
        clearPending(assignmentId),
      );
    },
    [updateMutate, markPending, clearPending],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'z') return;
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
      // A dialog owns the keyboard, and an edit made behind it would be invisible to the manager.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (undoStack.current.length === 0) return;
      event.preventDefault();
      undoLatest();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [undoLatest]);

  const handleCreate = useCallback(
    (input: { nurseId: Id; date: IsoDate; shiftTypeId: Id }) => {
      if (readOnly) return;
      withReason('Add a shift to the published schedule', (reason, consent) => {
        const ghost = makeGhost(period.id, input);
        setPendingCreates((prev) => [...prev, ghost]);
        settle(
          createMutate({ periodId: period.id, ...input, reason, consent }),
          (created) =>
            record(
              `Added ${nurseName(input.nurseId)} to ${shiftName(input.shiftTypeId)} on ${formatDateWithWeekday(input.date)}`,
              reason,
              (undoReason) => inverseDelete(created.id, undoReason, consent),
            ),
          () => setPendingCreates((prev) => prev.filter((g) => g.id !== ghost.id)),
        );
      });
    },
    [readOnly, period.id, createMutate, withReason, record, inverseDelete, shiftName, nurseName],
  );

  const handleMove = useCallback(
    (input: { assignmentId: Id; nurseId: Id; shiftTypeId: Id; date: IsoDate }) => {
      if (readOnly) return;
      withReason('Move a shift on the published schedule', (reason, consent) => {
        markPending(input.assignmentId);
        const ghost = makeGhost(period.id, input);
        setPendingCreates((prev) => [...prev, ghost]);
        const before = heldAssignment(input.assignmentId);
        settle(
          moveMutate({ ...input, reason, consent }),
          (moved) => {
            // No held row to go back to (a move normally starts from a chip the board holds, so
            // this is rare): the move stands, it just cannot be undone.
            if (!before) return;
            record(
              `Moved ${nurseName(input.nurseId)} to ${formatDateWithWeekday(input.date)}, ${shiftName(input.shiftTypeId)}`,
              reason,
              // The server re-created the shift, so it is the new id that goes back.
              (undoReason) => inverseMove(moved.id, before, undoReason, consent),
            );
          },
          () => {
            clearPending(input.assignmentId);
            setPendingCreates((prev) => prev.filter((g) => g.id !== ghost.id));
          },
        );
      });
    },
    [
      readOnly,
      period.id,
      moveMutate,
      markPending,
      clearPending,
      withReason,
      record,
      inverseMove,
      shiftName,
      heldAssignment,
      nurseName,
    ],
  );

  const handleToggleLock = useCallback(
    (assignment: Assignment) => {
      markPending(assignment.id);
      settle(
        lockMutate({ assignmentId: assignment.id, locked: !assignment.isLocked }),
        () =>
          record(assignment.isLocked ? 'Shift unlocked' : 'Shift locked', undefined, () => {
            markPending(assignment.id);
            settle(
              lockMutate({ assignmentId: assignment.id, locked: assignment.isLocked }),
              undefined,
              () => clearPending(assignment.id),
            );
          }),
        () => clearPending(assignment.id),
      );
    },
    [lockMutate, markPending, clearPending, record],
  );

  const handleToggleCharge = useCallback(
    (assignment: Assignment) => {
      withReason('Change the charge nurse on the published schedule', (reason, consent) => {
        markPending(assignment.id);
        settle(
          updateMutate({
            assignmentId: assignment.id,
            patch: { isCharge: !assignment.isCharge },
            reason,
            consent,
          }),
          () =>
            record('Charge nurse changed', reason, (undoReason) =>
              inversePatch(assignment.id, { isCharge: assignment.isCharge }, undoReason, consent),
            ),
          () => clearPending(assignment.id),
        );
      });
    },
    [updateMutate, markPending, clearPending, withReason, record, inversePatch],
  );

  const handleToggleOvertime = useCallback(
    (assignment: Assignment) => {
      withReason('Change overtime authorisation on the published schedule', (reason, consent) => {
        markPending(assignment.id);
        settle(
          updateMutate({
            assignmentId: assignment.id,
            patch: { isOvertime: !assignment.isOvertime },
            reason,
            consent,
          }),
          () =>
            record('Overtime authorisation changed', reason, (undoReason) =>
              inversePatch(
                assignment.id,
                { isOvertime: assignment.isOvertime },
                undoReason,
                consent,
              ),
            ),
          () => clearPending(assignment.id),
        );
      });
    },
    [updateMutate, markPending, clearPending, withReason, record, inversePatch],
  );

  const handleRemove = useCallback(
    (assignment: Assignment) => {
      onRemoveStart?.();
      withReason('Remove a shift from the published schedule', (reason, consent) => {
        markPending(assignment.id);
        settle(
          deleteMutate({ assignmentId: assignment.id, reason, consent }),
          () =>
            record(
              `Removed ${nurseName(assignment.nurseId)} from ${shiftName(assignment.shiftTypeId)} on ${formatDateWithWeekday(assignment.date)}`,
              reason,
              // Main stamps every create `manual`, so a solver-placed shift comes back as a
              // hand-placed one; the nurse, day, shift and flags are what a manager sees.
              (undoReason) =>
                settle(
                  createMutate({
                    periodId: assignment.periodId,
                    nurseId: assignment.nurseId,
                    shiftTypeId: assignment.shiftTypeId,
                    date: assignment.date,
                    isLocked: assignment.isLocked,
                    isCharge: assignment.isCharge,
                    isOvertime: assignment.isOvertime,
                    ...(assignment.notes !== undefined ? { notes: assignment.notes } : {}),
                    reason: undoReason,
                    consent,
                  }),
                  undefined,
                  undefined,
                ),
            ),
          () => clearPending(assignment.id),
        );
      });
    },
    [
      deleteMutate,
      createMutate,
      markPending,
      clearPending,
      withReason,
      onRemoveStart,
      record,
      shiftName,
      nurseName,
    ],
  );

  const handleChipDelete = useCallback(
    async (assignment: Assignment) => {
      if (await confirm({ title: 'Remove this assignment?', confirmLabel: 'Remove' })) {
        handleRemove(assignment);
      }
    },
    [confirm, handleRemove],
  );

  const handleSwap = useCallback(
    (firstId: Id, secondId: Id) =>
      withReason('Swap two shifts on the published schedule', (reason, consent) => {
        const first = heldAssignment(firstId);
        const second = heldAssignment(secondId);
        settle(
          swapMutate({ firstId, secondId, reason, consent }),
          ([a, b]) =>
            record(
              first && second
                ? `Swapped ${nurseName(first.nurseId)} and ${nurseName(second.nurseId)} on ${formatDateWithWeekday(first.date)}`
                : 'Swapped two shifts',
              reason,
              // Both rows were re-created, so the swap back is between the new ids.
              (undoReason) =>
                settle(
                  swapMutate({ firstId: a.id, secondId: b.id, reason: undoReason, consent }),
                  undefined,
                  undefined,
                ),
            ),
          undefined,
        );
      }),
    [withReason, swapMutate, heldAssignment, nurseName, record],
  );

  // A rejected edit (locked source, archived period, missing reason, DB error) silently snaps
  // the chip back on settle; without this the manager cannot tell a refusal from a glitch.
  // A mutation keeps its error until its next run, so the latest failure stays up until
  // dismissed or retried.
  const failedEdit = [
    createAssignment,
    moveAssignment,
    swapAssignments,
    updateAssignment,
    deleteAssignment,
    setLocked,
  ].find((m) => m.isError);

  return {
    pendingIds,
    pendingCreates,
    pendingEdit,
    requireConsent,
    resolvePendingEdit: (reason: string | undefined, consent?: string) => {
      const edit = pendingEdit;
      setPendingEdit(undefined);
      edit?.run(reason, consent);
    },
    cancelPendingEdit: () => setPendingEdit(undefined),
    undoLatest,
    clearUndo,
    failedEdit,
    handleCreate,
    handleMove,
    handleToggleLock,
    handleToggleCharge,
    handleToggleOvertime,
    handleRemove,
    handleChipDelete,
    handleSwap,
  };
}
