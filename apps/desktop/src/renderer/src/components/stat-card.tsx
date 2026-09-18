/**
 * A single at-a-glance number for the dashboard (active nurses, pending time-off, ...). Tone
 * exists because "0 open call-offs" is good news and "4 open call-offs" is not — the same
 * component should not present both identically.
 */

type Tone = 'neutral' | 'warn' | 'danger';

interface StatCardProps {
  label: string;
  value: number | string;
  tone?: Tone;
}

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'text-text',
  warn: 'text-warn',
  danger: 'text-danger',
};

export function StatCard({ label, value, tone = 'neutral' }: StatCardProps) {
  return (
    <div data-testid="stat-card" className="rounded-md border border-border bg-surface p-4">
      <p className="text-sm text-text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${TONE_CLASSES[tone]}`}>{value}</p>
    </div>
  );
}
