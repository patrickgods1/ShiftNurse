# Solver benchmark (M15)

Generated 2026-10-22 by `npm run bench:solvers` on darwin 27.0.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); the first slot short on a shift costs 3,000, the second 6,000 more, the third 9,000 more (convex, D10). Each column is its own median over the seeds, so the parts need not add up to the Objective.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Most short on one shift | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 96,535 | 8,220 | 1,440 | 58,393 | 8,474 | 20,293 | 0 | 0 | 20.0 |
| demo | hybrid | 100,509 | 14,376 | 1,600 | 57,141 | 7,333 | 20,322 | 2 | 1 | 61.2 |
| demo | cp-sat | 332,183 | 231,756 | 6,040 | 62,501 | 10,356 | 20,340 | 14 | 6 | 95.0 |
| synthetic-24 | sa-lns | 5,740 | 996 | 0 | 1,687 | 3,085 | 0 | 0 | 0 | 4.0 |
| synthetic-24 | hybrid | 5,413 | 808 | 0 | 1,623 | 2,950 | 0 | 0 | 0 | 28.5 |
| synthetic-24 | cp-sat | 12,177 | 6,600 | 0 | 2,717 | 2,860 | 0 | 0 | 0 | 27.6 |
| small-8 | sa-lns | 13,363 | 13,020 | 0 | 355 | 0 | 0 | 1 | 1 | 2.3 |
| small-8 | hybrid | 13,361 | 12,960 | 0 | 401 | 0 | 0 | 2 | 1 | 11.9 |
| small-8 | cp-sat | 13,374 | 13,020 | 0 | 354 | 0 | 0 | 2 | 1 | 13.3 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Most short on one shift | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 93,479 | 0 | 0 | — | — | 20.0 |
| demo | sa-lns | 2 | 96,535 | 0 | 0 | — | — | 23.8 |
| demo | sa-lns | 3 | 108,674 | 2 | 1 | — | — | 11.6 |
| demo | hybrid | 1 | 100,509 | 2 | 1 | — | 8/8 | 76.6 |
| demo | hybrid | 2 | 109,882 | 5 | 1 | — | 8/8 | 61.2 |
| demo | hybrid | 3 | 97,407 | 2 | 1 | — | 8/8 | 48.4 |
| demo | cp-sat | 1 | 332,183 | 12 | 6 | 79% | — | 109.7 |
| demo | cp-sat | 2 | 287,845 | 14 | 6 | 75% | — | 94.1 |
| demo | cp-sat | 3 | 384,915 | 15 | 8 | 82% | — | 95.0 |
| synthetic-24 | sa-lns | 1 | 5,695 | 0 | 0 | — | — | 4.1 |
| synthetic-24 | sa-lns | 2 | 5,944 | 0 | 0 | — | — | 4.0 |
| synthetic-24 | sa-lns | 3 | 5,740 | 0 | 0 | — | — | 3.9 |
| synthetic-24 | hybrid | 1 | 5,381 | 0 | 0 | — | 6/8 | 28.4 |
| synthetic-24 | hybrid | 2 | 5,488 | 0 | 0 | — | 7/8 | 28.8 |
| synthetic-24 | hybrid | 3 | 5,413 | 0 | 0 | — | 6/8 | 28.5 |
| synthetic-24 | cp-sat | 1 | 10,487 | 0 | 0 | 66% | — | 20.4 |
| synthetic-24 | cp-sat | 2 | 12,177 | 0 | 0 | 66% | — | 31.8 |
| synthetic-24 | cp-sat | 3 | 15,084 | 0 | 0 | 72% | — | 27.6 |
| small-8 | sa-lns | 1 | 13,361 | 2 | 1 | — | — | 2.3 |
| small-8 | sa-lns | 2 | 13,363 | 1 | 1 | — | — | 2.3 |
| small-8 | sa-lns | 3 | 13,375 | 1 | 1 | — | — | 2.3 |
| small-8 | hybrid | 1 | 13,361 | 3 | 1 | — | 0/8 | 9.8 |
| small-8 | hybrid | 2 | 13,361 | 2 | 1 | — | 0/8 | 14.4 |
| small-8 | hybrid | 3 | 13,361 | 2 | 1 | — | 0/8 | 11.9 |
| small-8 | cp-sat | 1 | 13,374 | 2 | 1 | 55% | — | 12.5 |
| small-8 | cp-sat | 2 | 13,374 | 2 | 1 | 55% | — | 13.3 |
| small-8 | cp-sat | 3 | 13,361 | 3 | 1 | 55% | — | 14.0 |

## Result

Best median per unit: demo → sa-lns, synthetic-24 → hybrid, small-8 → hybrid. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
