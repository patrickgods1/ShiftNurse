/**
 * The Generate batch as the board sees it: which variation is on show, whether it is previewed
 * over the grid, and saving it as the draft. Kept out of the board so the page's layout is not
 * tangled with a feature that has its own lifecycle (a batch outlives a dialog and dies with a
 * publish).
 */

import type { Assignment, Id } from '@shiftnurse/core';
import { useEffect, useMemo, useState } from 'react';
import {
  useCancelBatch,
  useCandidatePreview,
  useCurrentBatch,
  useDiscardBatch,
  useSaveCandidate,
} from '../../api-solver.js';
import { useConfirm } from '../../components/confirm.js';
import { bestChoice, finishedRuns, variationNumber } from './candidates.js';

interface GenerateFlowArgs {
  period: { id: Id; status: string };
  unitId: Id;
  assignments: readonly Assignment[] | undefined;
  /** Called once a variation is saved as the draft: hand edits it replaced can no longer be undone. */
  onSaved?: () => void;
}

export function useGenerateFlow({ period, unitId, assignments, onSaved }: GenerateFlowArgs) {
  const confirm = useConfirm();
  const batch = useCurrentBatch(period.id).data;
  const saveCandidate = useSaveCandidate(period.id, unitId);
  const discardBatch = useDiscardBatch(period.id);
  const cancelBatch = useCancelBatch(period.id);

  /** The Generate variation on show in the bar; the batch's best until the manager pages. */
  // Both belong to one batch: a run index means nothing in the next one ("Generate more" makes
  // variations 5–7 of what were 2–4), so a new batch starts on its own best, out of preview.
  const [pick, setPick] = useState<{ batchId: Id; index?: number; previewing: boolean }>();
  const picked = batch && pick?.batchId === batch.id ? pick : undefined;
  const chosenIndex = picked?.index;
  const previewing = picked?.previewing ?? false;
  const setChosenIndex = (index: number) => {
    if (batch) setPick({ batchId: batch.id, index, previewing });
  };
  const setPreviewing = (next: boolean | ((was: boolean) => boolean)) => {
    if (!batch) return;
    const value = typeof next === 'function' ? next(previewing) : next;
    setPick({
      batchId: batch.id,
      ...(chosenIndex !== undefined ? { index: chosenIndex } : {}),
      previewing: value,
    });
  };
  const previewVariation = (index: number) => {
    if (batch) setPick({ batchId: batch.id, index, previewing: true });
  };

  // Variations belong to a draft. Once the period is published they can never be saved, so they
  // go quietly rather than as an "out of date" warning about a schedule the manager just sent.
  // An effect, not a handler on publish: it covers any non-draft status, whatever caused it.
  const discardMutate = discardBatch.mutate;
  useEffect(() => {
    if (batch && period.status !== 'draft') discardMutate(batch.id);
  }, [batch, period.status, discardMutate]);

  const finished = batch ? finishedRuns(batch) : [];
  const choice = batch ? bestChoice(batch) : undefined;
  const selectedIndex = finished.some((r) => r.index === chosenIndex)
    ? chosenIndex
    : choice?.kind === 'variation'
      ? choice.index
      : (choice?.bestVariation ?? finished[0]?.index);
  // A preview needs a variation to show; a batch that went stale or was discarded ends it.
  const previewActive = previewing && selectedIndex !== undefined;
  const previewQuery = useCandidatePreview(
    period.id,
    previewActive ? batch?.id : undefined,
    previewActive ? selectedIndex : undefined,
  );
  const preview = previewActive ? previewQuery.data : undefined;
  // Named from the preview's own index: while the next variation loads, the previous one's
  // numbers are still on show and must not be labelled as the next.
  const previewLabel =
    preview && batch ? `Variation ${variationNumber(batch, preview.index)}` : undefined;
  const highlightKeys = useMemo(
    () => (preview ? new Set(preview.changedKeys) : undefined),
    [preview],
  );

  const handleSaveCandidate = async () => {
    if (!batch || selectedIndex === undefined) return;
    const unlocked = (assignments ?? []).filter((a) => !a.isLocked).length;
    // Nothing on the grid to lose: saving needs no second question.
    if (unlocked > 0) {
      const ok = await confirm({
        title: `Save variation ${variationNumber(batch, selectedIndex)} as the draft?`,
        description: `It replaces the ${unlocked} unlocked shift${unlocked === 1 ? '' : 's'} on the grid, hand edits included. Locked shifts stay exactly where they are.`,
        confirmLabel: 'Save',
        danger: false,
      });
      if (!ok) return;
    }
    saveCandidate.mutate(
      { batchId: batch.id, index: selectedIndex },
      {
        onSuccess: () => {
          setPreviewing(false);
          onSaved?.();
        },
      },
    );
  };

  return {
    batch,
    saveCandidate,
    discardBatch,
    cancelBatch,
    selectedIndex,
    setChosenIndex,
    setPreviewing,
    previewVariation,
    previewActive,
    previewQuery,
    preview,
    previewLabel,
    highlightKeys,
    handleSaveCandidate,
  };
}
