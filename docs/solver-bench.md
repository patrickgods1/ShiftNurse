# Solver benchmark (M15)

Generated 2026-10-21 by `npm run bench:solvers` on darwin 27.0.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); the first slot short on a shift costs 3,000, the second 6,000 more, the third 9,000 more (convex, D10). Each column is its own median over the seeds, so the parts need not add up to the Objective.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Most short on one shift | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 95,787 | 8,304 | 1,440 | 59,462 | 7,424 | 20,074 | 1 | 1 | 11.8 |
| demo | hybrid | 95,876 | 8,320 | 1,280 | 57,488 | 7,454 | 20,217 | 1 | 1 | 44.6 |
| demo | cp-sat | 325,006 | 225,764 | 5,960 | 62,600 | 10,003 | 20,338 | 13 | 6 | 96.0 |
| synthetic-24 | sa-lns | 5,740 | 996 | 0 | 1,687 | 3,085 | 0 | 0 | 0 | 4.0 |
| synthetic-24 | hybrid | 5,413 | 808 | 0 | 1,623 | 2,950 | 0 | 0 | 0 | 29.4 |
| synthetic-24 | cp-sat | 12,177 | 6,600 | 0 | 2,717 | 2,860 | 0 | 0 | 0 | 27.9 |
| small-8 | sa-lns | 13,363 | 13,020 | 0 | 355 | 0 | 0 | 1 | 1 | 2.3 |
| small-8 | hybrid | 13,361 | 12,960 | 0 | 401 | 0 | 0 | 2 | 1 | 11.8 |
| small-8 | cp-sat | 13,374 | 13,020 | 0 | 354 | 0 | 0 | 2 | 1 | 13.6 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Most short on one shift | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 99,990 | 2 | 1 | — | — | 16.1 |
| demo | sa-lns | 2 | 95,787 | 1 | 1 | — | — | 11.8 |
| demo | sa-lns | 3 | 93,879 | 0 | 0 | — | — | 11.6 |
| demo | hybrid | 1 | 94,337 | 0 | 0 | — | 8/8 | 45.1 |
| demo | hybrid | 2 | 95,876 | 1 | 1 | — | 8/8 | 43.5 |
| demo | hybrid | 3 | 100,846 | 3 | 1 | — | 8/8 | 44.6 |
| demo | cp-sat | 1 | 300,027 | 13 | 6 | 76% | — | 96.0 |
| demo | cp-sat | 2 | 420,413 | 12 | 8 | 83% | — | 100.7 |
| demo | cp-sat | 3 | 325,006 | 14 | 6 | 78% | — | 87.2 |
| synthetic-24 | sa-lns | 1 | 5,695 | 0 | 0 | — | — | 4.2 |
| synthetic-24 | sa-lns | 2 | 5,944 | 0 | 0 | — | — | 4.0 |
| synthetic-24 | sa-lns | 3 | 5,740 | 0 | 0 | — | — | 3.8 |
| synthetic-24 | hybrid | 1 | 5,381 | 0 | 0 | — | 6/8 | 28.6 |
| synthetic-24 | hybrid | 2 | 5,488 | 0 | 0 | — | 7/8 | 29.4 |
| synthetic-24 | hybrid | 3 | 5,413 | 0 | 0 | — | 6/8 | 29.4 |
| synthetic-24 | cp-sat | 1 | 10,487 | 0 | 0 | 66% | — | 20.6 |
| synthetic-24 | cp-sat | 2 | 12,177 | 0 | 0 | 66% | — | 32.2 |
| synthetic-24 | cp-sat | 3 | 15,084 | 0 | 0 | 72% | — | 27.9 |
| small-8 | sa-lns | 1 | 13,361 | 2 | 1 | — | — | 2.3 |
| small-8 | sa-lns | 2 | 13,363 | 1 | 1 | — | — | 2.3 |
| small-8 | sa-lns | 3 | 13,375 | 1 | 1 | — | — | 2.2 |
| small-8 | hybrid | 1 | 13,361 | 3 | 1 | — | 0/8 | 9.9 |
| small-8 | hybrid | 2 | 13,361 | 2 | 1 | — | 0/8 | 14.4 |
| small-8 | hybrid | 3 | 13,361 | 2 | 1 | — | 0/8 | 11.8 |
| small-8 | cp-sat | 1 | 13,374 | 2 | 1 | 55% | — | 12.4 |
| small-8 | cp-sat | 2 | 13,374 | 2 | 1 | 55% | — | 13.6 |
| small-8 | cp-sat | 3 | 13,361 | 3 | 1 | 55% | — | 14.2 |

## Result

Best median per unit: demo → sa-lns, synthetic-24 → hybrid, small-8 → hybrid. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
