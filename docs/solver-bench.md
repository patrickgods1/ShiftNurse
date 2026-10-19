# Solver benchmark (M15)

Generated 2026-10-19 by `npm run bench:solvers` on darwin 25.5.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); the first slot short on a shift costs 3,000, the second 6,000 more, the third 9,000 more (convex, D10).

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Most short on one shift | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 96,540 | 7,832 | 1,120 | 58,133 | 8,316 | 20,115 | 0 | 0 | 10.7 |
| demo | hybrid | 91,660 | 5,108 | 1,120 | 57,765 | 7,520 | 20,338 | 0 | 0 | 30.1 |
| demo | cp-sat | 414,939 | 318,936 | 5,480 | 62,286 | 9,908 | 20,197 | 16 | 6 | 88.9 |
| synthetic-24 | sa-lns | 5,740 | 996 | 0 | 1,687 | 3,085 | 0 | 0 | 0 | 3.6 |
| synthetic-24 | hybrid | 5,413 | 808 | 0 | 1,623 | 2,950 | 0 | 0 | 0 | 28.8 |
| synthetic-24 | cp-sat | 12,177 | 6,600 | 0 | 2,717 | 2,860 | 0 | 0 | 0 | 28.1 |
| small-8 | sa-lns | 13,363 | 13,020 | 0 | 355 | 0 | 0 | 1 | 1 | 2.1 |
| small-8 | hybrid | 13,361 | 12,960 | 0 | 401 | 0 | 0 | 2 | 1 | 11.8 |
| small-8 | cp-sat | 13,374 | 13,020 | 0 | 354 | 0 | 0 | 2 | 1 | 13.7 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Most short on one shift | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 104,810 | 2 | 1 | — | — | 10.7 |
| demo | sa-lns | 2 | 92,348 | 0 | 0 | — | — | 10.8 |
| demo | sa-lns | 3 | 96,540 | 0 | 0 | — | — | 10.5 |
| demo | hybrid | 1 | 91,660 | 0 | 0 | — | 8/8 | 25.5 |
| demo | hybrid | 2 | 91,377 | 0 | 0 | — | 8/8 | 35.9 |
| demo | hybrid | 3 | 91,717 | 0 | 0 | — | 8/8 | 30.1 |
| demo | cp-sat | 1 | 414,939 | 17 | 6 | 83% | — | 83.0 |
| demo | cp-sat | 2 | 585,220 | 16 | 8 | 88% | — | 93.7 |
| demo | cp-sat | 3 | 333,158 | 13 | 6 | 79% | — | 88.9 |
| synthetic-24 | sa-lns | 1 | 5,695 | 0 | 0 | — | — | 3.6 |
| synthetic-24 | sa-lns | 2 | 5,944 | 0 | 0 | — | — | 3.6 |
| synthetic-24 | sa-lns | 3 | 5,740 | 0 | 0 | — | — | 3.5 |
| synthetic-24 | hybrid | 1 | 5,381 | 0 | 0 | — | 6/8 | 28.8 |
| synthetic-24 | hybrid | 2 | 5,488 | 0 | 0 | — | 7/8 | 29.3 |
| synthetic-24 | hybrid | 3 | 5,413 | 0 | 0 | — | 6/8 | 28.8 |
| synthetic-24 | cp-sat | 1 | 10,487 | 0 | 0 | 66% | — | 20.7 |
| synthetic-24 | cp-sat | 2 | 12,177 | 0 | 0 | 66% | — | 32.5 |
| synthetic-24 | cp-sat | 3 | 15,084 | 0 | 0 | 72% | — | 28.1 |
| small-8 | sa-lns | 1 | 13,361 | 2 | 1 | — | — | 2.1 |
| small-8 | sa-lns | 2 | 13,363 | 1 | 1 | — | — | 2.1 |
| small-8 | sa-lns | 3 | 13,375 | 1 | 1 | — | — | 2.1 |
| small-8 | hybrid | 1 | 13,361 | 3 | 1 | — | 0/8 | 9.8 |
| small-8 | hybrid | 2 | 13,361 | 2 | 1 | — | 0/8 | 14.3 |
| small-8 | hybrid | 3 | 13,361 | 2 | 1 | — | 0/8 | 11.8 |
| small-8 | cp-sat | 1 | 13,374 | 2 | 1 | 55% | — | 12.7 |
| small-8 | cp-sat | 2 | 13,374 | 2 | 1 | 55% | — | 13.7 |
| small-8 | cp-sat | 3 | 13,361 | 3 | 1 | 55% | — | 14.3 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → hybrid. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.


## Notes

- 2026-10 (phase 20): fairness shares exposure-normalised and age-decayed; per-diem hours no longer priced as overtime burden.
