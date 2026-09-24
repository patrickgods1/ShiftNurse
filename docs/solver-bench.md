# Solver benchmark (M15)

Generated 2026-09-24 by `npm run bench:solvers` on darwin 25.5.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); a floor short costs 3,000.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 77,936 | 7,008 | 1,440 | 43,011 | 7,183 | 19,102 | 0 | 11.1 |
| demo | hybrid | 76,348 | 7,176 | 1,120 | 41,957 | 6,940 | 19,257 | 0 | 36.1 |
| demo | cp-sat | 197,434 | 111,988 | 5,280 | 52,656 | 7,815 | 20,198 | 16 | 58.2 |
| synthetic-24 | sa-lns | 6,028 | 1,180 | 0 | 1,708 | 3,110 | 0 | 0 | 4.1 |
| synthetic-24 | hybrid | 5,341 | 840 | 0 | 1,591 | 2,910 | 0 | 0 | 31.2 |
| synthetic-24 | cp-sat | 11,942 | 6,608 | 0 | 2,701 | 2,700 | 0 | 0 | 27.2 |
| small-8 | sa-lns | 13,320 | 13,020 | 0 | 360 | 0 | 0 | 2 | 2.0 |
| small-8 | hybrid | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 13.7 |
| small-8 | cp-sat | 13,320 | 13,200 | 0 | 120 | 0 | 0 | 3 | 14.6 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 77,936 | 0 | — | — | 11.1 |
| demo | sa-lns | 2 | 77,768 | 0 | — | — | 11.3 |
| demo | sa-lns | 3 | 81,161 | 1 | — | — | 10.9 |
| demo | hybrid | 1 | 76,214 | 0 | — | 8/8 | 42.4 |
| demo | hybrid | 2 | 76,348 | 0 | — | 8/8 | 36.1 |
| demo | hybrid | 3 | 77,546 | 0 | — | 8/8 | 26.5 |
| demo | cp-sat | 1 | 197,434 | 16 | 72% | — | 57.8 |
| demo | cp-sat | 2 | 211,279 | 17 | 75% | — | 58.2 |
| demo | cp-sat | 3 | 185,190 | 14 | 71% | — | 61.1 |
| synthetic-24 | sa-lns | 1 | 5,778 | 0 | — | — | 4.2 |
| synthetic-24 | sa-lns | 2 | 6,028 | 0 | — | — | 4.1 |
| synthetic-24 | sa-lns | 3 | 6,216 | 0 | — | — | 4.0 |
| synthetic-24 | hybrid | 1 | 5,341 | 0 | — | 7/8 | 29.9 |
| synthetic-24 | hybrid | 2 | 5,301 | 0 | — | 6/8 | 31.3 |
| synthetic-24 | hybrid | 3 | 5,525 | 0 | — | 6/8 | 31.2 |
| synthetic-24 | cp-sat | 1 | 9,030 | 0 | 60% | — | 23.4 |
| synthetic-24 | cp-sat | 2 | 11,942 | 0 | 66% | — | 27.2 |
| synthetic-24 | cp-sat | 3 | 12,009 | 0 | 65% | — | 33.1 |
| small-8 | sa-lns | 1 | 13,320 | 2 | — | — | 2.0 |
| small-8 | sa-lns | 2 | 13,320 | 2 | — | — | 2.0 |
| small-8 | sa-lns | 3 | 13,388 | 2 | — | — | 2.0 |
| small-8 | hybrid | 1 | 13,320 | 3 | — | 2/8 | 13.7 |
| small-8 | hybrid | 2 | 13,320 | 1 | — | 1/8 | 36.2 |
| small-8 | hybrid | 3 | 13,320 | 2 | — | 1/8 | 11.7 |
| small-8 | cp-sat | 1 | 13,399 | 3 | 33% | — | 13.5 |
| small-8 | cp-sat | 2 | 13,320 | 3 | 32% | — | 15.0 |
| small-8 | cp-sat | 3 | 13,320 | 2 | 32% | — | 14.6 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → sa-lns. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
