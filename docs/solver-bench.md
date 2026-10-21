# Solver benchmark (M15)

Generated 2026-10-21 by `npm run bench:solvers` on darwin 27.0.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); the first slot short on a shift costs 3,000, the second 6,000 more, the third 9,000 more (convex, D10). Each column is its own median over the seeds, so the parts need not add up to the Objective.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Most short on one shift | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 101,943 | 14,464 | 1,120 | 58,857 | 7,770 | 20,096 | 3 | 1 | 18.1 |
| demo | hybrid | 92,142 | 5,120 | 1,280 | 57,502 | 7,717 | 20,308 | 0 | 0 | 33.4 |
| demo | cp-sat | 464,416 | 367,284 | 5,840 | 61,811 | 9,238 | 20,243 | 13 | 8 | 140.6 |
| synthetic-24 | sa-lns | 5,740 | 996 | 0 | 1,687 | 3,085 | 0 | 0 | 0 | 3.9 |
| synthetic-24 | hybrid | 5,413 | 808 | 0 | 1,623 | 2,950 | 0 | 0 | 0 | 38.5 |
| synthetic-24 | cp-sat | 12,177 | 6,600 | 0 | 2,717 | 2,860 | 0 | 0 | 0 | 33.7 |
| small-8 | sa-lns | 13,363 | 13,020 | 0 | 355 | 0 | 0 | 1 | 1 | 2.3 |
| small-8 | hybrid | 13,361 | 12,960 | 0 | 401 | 0 | 0 | 2 | 1 | 12.4 |
| small-8 | cp-sat | 13,374 | 13,020 | 0 | 354 | 0 | 0 | 2 | 1 | 18.4 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Most short on one shift | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 107,682 | 5 | 1 | — | — | 19.1 |
| demo | sa-lns | 2 | 101,943 | 2 | 1 | — | — | 18.1 |
| demo | sa-lns | 3 | 101,250 | 3 | 1 | — | — | 13.1 |
| demo | hybrid | 1 | 92,080 | 0 | 0 | — | 8/8 | 35.0 |
| demo | hybrid | 2 | 100,730 | 3 | 1 | — | 8/8 | 29.6 |
| demo | hybrid | 3 | 92,142 | 0 | 0 | — | 8/8 | 33.4 |
| demo | cp-sat | 1 | 376,052 | 13 | 8 | 81% | — | 148.3 |
| demo | cp-sat | 2 | 510,803 | 13 | 8 | 86% | — | 140.6 |
| demo | cp-sat | 3 | 464,416 | 11 | 10 | 85% | — | 90.5 |
| synthetic-24 | sa-lns | 1 | 5,695 | 0 | 0 | — | — | 4.1 |
| synthetic-24 | sa-lns | 2 | 5,944 | 0 | 0 | — | — | 3.9 |
| synthetic-24 | sa-lns | 3 | 5,740 | 0 | 0 | — | — | 3.9 |
| synthetic-24 | hybrid | 1 | 5,381 | 0 | 0 | — | 6/8 | 38.5 |
| synthetic-24 | hybrid | 2 | 5,488 | 0 | 0 | — | 7/8 | 48.2 |
| synthetic-24 | hybrid | 3 | 5,413 | 0 | 0 | — | 6/8 | 35.0 |
| synthetic-24 | cp-sat | 1 | 10,487 | 0 | 0 | 66% | — | 24.7 |
| synthetic-24 | cp-sat | 2 | 12,177 | 0 | 0 | 66% | — | 38.3 |
| synthetic-24 | cp-sat | 3 | 15,084 | 0 | 0 | 72% | — | 33.7 |
| small-8 | sa-lns | 1 | 13,361 | 2 | 1 | — | — | 2.3 |
| small-8 | sa-lns | 2 | 13,363 | 1 | 1 | — | — | 2.3 |
| small-8 | sa-lns | 3 | 13,375 | 1 | 1 | — | — | 2.3 |
| small-8 | hybrid | 1 | 13,361 | 3 | 1 | — | 0/8 | 10.5 |
| small-8 | hybrid | 2 | 13,361 | 2 | 1 | — | 0/8 | 14.8 |
| small-8 | hybrid | 3 | 13,361 | 2 | 1 | — | 0/8 | 12.4 |
| small-8 | cp-sat | 1 | 13,374 | 2 | 1 | 55% | — | 18.4 |
| small-8 | cp-sat | 2 | 13,374 | 2 | 1 | 55% | — | 32.3 |
| small-8 | cp-sat | 3 | 13,361 | 3 | 1 | 55% | — | 18.0 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → hybrid. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
