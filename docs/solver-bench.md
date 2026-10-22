# Solver benchmark (M15)

Generated 2026-10-22 by `npm run bench:solvers` on darwin 27.0.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); the first slot short on a shift costs 3,000, the second 6,000 more, the third 9,000 more (convex, D10). Each column is its own median over the seeds, so the parts need not add up to the Objective.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Most short on one shift | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 103,079 | 14,268 | 1,440 | 59,227 | 7,535 | 20,184 | 3 | 1 | 20.2 |
| demo | hybrid | 106,819 | 20,264 | 960 | 57,909 | 7,645 | 20,343 | 5 | 1 | 35.4 |
| demo | cp-sat | 288,864 | 189,936 | 5,640 | 62,353 | 10,124 | 20,292 | 13 | 6 | 142.0 |
| synthetic-24 | sa-lns | 5,740 | 996 | 0 | 1,687 | 3,085 | 0 | 0 | 0 | 4.8 |
| synthetic-24 | hybrid | 5,413 | 808 | 0 | 1,623 | 2,950 | 0 | 0 | 0 | 36.4 |
| synthetic-24 | cp-sat | 13,644 | 6,600 | 0 | 2,717 | 2,820 | 0 | 0 | 0 | 33.8 |
| small-8 | sa-lns | 13,363 | 13,020 | 0 | 355 | 0 | 0 | 1 | 1 | 2.9 |
| small-8 | hybrid | 13,361 | 12,960 | 0 | 401 | 0 | 0 | 2 | 1 | 14.4 |
| small-8 | cp-sat | 13,374 | 13,020 | 0 | 354 | 0 | 0 | 2 | 1 | 29.7 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Most short on one shift | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 104,907 | 3 | 1 | — | — | 20.2 |
| demo | sa-lns | 2 | 102,019 | 3 | 1 | — | — | 22.7 |
| demo | sa-lns | 3 | 103,079 | 2 | 1 | — | — | 11.5 |
| demo | hybrid | 1 | 95,206 | 1 | 1 | — | 8/8 | 33.6 |
| demo | hybrid | 2 | 108,246 | 5 | 1 | — | 8/8 | 35.4 |
| demo | hybrid | 3 | 106,819 | 5 | 1 | — | 8/8 | 52.6 |
| demo | cp-sat | 1 | 528,366 | 14 | 8 | 87% | — | 107.1 |
| demo | cp-sat | 2 | 288,864 | 12 | 6 | 76% | — | 267.9 |
| demo | cp-sat | 3 | 280,978 | 13 | 6 | 75% | — | 142.0 |
| synthetic-24 | sa-lns | 1 | 5,695 | 0 | 0 | — | — | 6.3 |
| synthetic-24 | sa-lns | 2 | 5,944 | 0 | 0 | — | — | 4.8 |
| synthetic-24 | sa-lns | 3 | 5,740 | 0 | 0 | — | — | 4.7 |
| synthetic-24 | hybrid | 1 | 5,381 | 0 | 0 | — | 6/8 | 36.4 |
| synthetic-24 | hybrid | 2 | 5,488 | 0 | 0 | — | 7/8 | 36.5 |
| synthetic-24 | hybrid | 3 | 5,413 | 0 | 0 | — | 6/8 | 35.7 |
| synthetic-24 | cp-sat | 1 | 13,644 | 0 | 0 | 74% | — | 25.8 |
| synthetic-24 | cp-sat | 2 | 12,177 | 0 | 0 | 66% | — | 38.8 |
| synthetic-24 | cp-sat | 3 | 15,084 | 0 | 0 | 72% | — | 33.8 |
| small-8 | sa-lns | 1 | 13,361 | 2 | 1 | — | — | 3.0 |
| small-8 | sa-lns | 2 | 13,363 | 1 | 1 | — | — | 2.8 |
| small-8 | sa-lns | 3 | 13,375 | 1 | 1 | — | — | 2.9 |
| small-8 | hybrid | 1 | 13,361 | 3 | 1 | — | 0/8 | 12.0 |
| small-8 | hybrid | 2 | 13,361 | 2 | 1 | — | 0/8 | 17.0 |
| small-8 | hybrid | 3 | 13,361 | 2 | 1 | — | 0/8 | 14.4 |
| small-8 | cp-sat | 1 | 13,374 | 2 | 1 | 55% | — | 14.4 |
| small-8 | cp-sat | 2 | 13,374 | 2 | 1 | 55% | — | 29.7 |
| small-8 | cp-sat | 3 | 13,361 | 3 | 1 | 55% | — | 34.6 |

## Result

Best median per unit: demo → sa-lns, synthetic-24 → hybrid, small-8 → hybrid. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
