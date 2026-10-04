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
  EmploymentType,
  FairnessComponent,
  FairnessWeights,
  ParamDoc,
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
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPES,
  FAIRNESS_COMPONENT_LABELS,
  FAIRNESS_COMPONENTS,
  formatTimeOfDay,
  hoursToMinutes,
  minutesToHours,
  parseTimeOfDay,
  resolveConfigs,
  WEEKDAY_NAMES,
} from '@shiftnurse/core';
import { useState } from 'react';
import { useRuleSet, useSaveRuleSet } from '../../api-config.js';
import { AsyncState } from '../../components/async-state.js';
import { EditorShell } from '../../components/editor-shell.js';
import { CheckField, describedBy, Field, InfoTip } from '../../components/field-help.js';
import { INPUT } from '../../components/ui.js';
import { formatInstant } from '../../format.js';
import { useUnitId } from '../../unit-context.js';
import { invalidParams, numberFieldValue, paramError, withNumberParam } from './rule-params.js';

type RuleCategory = (typeof ALL_RULES)[number]['category'];

const CATEGORY_ORDER: { id: RuleCategory; label: string; intro: string }[] = [
  {
    id: 'rest',
    label: 'Rest',
    intro:
      'Time off between shifts and limits on long runs, so nobody is scheduled while exhausted.',
  },
  {
    id: 'hours',
    label: 'Hours',
    intro: 'Weekly caps, overtime, and how close each nurse lands to their contracted hours.',
  },
  {
    id: 'coverage',
    label: 'Coverage',
    intro: 'Who must be on each shift, and who cannot be because they are on leave or elsewhere.',
  },
  {
    id: 'safety',
    label: 'Safety',
    intro: 'Patient ratios and staff kept apart. A breach here is a regulatory or HR exposure.',
  },
  {
    id: 'equity',
    label: 'Equity',
    intro: 'How evenly the hard parts of the job are shared. These never make a schedule illegal.',
  },
];

const FAIRNESS_TIPS: Record<FairnessComponent, string> = {
  nights:
    'Night shifts each nurse works compared with their fair share. Raise it if nights are what ' +
    'your staff grieve most.',
  weekends:
    "Weekend shifts, as defined below, compared with each nurse's fair share. Raise it if " +
    'weekend rotation is a frequent complaint.',
  holidays:
    'Shifts starting on a holiday from the Holidays tab. Raise it so the same people do not work ' +
    'every holiday year after year.',
  onCall: 'Standby shifts. Raise it if on-call is a real burden on your unit, lower it if not.',
  undesirable:
    'Shifts that go against what a nurse said they prefer (for example a night for someone ' +
    'avoiding nights).',
  overtime:
    'Overtime hours. Low by default, because many nurses want overtime; raise it if overtime ' +
    'should be spread evenly.',
  preferences:
    'How often each nurse gets the shifts they prefer. Raise it to make preferences count for ' +
    'more when shifts are handed out.',
  timeOff:
    "How often each nurse's time-off requests are approved. Raise it so denials do not keep " +
    'landing on the same people.',
};

function clearSeverityOverride(config: RuleConfig): RuleConfig {
  const { ruleId, enabled, params } = config;
  return { ruleId, enabled, params };
}

// ---------------------------------------------------------------------------
// Parameters form
// ---------------------------------------------------------------------------

function defaultLabel(doc: ParamDoc, defaultValue: unknown): string {
  if (defaultValue === undefined) return 'not set';
  if (typeof defaultValue === 'boolean') return defaultValue ? 'on' : 'off';
  if (doc.input === 'weekday') return WEEKDAY_NAMES[defaultValue as number] ?? String(defaultValue);
  if (doc.input === 'employment-types' && Array.isArray(defaultValue)) {
    return defaultValue.length === 0
      ? 'none'
      : defaultValue.map((t) => EMPLOYMENT_TYPE_LABELS[t as EmploymentType] ?? t).join(', ');
  }
  return String(defaultValue);
}

