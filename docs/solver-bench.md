# Solver benchmark (M15)

Generated 2026-10-04 by `npm run bench:solvers` on darwin 25.5.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); a floor short costs 3,000.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 80,028 | 6,732 | 1,760 | 44,826 | 7,672 | 19,297 | 0 | 6.9 |
| demo | hybrid | 78,107 | 7,284 | 1,760 | 43,123 | 7,567 | 19,084 | 0 | 30.0 |
| demo | cp-sat | 182,352 | 93,604 | 5,600 | 54,645 | 9,005 | 20,335 | 11 | 63.8 |
| synthetic-24 | sa-lns | 5,782 | 880 | 0 | 1,797 | 3,105 | 0 | 0 | 2.9 |
| synthetic-24 | hybrid | 5,366 | 832 | 0 | 1,559 | 2,950 | 0 | 0 | 30.8 |
| synthetic-24 | cp-sat | 13,679 | 6,644 | 160 | 2,905 | 2,815 | 0 | 0 | 21.7 |
| small-8 | sa-lns | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 1.6 |
| small-8 | hybrid | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 12.4 |
| small-8 | cp-sat | 13,320 | 13,200 | 0 | 120 | 0 | 0 | 3 | 14.8 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 80,687 | 0 | — | — | 6.9 |
| demo | sa-lns | 2 | 79,524 | 0 | — | — | 6.9 |
| demo | sa-lns | 3 | 80,028 | 0 | — | — | 6.8 |
| demo | hybrid | 1 | 78,107 | 0 | — | 8/8 | 61.9 |
| demo | hybrid | 2 | 82,555 | 0 | — | 1/2 | 24.2 |
| demo | hybrid | 3 | 77,814 | 0 | — | 8/8 | 30.0 |
| demo | cp-sat | 1 | 178,026 | 11 | 69% | — | 63.8 |
| demo | cp-sat | 2 | 182,352 | 11 | 71% | — | 61.0 |
| demo | cp-sat | 3 | 225,801 | 15 | 76% | — | 64.5 |
| synthetic-24 | sa-lns | 1 | 5,741 | 0 | — | — | 2.9 |
| synthetic-24 | sa-lns | 2 | 5,782 | 0 | — | — | 2.9 |
| synthetic-24 | sa-lns | 3 | 5,888 | 0 | — | — | 2.7 |
| synthetic-24 | hybrid | 1 | 5,293 | 0 | — | 6/8 | 31.6 |
| synthetic-24 | hybrid | 2 | 5,381 | 0 | — | 6/8 | 25.9 |
| synthetic-24 | hybrid | 3 | 5,366 | 0 | — | 5/8 | 30.8 |
| synthetic-24 | cp-sat | 1 | 6,542 | 0 | 44% | — | 21.7 |
| synthetic-24 | cp-sat | 2 | 13,679 | 0 | 69% | — | 24.7 |
| synthetic-24 | cp-sat | 3 | 15,034 | 0 | 74% | — | 21.5 |
| small-8 | sa-lns | 1 | 13,320 | 1 | — | — | 1.6 |
| small-8 | sa-lns | 2 | 13,320 | 3 | — | — | 1.6 |
| small-8 | sa-lns | 3 | 13,320 | 2 | — | — | 1.6 |
| small-8 | hybrid | 1 | 13,320 | 1 | — | 1/8 | 12.7 |
| small-8 | hybrid | 2 | 13,320 | 3 | — | 1/8 | 12.4 |
| small-8 | hybrid | 3 | 13,320 | 2 | — | 2/8 | 6.8 |
| small-8 | cp-sat | 1 | 13,320 | 3 | 55% | — | 14.7 |
| small-8 | cp-sat | 2 | 13,320 | 2 | 32% | — | 15.3 |
| small-8 | cp-sat | 3 | 13,320 | 3 | 55% | — | 14.8 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → sa-lns. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
