/**
 * Rule set editor: the union/contract constraints the solver, the live schedule validator and
 * the pre-publish compliance report all enforce, sourced from `ALL_RULES` (packages/core's
 * registry) and edited per unit.
 *
 * Saving always calls `rules.save`, which inserts a brand-new, immutable version — it never
 * rewrites the one loaded here. That is not a UI nicety: a published period snapshots the
 * rule-set version it was solved under (see CLAUDE.md, "Rule set versions are immutable"), so
 * a past compliance report must keep reading the rules it actually judged the schedule by.
 * This screen never mutates a `RuleSet` in place; it only ever proposes the *next* version and
 * lets the manager choose to create it.
 */

import type {
  FairnessWeights,
  Rule,
  RuleConfig,
  RuleSeverity,
  Weekday,
  WeekendDefinition,
} from '@shiftnurse/core';
import {
  ALL_RULES,
  DEFAULT_FAIRNESS_WEIGHTS,
  DEFAULT_WEEKEND,
  FAIRNESS_COMPONENT_LABELS,
  FAIRNESS_COMPONENTS,
  formatTimeOfDay,
  hoursToMinutes,
  minutesToHours,
  parseTimeOfDay,
  resolveConfigs,
  WEEKDAY_NAMES,
} from '@shiftnurse/core';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useRuleSet, useSaveRuleSet } from '../../api-config.js';
import { AsyncState } from '../../components/async-state.js';
import { useUnitId } from '../../unit-context.js';

type RuleCategory = (typeof ALL_RULES)[number]['category'];

const CATEGORY_ORDER: { id: RuleCategory; label: string }[] = [
  { id: 'rest', label: 'Rest' },
  { id: 'hours', label: 'Hours' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'safety', label: 'Safety' },
  { id: 'equity', label: 'Equity' },
];

/** "minRestHours" -> "Min rest hours". */
function labelize(key: string): string {
  const words = key
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();
  return words.length === 0 ? words : words.charAt(0).toUpperCase() + words.slice(1);
}

function formatSavedAt(createdAt: number): string {
  // `createdAt` is an audit-style instant, not schedule geometry, so a plain `Date` is the
  // right tool here (see the time-model header in packages/core/src/domain/time.ts).
  return new Date(createdAt).toLocaleString();
}

function clearSeverityOverride(config: RuleConfig): RuleConfig {
  const { ruleId, enabled, params } = config;
  return { ruleId, enabled, params };
}

// ---------------------------------------------------------------------------
// Parameters form
// ---------------------------------------------------------------------------

