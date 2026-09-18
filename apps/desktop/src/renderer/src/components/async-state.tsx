/**
 * One place to render "still loading" / "failed" / "nothing here", so a page's happy-path
 * JSX isn't tangled up with three ad-hoc conditionals every time. Scheduling data failing
 * silently is exactly the kind of bug this app exists to prevent, so errors are shown, not
 * swallowed.
 */

interface AsyncStateProps {
  status: 'loading' | 'error' | 'empty';
  label: string;
  error?: unknown;
}

export function AsyncState({ status, label, error }: AsyncStateProps) {
  const detail =
    status === 'error' && error instanceof Error
      ? error.message
      : status === 'error'
        ? String(error)
        : undefined;

  return (
    <div
      role={status === 'error' ? 'alert' : 'status'}
      className="flex flex-col items-center justify-center gap-1 rounded-md border border-border
        bg-surface p-8 text-center text-text-muted"
    >
      <p className={status === 'error' ? 'font-medium text-danger' : 'font-medium'}>{label}</p>
      {detail !== undefined ? <p className="text-sm">{detail}</p> : null}
    </div>
  );
}
