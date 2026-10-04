/**
 * The "Option N" tag on each readout above the grid while a Generate variation is previewed.
 * The banner says a preview is on, but the numbers under it change quietly — a few hundred
 * dollars, the same violation counts — and a manager reading them must know they describe the
 * variation, not the saved draft.
 */

export function PreviewTag({ label }: { label: string | undefined }) {
  if (!label) return null;
  return (
    <span
      data-testid="preview-scope"
      className="mr-2 rounded-full border border-accent bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
    >
      {label}
    </span>
  );
}
