# Solver benchmark (M15)

Generated 2026-10-03 by `npm run bench:solvers` on darwin 25.5.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); a floor short costs 3,000.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 80,806 | 9,836 | 2,240 | 42,759 | 7,826 | 18,994 | 0 | 7.0 |
| demo | hybrid | 78,441 | 6,796 | 1,600 | 43,013 | 7,712 | 19,347 | 0 | 20.3 |
| demo | cp-sat | 205,229 | 117,808 | 5,080 | 52,923 | 9,944 | 20,231 | 15 | 59.2 |
| synthetic-24 | sa-lns | 5,782 | 880 | 0 | 1,797 | 3,105 | 0 | 0 | 2.7 |
| synthetic-24 | hybrid | 5,366 | 832 | 0 | 1,559 | 2,950 | 0 | 0 | 29.7 |
| synthetic-24 | cp-sat | 13,679 | 6,644 | 160 | 2,905 | 2,815 | 0 | 0 | 21.1 |
| small-8 | sa-lns | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 1.6 |
| small-8 | hybrid | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 12.3 |
| small-8 | cp-sat | 13,320 | 13,200 | 0 | 120 | 0 | 0 | 3 | 14.5 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 78,797 | 0 | — | — | 7.0 |
| demo | sa-lns | 2 | 80,806 | 0 | — | — | 7.0 |
| demo | sa-lns | 3 | 83,464 | 1 | — | — | 6.3 |
| demo | hybrid | 1 | 78,662 | 0 | — | 8/8 | 19.6 |
| demo | hybrid | 2 | 78,129 | 0 | — | 8/8 | 20.3 |
| demo | hybrid | 3 | 78,441 | 0 | — | 8/8 | 21.2 |
| demo | cp-sat | 1 | 205,229 | 15 | 74% | — | 55.8 |
| demo | cp-sat | 2 | 203,757 | 14 | 74% | — | 59.2 |
| demo | cp-sat | 3 | 227,679 | 16 | 77% | — | 60.9 |
| synthetic-24 | sa-lns | 1 | 5,741 | 0 | — | — | 2.8 |
| synthetic-24 | sa-lns | 2 | 5,782 | 0 | — | — | 2.7 |
| synthetic-24 | sa-lns | 3 | 5,888 | 0 | — | — | 2.6 |
| synthetic-24 | hybrid | 1 | 5,293 | 0 | — | 6/8 | 29.7 |
| synthetic-24 | hybrid | 2 | 5,381 | 0 | — | 6/8 | 25.0 |
| synthetic-24 | hybrid | 3 | 5,366 | 0 | — | 5/8 | 29.7 |
| synthetic-24 | cp-sat | 1 | 6,542 | 0 | 44% | — | 21.0 |
| synthetic-24 | cp-sat | 2 | 13,679 | 0 | 69% | — | 24.3 |
| synthetic-24 | cp-sat | 3 | 15,034 | 0 | 74% | — | 21.1 |
| small-8 | sa-lns | 1 | 13,320 | 1 | — | — | 1.6 |
| small-8 | sa-lns | 2 | 13,320 | 3 | — | — | 1.6 |
| small-8 | sa-lns | 3 | 13,320 | 2 | — | — | 1.5 |
| small-8 | hybrid | 1 | 13,320 | 1 | — | 1/8 | 12.5 |
| small-8 | hybrid | 2 | 13,320 | 3 | — | 1/8 | 12.3 |
| small-8 | hybrid | 3 | 13,320 | 2 | — | 2/8 | 6.7 |
| small-8 | cp-sat | 1 | 13,320 | 3 | 55% | — | 14.5 |
| small-8 | cp-sat | 2 | 13,320 | 2 | 32% | — | 14.8 |
| small-8 | cp-sat | 3 | 13,320 | 3 | 55% | — | 14.2 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → sa-lns. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
