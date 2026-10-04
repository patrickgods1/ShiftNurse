/**
 * Which of the board's dialogs is open, and which assignment's popover. One reducer instead of
 * separate flags so "open Generate on its progress view" is a single transition rather than two
 * setters that must be kept in step, and so the board has one place to read what is showing.
 */

import type { Id } from '@shiftnurse/core';
import { useMemo, useReducer } from 'react';
import type { GenerateView } from './generate-dialog.js';

interface DialogsState {
  generateOpen: boolean;
  // Kept while closed: the dialog re-opens on whichever view it was last asked for.
  generateView: GenerateView;
  publishOpen: boolean;
  changeLogOpen: boolean;
  compareOpen: boolean;
  openAssignmentId: Id | undefined;
}

type DialogsAction =
  | { type: 'generate'; open: boolean }
  | { type: 'generateView'; view: GenerateView }
  | { type: 'generateOn'; view: GenerateView }
  | { type: 'publish'; open: boolean }
  | { type: 'toggleChangeLog' }
  | { type: 'compare'; open: boolean }
  | { type: 'assignment'; id: Id | undefined };

const INITIAL: DialogsState = {
  generateOpen: false,
  generateView: 'setup',
  publishOpen: false,
  changeLogOpen: false,
  compareOpen: false,
  openAssignmentId: undefined,
};

function reduce(state: DialogsState, action: DialogsAction): DialogsState {
  switch (action.type) {
    case 'generate':
      return { ...state, generateOpen: action.open };
    case 'generateView':
      return { ...state, generateView: action.view };
    case 'generateOn':
      return { ...state, generateView: action.view, generateOpen: true };
    case 'publish':
      return { ...state, publishOpen: action.open };
    case 'toggleChangeLog':
      return { ...state, changeLogOpen: !state.changeLogOpen };
    case 'compare':
      return { ...state, compareOpen: action.open };
    case 'assignment':
      return { ...state, openAssignmentId: action.id };
  }
}

export function useScheduleDialogs() {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  // dispatch is stable, so these helpers are too: some are handed to memoised grid rows.
  const actions = useMemo(
    () => ({
      openGenerateOn: (view: GenerateView) => dispatch({ type: 'generateOn', view }),
      setGenerateOpen: (open: boolean) => dispatch({ type: 'generate', open }),
      setGenerateView: (view: GenerateView) => dispatch({ type: 'generateView', view }),
      setPublishOpen: (open: boolean) => dispatch({ type: 'publish', open }),
      toggleChangeLog: () => dispatch({ type: 'toggleChangeLog' }),
      setCompareOpen: (open: boolean) => dispatch({ type: 'compare', open }),
      openAssignment: (id: Id) => dispatch({ type: 'assignment', id }),
      closeAssignment: () => dispatch({ type: 'assignment', id: undefined }),
    }),
    [],
  );
  return { ...state, ...actions };
}