/** "Default: 10 · Reset", under every field. */
function DefaultNote({
  doc,
  defaultValue,
  changed,
  onReset,
}: {
  doc: ParamDoc;
  defaultValue: unknown;
  changed: boolean;
  onReset: () => void;
}) {
  return (
    <p className="text-xs text-text-muted">
      Default: {defaultLabel(doc, defaultValue)}
      {changed ? (
        <>
          {' · '}
          <button type="button" onClick={onReset} className="underline hover:no-underline">
            Reset
          </button>
        </>
      ) : null}
    </p>
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
  const docs = rule.paramDocs as Record<string, ParamDoc>;
  const keys = Object.keys(docs);
  if (keys.length === 0) {
    return <p className="mt-3 text-xs text-text-muted">This rule has no settings.</p>;
  }

  return (
    <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
      {keys.map((key) => {
        const doc = docs[key]!;
        const defaultValue = defaults[key];
        const value = key in params ? params[key] : defaultValue;
        const fieldId = `${rule.id}-${key}`;
        const changed = JSON.stringify(value) !== JSON.stringify(defaultValue);
        const reset = () => {
          if (defaultValue === undefined) {
            const { [key]: _removed, ...rest } = params;
            onChange(rest);
          } else {
            onChange({ ...params, [key]: defaultValue });
          }
        };
        const gate = doc.activeWhen;
        const inactive =
          gate !== undefined && (params[gate.param] ?? defaults[gate.param]) !== gate.equals;
        const gateNote =
          gate !== undefined && inactive
            ? `Used only when “${docs[gate.param]?.label ?? gate.param}” is ${gate.equals ? 'on' : 'off'}.`
            : undefined;
        const note = (
          <DefaultNote doc={doc} defaultValue={defaultValue} changed={changed} onReset={reset} />
        );

        if (typeof defaultValue === 'boolean') {
          return (
            <div key={key} className="flex flex-col gap-1">
              <CheckField
                id={fieldId}
                label={doc.label}
                tip={doc.why}
                hint={gateNote ?? doc.hint}
                disabled={inactive}
              >
                <input
                  id={fieldId}
                  type="checkbox"
                  checked={Boolean(value)}
                  disabled={inactive}
                  aria-describedby={describedBy(fieldId, { hint: true })}
                  onChange={(event) => onChange({ ...params, [key]: event.target.checked })}
                />
              </CheckField>
              <div className="pl-6">{note}</div>
            </div>
          );
        }

        if (doc.input === 'employment-types') {
          const chosen = new Set(Array.isArray(value) ? (value as string[]) : []);
          return (
            <fieldset
              key={key}
              className="flex flex-col gap-1"
              aria-describedby={`${fieldId}-hint`}
            >
              <legend className="mb-1 flex items-center gap-1 text-sm font-medium text-text">
                {doc.label}
                <InfoTip label={doc.label}>{doc.why}</InfoTip>
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {EMPLOYMENT_TYPES.map((type) => (
                  <label key={type} className="flex items-center gap-1.5 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={chosen.has(type)}
                      onChange={(event) => {
                        const next = EMPLOYMENT_TYPES.filter((t) =>
                          t === type ? event.target.checked : chosen.has(t),
                        );
                        onChange({ ...params, [key]: next });
                      }}
                    />
                    {EMPLOYMENT_TYPE_LABELS[type]}
                  </label>
                ))}
              </div>
              <p id={`${fieldId}-hint`} className="text-xs text-text-muted">
                {doc.hint}
              </p>
              {note}
            </fieldset>
          );
        }

        if (doc.input === 'weekday') {
          return (
            <Field
              key={key}
              id={fieldId}
              label={doc.label}
              tip={doc.why}
              hint={doc.hint}
              footer={note}
            >
              <select
                id={fieldId}
                className={INPUT}
                value={String(value)}
                aria-describedby={describedBy(fieldId, { hint: true })}
                onChange={(event) => onChange({ ...params, [key]: Number(event.target.value) })}
              >
                {WEEKDAY_NAMES.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          );
        }

        if (typeof defaultValue === 'number' || (doc.optional && defaultValue === undefined)) {
          const error = paramError(doc, defaultValue, value);
          const step =
            typeof defaultValue === 'number' && !Number.isInteger(defaultValue) ? 0.5 : 1;
          return (
            <Field
              key={key}
              id={fieldId}
              label={doc.label}
              tip={doc.why}
              hint={gateNote ?? doc.hint}
              error={error}
              disabled={inactive}
              footer={note}
            >
              <input
                id={fieldId}
                type="number"
                min={doc.min ?? 0}
                step={step}
                value={numberFieldValue(value)}
                placeholder={doc.optional ? 'Not set' : undefined}
                disabled={inactive}
                aria-invalid={error !== undefined || undefined}
                aria-describedby={describedBy(fieldId, { hint: true, error: error !== undefined })}
                onChange={(event) =>
                  onChange(withNumberParam(params, key, event.target.value, doc))
                }
                className={INPUT}
              />
            </Field>
          );
        }

        // Any other scalar a future rule adds gets a text input.
        return (
          <Field
            key={key}
            id={fieldId}
            label={doc.label}
            tip={doc.why}
            hint={doc.hint}
            footer={note}
          >
            <input
              id={fieldId}
              type="text"
              value={String(value ?? '')}
              aria-describedby={describedBy(fieldId, { hint: true })}
              onChange={(event) => onChange({ ...params, [key]: event.target.value })}
              className={INPUT}
            />
          </Field>
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
  const enabledId = `${rule.id}-enabled`;
  const severityId = `${rule.id}-severity`;

  return (
    <div
      data-testid={`rule-card-${rule.id}`}
      className="rounded-md border border-border bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-text">{rule.name}</h3>
          <p className="mt-1 max-w-prose text-sm text-text-muted">{rule.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            id={enabledId}
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => onChange({ ...config, enabled: event.target.checked })}
          />
          <label htmlFor={enabledId} className="text-sm text-text">
            Enabled
          </label>
          <InfoTip label={`enabling ${rule.name}`}>
            When off, Generate, the grid's warnings and the pre-publish compliance report all ignore
            this rule. Turn a rule off only if your contract has no such clause.
          </InfoTip>
        </div>
      </div>

      {config.enabled ? (
        <>
          <div className="mt-3 max-w-xs">
            <Field
              id={severityId}
              label="Severity"
              tip={
                <>
                  <strong>Hard</strong>: Generate never breaks it. If it cannot be met, a shift is
                  left short and listed as unfilled.
                  <br />
                  <strong>Soft</strong>: Generate tries to respect it but may break it for a better
                  overall schedule. The grid shows it as a warning you can accept.
                </>
              }
            >
              <select
                id={severityId}
                value={effectiveSeverity}
                onChange={(event) => {
                  const next = event.target.value as RuleSeverity;
                  onChange(
                    next === rule.severity
                      ? clearSeverityOverride(config)
                      : { ...config, severityOverride: next },
                  );
                }}
                className={INPUT}
              >
                <option value={rule.severity}>
                  {rule.severity === 'hard' ? 'Hard (default)' : 'Soft (default)'}
                </option>
                <option value={alternateSeverity}>
                  {alternateSeverity === 'hard' ? 'Hard' : 'Soft'}
                </option>
              </select>
            </Field>
          </div>

          <ParamsForm
            rule={rule}
            params={config.params}
            onChange={(nextParams) => onChange({ ...config, params: nextParams })}
          />
        </>
      ) : (
        <p className="mt-3 text-xs text-text-muted">
          Off: Generate, the grid and the compliance report ignore this rule. Its settings are kept
          and come back when you turn it on.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weekend definition
// ---------------------------------------------------------------------------

/** A weekend length the manager left unsaveable (cleared, or out of range). */
function weekendDurationError(value: WeekendDefinition): string | undefined {
  const hours = minutesToHours(value.durationMinutes);
  return Number.isFinite(hours) && hours >= 1 && hours <= 168
    ? undefined
    : 'Enter between 1 and 168 hours.';
}

function WeekendSection({
  value,
  onChange,
}: {
  value: WeekendDefinition;
  onChange: (next: WeekendDefinition) => void;
}) {
  const durationHours = minutesToHours(value.durationMinutes);
  const durationError = weekendDurationError(value);

  return (
    <section
      data-testid="weekend-definition"
      className="rounded-md border border-border bg-surface p-4"
    >
      <h2 className="text-sm font-semibold text-text">Weekend definition</h2>
      <p className="mt-1 max-w-prose text-sm text-text-muted">
        What counts as a weekend shift. It decides who is credited with a weekend in the fairness
        score and which shifts earn the weekend differential on the Pay tab. Contracts disagree
        about where a weekend starts: Friday 19:00 for 60 hours covers Friday night through Monday
        07:00, while Saturday 00:00 for 48 hours covers only Saturday and Sunday.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="weekend-start-day" label="Starts on">
          <select
            id="weekend-start-day"
            value={value.startWeekday}
            onChange={(event) =>
              onChange({ ...value, startWeekday: Number(event.target.value) as Weekday })
            }
            className={INPUT}
          >
            {WEEKDAY_NAMES.map((weekdayName, index) => (
              <option key={weekdayName} value={index}>
                {weekdayName}
              </option>
            ))}
          </select>
        </Field>
        <Field id="weekend-start-time" label="Start time">
          <input
            id="weekend-start-time"
            type="time"
            value={formatTimeOfDay(value.startMinute)}
            onChange={(event) =>
              onChange({ ...value, startMinute: parseTimeOfDay(event.target.value) })
            }
            className={INPUT}
          />
        </Field>
        <Field
          id="weekend-duration"
          label="Length (hours)"
          hint="48 from Saturday 00:00 is Saturday and Sunday; 60 from Friday 19:00 adds Friday night."
          error={durationError}
        >
          <input
            id="weekend-duration"
            type="number"
            min={1}
            max={168}
            step={1}
            value={Number.isFinite(durationHours) ? durationHours : ''}
            aria-invalid={durationError !== undefined || undefined}
            aria-describedby={describedBy('weekend-duration', {
              hint: true,
              error: durationError !== undefined,
            })}
            onChange={(event) =>
              onChange({
                ...value,
                durationMinutes:
                  event.target.value.trim() === ''
                    ? Number.NaN
                    : hoursToMinutes(Number(event.target.value)),
              })
            }
            className={INPUT}
          />
        </Field>
        <Field
          id="weekend-mode"
          label="Counts a shift as weekend when it"
          tip={
            'Say the weekend starts Saturday 00:00. A Friday night shift from 19:00 to 07:00 ' +
            'overlaps it but starts before it, so only "overlaps" counts it as a weekend shift.'
          }
        >
          <select
            id="weekend-mode"
            value={value.mode}
            onChange={(event) =>
              onChange({ ...value, mode: event.target.value as WeekendDefinition['mode'] })
            }
            className={INPUT}
          >
            <option value="starts_within">Starts within the window</option>
            <option value="overlaps">Overlaps the window at all</option>
          </select>
        </Field>
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
      <p className="mt-1 max-w-prose text-sm text-text-muted">
        How much each component counts in the fairness score and in what Generate aims for. 0
        removes it from the score. Weights are relative to each other, so doubling every one changes
        nothing. Raise the ones your staff complain about most.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FAIRNESS_COMPONENTS.map((component) => (
          <Field
            key={component}
            id={`fairness-${component}`}
            label={FAIRNESS_COMPONENT_LABELS[component]}
            tip={FAIRNESS_TIPS[component]}
          >
            <input
              id={`fairness-${component}`}
              type="number"
              min={0}
              step={0.5}
              value={value[component]}
              onChange={(event) =>
                onChange({ ...value, [component]: Math.max(0, Number(event.target.value) || 0) })
              }
              className={INPUT}
            />
          </Field>
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

  const dirty =
    data !== undefined &&
    (name !== data.name ||
      JSON.stringify(configs) !== JSON.stringify(resolveConfigs(data)) ||
      JSON.stringify(weekendDefinition) !== JSON.stringify(data.weekendDefinition) ||
      JSON.stringify(fairnessWeights) !== JSON.stringify(data.fairnessWeights));

  if (ruleSetQuery.isPending) {
    return <AsyncState status="loading" label="Loading rules" />;
  }
  if (ruleSetQuery.isError || data === undefined) {
    return <AsyncState status="error" label="Could not load rules" error={ruleSetQuery.error} />;
  }

  const nextVersion = data.version + 1;
  const problems = invalidParams(ALL_RULES, configs);
  const weekendError = weekendDurationError(weekendDefinition);
  if (weekendError !== undefined) problems.push('Weekend definition: Length (hours)');

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
    <div data-testid="rules-panel" className="pb-24">
      <EditorShell
        label="Rules"
        dirty={dirty}
        saving={saveMutation.isPending}
        error={
          saveMutation.error ??
          (problems.length > 0 ? `Fix before saving: ${problems.join('; ')}` : undefined)
        }
        canSave={problems.length === 0}
        onSave={save}
        onDiscard={discard}
        saveLabel={`Save as version ${nextVersion}`}
      >
        <section className="rounded-md border border-border bg-surface p-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <Field
              id="rule-set-name"
              label="Rule set name"
              className="min-w-[240px] flex-1"
              tip="A name for your own reference, such as the contract it follows. Each save keeps the name with the new version."
            >
              <input
                id="rule-set-name"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={INPUT}
              />
            </Field>
            <p className="text-sm text-text-muted">
              Version {data.version} · saved {formatInstant(data.createdAt)}
            </p>
          </div>
          <p className="mt-3 text-xs text-text-muted">
            Saving creates version {nextVersion}. It never rewrites version {data.version} —
            schedules already built under it keep reading it, so a compliance report never changes
            retroactively.
          </p>
        </section>

        {CATEGORY_ORDER.map(({ id, label, intro }) => {
          const rulesInCategory = rulesByCategory.get(id) ?? [];
          if (rulesInCategory.length === 0 && id !== 'equity') return null;

          return (
            <section key={id} className="flex flex-col gap-3">
              <div>
                <h2 className="text-base font-semibold text-text">{label}</h2>
                <p className="text-sm text-text-muted">{intro}</p>
              </div>
              {id === 'equity' ? (
                <>
                  <FairnessWeightsSection value={fairnessWeights} onChange={setFairnessWeights} />
                  <WeekendSection value={weekendDefinition} onChange={setWeekendDefinition} />
                </>
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

        {savedMessage !== undefined && !dirty ? (
          <p role="status" className="text-sm text-success">
            {savedMessage}
          </p>
        ) : null}
      </EditorShell>
    </div>
  );
}
