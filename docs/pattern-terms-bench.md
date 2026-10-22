# Pattern-term prices: bench study (M44 phase 8)

Run 2026-10-21 with `npm run bench:solvers` on darwin 27.0.0, Apple M1 × 8, OR-Tools 9.15.6755,
with each rule switched on as soft in every bench unit through `BENCH_ENABLE_RULES`, at the
default weight and then at half weight (`BENCH_WEIGHTS`). `docs/solver-bench.md` is regenerated on
every run, so the study lives here.

**Rule of the study (plan of record):** a term passes if floors short and coverage are no worse
than the baseline and runtime is at most +10%; a failing term is re-run once at half weight, and
one that still fails ships off by default.

## Baseline (new rules off)

`docs/solver-bench.md` as committed with this change. synthetic-24 and small-8 are byte-identical
to the previous baseline, so the new code adds nothing while the rules are off. The demo row
(the seeded scenario unit) moved, as it moved in phase 7: it is noisy across runs because its ids
are random. Its best median turned from hybrid to SA + LNS by 89 points (0.1%); `FALLBACK_ORDER`
is unchanged.

## Medians, SA + LNS and hybrid (coverage points / floors short / seconds)

| Term (weight) | demo sa-lns | demo hybrid | synthetic-24 sa-lns | synthetic-24 hybrid | small-8 sa-lns | small-8 hybrid |
|---|--:|--:|--:|--:|--:|--:|
| baseline | 8,304 / 1 / 11.8 | 8,320 / 1 / 44.6 | 996 / 0 / 4.0 | 808 / 0 / 29.4 | 13,020 / 1 / 2.3 | 12,960 / 2 / 11.8 |
| tour-rotation (45) | 11,740 / 1 / 14.8 | 14,980 / 2 / 35.7 | 808 / 0 / 5.8 | 736 / 0 / 33.4 | 13,020 / 2 / 3.2 | 13,080 / 3 / 11.6 |
| tour-rotation (22.5) | 17,460 / 3 / 16.7 | 20,532 / 5 / 40.1 | 608 / 0 / 6.1 | 640 / 0 / 26.3 | 13,020 / 3 / 3.1 | 13,080 / 3 / 13.3 |
| days-off-together (40) | 4,856 / 0 / 14.3 | 11,376 / 1 / 34.6 | 1,012 / 0 / 5.5 | 824 / 0 / 29.5 | 12,960 / 2 / 2.9 | 12,960 / 3 / 9.9 |
| days-off-together (20) | 16,960 / 3 / 14.1 | 20,292 / 3 / 34.5 | 1,012 / 0 / 5.5 | 824 / 0 / 29.8 | 12,960 / 2 / 3.1 | 12,960 / 3 / 11.7 |
| complete-weekends (40) | 13,768 / 2 / 15.4 | 8,616 / 1 / 34.8 | 1,164 / 0 / 6.2 | 784 / 0 / 28.4 | 13,020 / 2 / 3.3 | 13,020 / 2 / 23.9 |
| complete-weekends (20) | 11,420 / 2 / 15.7 | 14,332 / 3 / 36.1 | 880 / 0 / 7.1 | 840 / 0 / 32.1 | 12,960 / 3 / 3.5 | 13,020 / 2 / 17.6 |
| short-work-runs (30) | 17,000 / 4 / 13.9 | 8,496 / 1 / 35.0 | 1,096 / 0 / 5.4 | 840 / 0 / 28.1 | 12,960 / 3 / 2.9 | 13,020 / 2 / 14.4 |
| short-work-runs (15) | 19,900 / 4 / 14.0 | 17,296 / 3 / 36.1 | 936 / 0 / 5.7 | 608 / 0 / 21.0 | 12,960 / 3 / 3.0 | 12,960 / 3 / 12.1 |

The small-8 baseline SA + LNS row is the committed one, unchanged by this run. Full tables were
written to the scratchpad by `BENCH_OUT`, not kept.

## Reading

- **No term passes as written, at either weight.** The consistent failure is SA + LNS runtime:
  +35–78% on synthetic-24 (4.0 s → 5.4–7.1 s) and +26–52% on small-8. Each priced rule
  re-derives the touched nurse's findings, message text included, on every move. Floors short also
  rise by one or two on small-8 for most terms, a unit built to be short where any extra term
  moves which floor gives.
- **Coverage on the demo row is noise-dominated.** Halving a weight made demo coverage worse as
  often as better (days-off-together: 4,856 at 40, 16,960 at 20), the same spread the baseline
  shows between runs. Three seeds cannot separate a 40-point term from that noise there.
- **Hybrid wall time does not grow.** It is bounded by its CP-SAT windows; synthetic-24 hybrid
  stayed at 21–33 s against 29.4 s.

## Outcome

- `complete-weekends` and `short-work-runs` ship **off by default** (as planned) at the plan's
  weights (40, 30): no halved weight passed either, so there is no "passing weight" to prefer.
- `tour-rotation` and `days-off-together` were already off by default. The prices (45, 40) apply
  only to a unit that switches the rule on while soft. The VA demo profile and the VA preset do
  that for `tour-rotation`, so Generate there now steers by it, and SA + LNS runs slower.
- Follow-up worth doing before any of these is turned on by default: a count-only path for the SA
  counters (no message text) to win back the runtime, and a deterministic demo unit for the bench
  so that coverage can be compared at all.
