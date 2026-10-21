# Solver benchmark (M15)

Generated 2026-10-21 by `npm run bench:solvers` on darwin 27.0.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); the first slot short on a shift costs 3,000, the second 6,000 more, the third 9,000 more (convex, D10). Each column is its own median over the seeds, so the parts need not add up to the Objective.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Most short on one shift | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 95,548 | 7,844 | 1,440 | 57,821 | 7,555 | 20,212 | 0 | 0 | 9.9 |
| demo | hybrid | 91,624 | 5,052 | 1,280 | 57,384 | 7,638 | 20,185 | 0 | 0 | 28.6 |
| demo | cp-sat | 345,296 | 246,968 | 5,400 | 62,968 | 10,075 | 20,320 | 15 | 8 | 120.7 |
| synthetic-24 | sa-lns | 5,740 | 996 | 0 | 1,687 | 3,085 | 0 | 0 | 0 | 5.2 |
| synthetic-24 | hybrid | 5,413 | 808 | 0 | 1,623 | 2,950 | 0 | 0 | 0 | 37.7 |
| synthetic-24 | cp-sat | 13,644 | 6,600 | 0 | 2,717 | 2,820 | 0 | 0 | 0 | 37.8 |
| small-8 | sa-lns | 13,363 | 13,020 | 0 | 355 | 0 | 0 | 1 | 1 | 2.7 |
| small-8 | hybrid | 13,361 | 12,960 | 0 | 401 | 0 | 0 | 2 | 1 | 15.9 |
| small-8 | cp-sat | 13,374 | 13,020 | 0 | 354 | 0 | 0 | 2 | 1 | 18.2 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Most short on one shift | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 92,281 | 0 | 0 | — | — | 15.8 |
| demo | sa-lns | 2 | 95,548 | 0 | 0 | — | — | 9.9 |
| demo | sa-lns | 3 | 96,811 | 0 | 0 | — | — | 8.7 |
| demo | hybrid | 1 | 91,966 | 0 | 0 | — | 8/8 | 36.3 |
| demo | hybrid | 2 | 91,624 | 0 | 0 | — | 8/8 | 25.9 |
| demo | hybrid | 3 | 91,295 | 0 | 0 | — | 8/8 | 28.6 |
| demo | cp-sat | 1 | 344,873 | 15 | 6 | 80% | — | 95.0 |
| demo | cp-sat | 2 | 507,339 | 13 | 8 | 86% | — | 120.7 |
| demo | cp-sat | 3 | 345,296 | 15 | 8 | 79% | — | 171.3 |
| synthetic-24 | sa-lns | 1 | 5,695 | 0 | 0 | — | — | 5.3 |
| synthetic-24 | sa-lns | 2 | 5,944 | 0 | 0 | — | — | 5.0 |
| synthetic-24 | sa-lns | 3 | 5,740 | 0 | 0 | — | — | 5.2 |
| synthetic-24 | hybrid | 1 | 5,381 | 0 | 0 | — | 6/8 | 38.6 |
| synthetic-24 | hybrid | 2 | 5,488 | 0 | 0 | — | 7/8 | 37.7 |
| synthetic-24 | hybrid | 3 | 5,413 | 0 | 0 | — | 6/8 | 37.7 |
| synthetic-24 | cp-sat | 1 | 13,644 | 0 | 0 | 74% | — | 34.0 |
| synthetic-24 | cp-sat | 2 | 12,177 | 0 | 0 | 66% | — | 42.5 |
| synthetic-24 | cp-sat | 3 | 15,084 | 0 | 0 | 72% | — | 37.8 |
| small-8 | sa-lns | 1 | 13,361 | 2 | 1 | — | — | 2.7 |
| small-8 | sa-lns | 2 | 13,363 | 1 | 1 | — | — | 2.7 |
| small-8 | sa-lns | 3 | 13,375 | 1 | 1 | — | — | 2.7 |
| small-8 | hybrid | 1 | 13,361 | 3 | 1 | — | 0/8 | 13.0 |
| small-8 | hybrid | 2 | 13,361 | 2 | 1 | — | 0/8 | 18.8 |
| small-8 | hybrid | 3 | 13,361 | 2 | 1 | — | 0/8 | 15.9 |
| small-8 | cp-sat | 1 | 13,374 | 2 | 1 | 55% | — | 17.0 |
| small-8 | cp-sat | 2 | 13,374 | 2 | 1 | 55% | — | 18.2 |
| small-8 | cp-sat | 3 | 13,361 | 3 | 1 | 55% | — | 18.7 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → hybrid. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
