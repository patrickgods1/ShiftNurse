# Solver benchmark (M15)

Generated 2026-10-17 by `npm run bench:solvers` on darwin 25.5.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); the first slot short on a shift costs 3,000, the second 6,000 more, the third 9,000 more (convex, D10).

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Most short on one shift | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 78,850 | 7,288 | 1,920 | 43,175 | 7,492 | 19,051 | 0 | 0 | 9.4 |
| demo | hybrid | 77,126 | 7,136 | 2,080 | 41,882 | 7,113 | 19,120 | 0 | 0 | 27.7 |
| demo | cp-sat | 353,997 | 264,860 | 5,480 | 53,166 | 9,405 | 20,180 | 18 | 6 | 64.4 |
| synthetic-24 | sa-lns | 5,740 | 996 | 0 | 1,687 | 3,085 | 0 | 0 | 0 | 3.7 |
| synthetic-24 | hybrid | 5,413 | 808 | 0 | 1,623 | 2,950 | 0 | 0 | 0 | 29.8 |
| synthetic-24 | cp-sat | 12,177 | 6,600 | 0 | 2,717 | 2,860 | 0 | 0 | 0 | 28.5 |
| small-8 | sa-lns | 13,320 | 12,960 | 0 | 360 | 0 | 0 | 2 | 1 | 2.1 |
| small-8 | hybrid | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 1 | 12.1 |
| small-8 | cp-sat | 13,320 | 13,200 | 0 | 120 | 0 | 0 | 2 | 1 | 13.7 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Most short on one shift | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 78,850 | 0 | 0 | — | — | 10.3 |
| demo | sa-lns | 2 | 78,359 | 0 | 0 | — | — | 9.4 |
| demo | sa-lns | 3 | 81,610 | 1 | 1 | — | — | 9.1 |
| demo | hybrid | 1 | 77,126 | 0 | 0 | — | 8/8 | 22.4 |
| demo | hybrid | 2 | 77,999 | 0 | 0 | — | 8/8 | 30.0 |
| demo | hybrid | 3 | 76,591 | 0 | 0 | — | 8/8 | 27.7 |
| demo | cp-sat | 1 | 338,211 | 18 | 6 | 85% | — | 61.4 |
| demo | cp-sat | 2 | 555,581 | 18 | 8 | 91% | — | 73.3 |
| demo | cp-sat | 3 | 353,997 | 16 | 6 | 86% | — | 64.4 |
| synthetic-24 | sa-lns | 1 | 5,695 | 0 | 0 | — | — | 3.9 |
| synthetic-24 | sa-lns | 2 | 5,944 | 0 | 0 | — | — | 3.7 |
| synthetic-24 | sa-lns | 3 | 5,740 | 0 | 0 | — | — | 3.7 |
| synthetic-24 | hybrid | 1 | 5,381 | 0 | 0 | — | 6/8 | 29.8 |
| synthetic-24 | hybrid | 2 | 5,488 | 0 | 0 | — | 7/8 | 29.9 |
| synthetic-24 | hybrid | 3 | 5,413 | 0 | 0 | — | 6/8 | 29.6 |
| synthetic-24 | cp-sat | 1 | 10,487 | 0 | 0 | 66% | — | 21.1 |
| synthetic-24 | cp-sat | 2 | 12,177 | 0 | 0 | 66% | — | 32.9 |
| synthetic-24 | cp-sat | 3 | 15,084 | 0 | 0 | 72% | — | 28.5 |
| small-8 | sa-lns | 1 | 13,320 | 2 | 1 | — | — | 2.1 |
| small-8 | sa-lns | 2 | 13,320 | 2 | 1 | — | — | 2.1 |
| small-8 | sa-lns | 3 | 13,320 | 3 | 1 | — | — | 2.1 |
| small-8 | hybrid | 1 | 13,388 | 3 | 1 | — | 1/8 | 13.3 |
| small-8 | hybrid | 2 | 13,320 | 2 | 1 | — | 1/8 | 10.6 |
| small-8 | hybrid | 3 | 13,320 | 1 | 1 | — | 1/8 | 12.1 |
| small-8 | cp-sat | 1 | 13,320 | 2 | 1 | 55% | — | 13.7 |
| small-8 | cp-sat | 2 | 13,320 | 2 | 1 | 55% | — | 14.2 |
| small-8 | cp-sat | 3 | 13,320 | 1 | 1 | 55% | — | 13.5 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → sa-lns. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