function ParamField({
  fieldId,
  label,
  defaultLabel,
  changed,
  onReset,
  children,
}: {
  fieldId: string;
  label: string;
  defaultLabel: string;
  changed: boolean;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className="flex flex-col gap-1 text-sm text-text">
        {label}
        {children}
      </label>
      <p className="text-xs text-text-muted">
        default {defaultLabel}
        {changed ? (
          <>
            {' · '}
            <button type="button" onClick={onReset} className="underline hover:no-underline">
              Reset
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}

function ParamsForm({
  rule,
  params,
  onChange,
}: {
  rule: Rule<never>;
  params: Record<string, unknown>;
  onChange: (nextParams: Record<string, unknown>) => void;
}) {
  const defaults = rule.defaultParams as Record<string, unknown>;
  const keys = Object.keys(defaults);
  if (keys.length === 0) return null;

  return (
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {keys.map((key) => {
        const defaultValue = defaults[key]!;
        const value = params[key] ?? defaultValue;
        const label = labelize(key);
        const fieldId = `${rule.id}-${key}`;
        const changed = JSON.stringify(value) !== JSON.stringify(defaultValue);
        const reset = () => onChange({ ...params, [key]: defaultValue });

        if (typeof defaultValue === 'boolean') {
          return (
            <ParamField
              key={key}
              fieldId={fieldId}
              label={label}
              defaultLabel={String(defaultValue)}
              changed={changed}
              onReset={reset}
            >
              <input
                id={fieldId}
                type="checkbox"
                checked={Boolean(value)}
                onChange={(event) => onChange({ ...params, [key]: event.target.checked })}
                className="mt-1 self-start"
              />
            </ParamField>
          );
        }

        if (typeof defaultValue === 'number') {
          const step = Number.isInteger(defaultValue) ? 1 : 0.5;
          return (
            <ParamField
              key={key}
              fieldId={fieldId}
              label={label}
              defaultLabel={String(defaultValue)}
              changed={changed}
              onReset={reset}
            >
              <input
                id={fieldId}
                type="number"
                step={step}
                value={String(value)}
                onChange={(event) => onChange({ ...params, [key]: Number(event.target.value) })}
                className="rounded-md border border-border bg-bg px-2 py-1 text-text"
              />
            </ParamField>
          );
        }

        if (Array.isArray(defaultValue)) {
          const arrayValue = Array.isArray(value) ? (value as unknown[]) : defaultValue;
          return (
            <ParamField
              key={key}
              fieldId={fieldId}
              label={`${label} (comma-separated)`}
              defaultLabel={defaultValue.length > 0 ? defaultValue.join(', ') : '(none)'}
              changed={changed}
              onReset={reset}
            >
              <input
                id={fieldId}
                type="text"
                value={arrayValue.join(', ')}
                onChange={(event) => {
                  const next = event.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter((v) => v.length > 0);
                  onChange({ ...params, [key]: next });
                }}
                className="rounded-md border border-border bg-bg px-2 py-1 text-text"
              />
            </ParamField>
          );
        }

        // Everything else (string, and any future scalar param type) gets a text input.
        return (
          <ParamField
            key={key}
            fieldId={fieldId}
            label={label}
            defaultLabel={String(defaultValue)}
            changed={changed}
            onReset={reset}
          >
            <input
              id={fieldId}
              type="text"
              value={String(value)}
              onChange={(event) => onChange({ ...params, [key]: event.target.value })}
              className="rounded-md border border-border bg-bg px-2 py-1 text-text"
            />
          </ParamField>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One rule's card
// ---------------------------------------------------------------------------

function RuleCard({
  rule,
  config,
  onChange,
}: {
  rule: Rule<never>;
  config: RuleConfig;
  onChange: (next: RuleConfig) => void;
}) {
  const effectiveSeverity: RuleSeverity = config.severityOverride ?? rule.severity;
  const alternateSeverity: RuleSeverity = rule.severity === 'hard' ? 'soft' : 'hard';

  return (
    <div
      data-testid={`rule-card-${rule.id}`}
      className="rounded-md border border-border bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-text">{rule.name}</h3>
          <p className="mt-1 text-sm text-text-muted">{rule.description}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => onChange({ ...config, enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>

      <label className="mt-3 flex max-w-xs flex-col gap-1 text-sm text-text">
        Severity
        <select
          value={effectiveSeverity}
          onChange={(event) => {
            const next = event.target.value as RuleSeverity;
            onChange(
              next === rule.severity
                ? clearSeverityOverride(config)
                : { ...config, severityOverride: next },
            );
          }}
          className="rounded-md border border-border bg-bg px-2 py-1 text-text"
        >
          <option value={rule.severity}>
            {rule.severity === 'hard' ? 'Hard (default)' : 'Soft (default)'}
          </option>
          <option value={alternateSeverity}>
            {alternateSeverity === 'hard' ? 'Hard' : 'Soft'}
          </option>
        </select>
      </label>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-text-muted">
        Parameters
      </h4>
      <ParamsForm
        rule={rule}
        params={config.params}
        onChange={(nextParams) => onChange({ ...config, params: nextParams })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weekend definition
// ---------------------------------------------------------------------------

function WeekendSection({
  value,
  onChange,
}: {
  value: WeekendDefinition;
  onChange: (next: WeekendDefinition) => void;
}) {
  return (
    <section
      data-testid="weekend-definition"
      className="rounded-md border border-border bg-surface p-4"
    >
      <h2 className="text-sm font-semibold text-text">Weekend definition</h2>
      <p className="mt-1 text-sm text-text-muted">
        What counts as a weekend shift for equity tracking — nights, weekends and holidays feed the
        fairness ledger, and contracts disagree about where a weekend starts.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-text">
          Starts on
          <select
            value={value.startWeekday}
            onChange={(event) =>
              onChange({ ...value, startWeekday: Number(event.target.value) as Weekday })
            }
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          >
            {WEEKDAY_NAMES.map((weekdayName, index) => (
              <option key={weekdayName} value={index}>
                {weekdayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-text">
          Start time
          <input
            type="time"
            value={formatTimeOfDay(value.startMinute)}
            onChange={(event) =>
              onChange({ ...value, startMinute: parseTimeOfDay(event.target.value) })
            }
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text">
          Duration (hours)
          <input
            type="number"
            min={1}
            step={1}
            value={minutesToHours(value.durationMinutes)}
            onChange={(event) =>
              onChange({ ...value, durationMinutes: hoursToMinutes(Number(event.target.value)) })
            }
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text">
          Counts a shift as weekend when it
          <select
            value={value.mode}
            onChange={(event) =>
              onChange({ ...value, mode: event.target.value as WeekendDefinition['mode'] })
            }
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          >
            <option value="starts_within">Starts within the window</option>
            <option value="overlaps">Overlaps the window at all</option>
          </select>
        </label>
      </div>
    </section>
  );
}

/**
 * The soft weights. These never make a schedule illegal — they decide how much each fairness
 * component moves the 0–100 score and the solver's objective, so a unit that grieves holidays
 * far more than nights can say so here.
 */
function FairnessWeightsSection({
  value,
  onChange,
}: {
  value: FairnessWeights;
  onChange: (next: FairnessWeights) => void;
}) {
  return (
    <section
      data-testid="fairness-weights"
      className="rounded-md border border-border bg-surface p-4"
    >
      <h2 className="text-sm font-semibold text-text">Fairness weights</h2>
      <p className="mt-1 text-sm text-text-muted">
        How much each component counts in the fairness score and the solver's objective. 0 removes
        it from the score. Weights are relative to each other, so doubling every one changes
        nothing.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FAIRNESS_COMPONENTS.map((component) => (
          <label key={component} className="flex flex-col gap-1 text-sm text-text">
            {FAIRNESS_COMPONENT_LABELS[component]}
            <input
              type="number"
              min={0}
              step={0.5}
              value={value[component]}
              onChange={(event) =>
                onChange({ ...value, [component]: Math.max(0, Number(event.target.value) || 0) })
              }
              className="rounded-md border border-border bg-bg px-2 py-1 text-text"
            />
          </label>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function RulesPanel() {
  const unitId = useUnitId();
  const ruleSetQuery = useRuleSet(unitId);
  const saveMutation = useSaveRuleSet();

  const [loadedVersion, setLoadedVersion] = useState<number | undefined>(undefined);
  const [name, setName] = useState('');
  const [configs, setConfigs] = useState<RuleConfig[]>([]);
  const [weekendDefinition, setWeekendDefinition] = useState<WeekendDefinition>(DEFAULT_WEEKEND);
  const [fairnessWeights, setFairnessWeights] = useState<FairnessWeights>(DEFAULT_FAIRNESS_WEIGHTS);
  const [savedMessage, setSavedMessage] = useState<string | undefined>(undefined);

  const data = ruleSetQuery.data;

  // Sync local edit state from the loaded (or just-saved) version. Guarded on the version
  // number rather than run in an effect, so the first paint never flashes empty defaults
  // before settling on the real rule set — this is the "adjust state during render" pattern,
  // safe here because the condition becomes false the instant it fires.
  if (data !== undefined && data.version !== loadedVersion) {
    setLoadedVersion(data.version);
    setName(data.name);
    setConfigs(resolveConfigs(data));
    setWeekendDefinition(data.weekendDefinition);
    setFairnessWeights(data.fairnessWeights);
    setSavedMessage(undefined);
  }

  if (ruleSetQuery.isPending) {
    return <AsyncState status="loading" label="Loading rules" />;
  }
  if (ruleSetQuery.isError || data === undefined) {
    return <AsyncState status="error" label="Could not load rules" error={ruleSetQuery.error} />;
  }

  const baselineConfigs = resolveConfigs(data);
  const dirty =
    name !== data.name ||
    JSON.stringify(configs) !== JSON.stringify(baselineConfigs) ||
    JSON.stringify(weekendDefinition) !== JSON.stringify(data.weekendDefinition) ||
    JSON.stringify(fairnessWeights) !== JSON.stringify(data.fairnessWeights);
  const nextVersion = data.version + 1;

  function updateConfig(ruleId: string, next: RuleConfig) {
    setConfigs((prev) => prev.map((c) => (c.ruleId === ruleId ? next : c)));
  }

  function discard() {
    setName(data!.name);
    setConfigs(resolveConfigs(data!));
    setWeekendDefinition(data!.weekendDefinition);
    setFairnessWeights(data!.fairnessWeights);
    setSavedMessage(undefined);
  }

  function save() {
    saveMutation.mutate(
      { unitId, name, configs, weekendDefinition, fairnessWeights },
      {
        onSuccess: (saved) => setSavedMessage(`Saved version ${saved.version}`),
      },
    );
  }

  const rulesByCategory = new Map<RuleCategory, Rule<never>[]>();
  for (const rule of ALL_RULES) {
    const list = rulesByCategory.get(rule.category);
    if (list) list.push(rule);
    else rulesByCategory.set(rule.category, [rule]);
  }

  return (
    <div data-testid="rules-panel" className="flex flex-col gap-4 pb-24">
      <section className="rounded-md border border-border bg-surface p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-sm text-text">
            Rule set name
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="rounded-md border border-border bg-bg px-2 py-1 text-text"
            />
          </label>
          <p className="text-sm text-text-muted">
            Version {data.version} · saved {formatSavedAt(data.createdAt)}
          </p>
        </div>
        <p className="mt-3 text-xs text-text-muted">
          Saving creates version {nextVersion}. It never rewrites version {data.version} — schedules
          already built under it keep reading it, so a compliance report never changes
          retroactively.
        </p>
      </section>

      {CATEGORY_ORDER.map(({ id, label }) => {
        const rulesInCategory = rulesByCategory.get(id) ?? [];
        if (rulesInCategory.length === 0 && id !== 'equity') return null;

        return (
          <section key={id} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-text">{label}</h2>
            {id === 'equity' ? (
              <FairnessWeightsSection value={fairnessWeights} onChange={setFairnessWeights} />
            ) : null}
            {rulesInCategory.map((rule) => {
              const config = configs.find((c) => c.ruleId === rule.id);
              if (config === undefined) return null;
              return (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  config={config}
                  onChange={(next) => updateConfig(rule.id, next)}
                />
              );
            })}
          </section>
        );
      })}

      <WeekendSection value={weekendDefinition} onChange={setWeekendDefinition} />

      <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-bg px-4 py-3">
        {savedMessage !== undefined ? (
          <p role="status" className="mr-auto text-sm text-text-muted">
            {savedMessage}
          </p>
        ) : null}
        <button
          type="button"
          disabled={!dirty}
          onClick={discard}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-surface disabled:opacity-50"
        >
          Discard changes
        </button>
        <button
          type="button"
          disabled={!dirty || saveMutation.isPending}
          onClick={save}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Save as version {nextVersion}
        </button>
      </div>
    </div>
  );
}
