# Solver benchmark (M15)

Generated 2026-10-17 by `npm run bench:solvers` on darwin 25.5.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); a floor short costs 3,000.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 80,039 | 7,428 | 1,600 | 44,111 | 7,605 | 19,214 | 0 | 8.2 |
| demo | hybrid | 77,594 | 7,044 | 1,600 | 41,693 | 7,737 | 19,106 | 0 | 45.3 |
| demo | cp-sat | 198,526 | 108,808 | 5,320 | 54,030 | 7,862 | 20,304 | 15 | 72.4 |
| synthetic-24 | sa-lns | 5,741 | 872 | 0 | 1,735 | 3,045 | 0 | 0 | 3.8 |
| synthetic-24 | hybrid | 5,401 | 832 | 0 | 1,619 | 2,950 | 0 | 0 | 34.6 |
| synthetic-24 | cp-sat | 13,748 | 6,720 | 0 | 2,863 | 2,850 | 0 | 0 | 33.4 |
| small-8 | sa-lns | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 1.8 |
| small-8 | hybrid | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 13.9 |
| small-8 | cp-sat | 13,320 | 13,200 | 0 | 120 | 0 | 0 | 3 | 13.2 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 79,544 | 0 | — | — | 10.1 |
| demo | sa-lns | 2 | 85,533 | 2 | — | — | 8.1 |
| demo | sa-lns | 3 | 80,039 | 0 | — | — | 8.2 |
| demo | hybrid | 1 | 76,958 | 0 | — | 8/8 | 61.9 |
| demo | hybrid | 2 | 77,594 | 0 | — | 8/8 | 45.3 |
| demo | hybrid | 3 | 78,639 | 0 | — | 8/8 | 29.6 |
| demo | cp-sat | 1 | 201,855 | 16 | 73% | — | 66.5 |
| demo | cp-sat | 2 | 187,011 | 15 | 71% | — | 81.0 |
| demo | cp-sat | 3 | 198,526 | 14 | 73% | — | 72.4 |
| synthetic-24 | sa-lns | 1 | 5,741 | 0 | — | — | 3.9 |
| synthetic-24 | sa-lns | 2 | 5,644 | 0 | — | — | 3.8 |
| synthetic-24 | sa-lns | 3 | 5,888 | 0 | — | — | 3.6 |
| synthetic-24 | hybrid | 1 | 5,325 | 0 | — | 7/8 | 31.1 |
| synthetic-24 | hybrid | 2 | 5,406 | 0 | — | 7/8 | 34.6 |
| synthetic-24 | hybrid | 3 | 5,401 | 0 | — | 6/8 | 47.0 |
| synthetic-24 | cp-sat | 1 | 6,526 | 0 | 37% | — | 39.1 |
| synthetic-24 | cp-sat | 2 | 13,748 | 0 | 71% | — | 33.4 |
| synthetic-24 | cp-sat | 3 | 14,915 | 0 | 76% | — | 19.8 |
| small-8 | sa-lns | 1 | 13,320 | 1 | — | — | 1.9 |
| small-8 | sa-lns | 2 | 13,320 | 2 | — | — | 1.8 |
| small-8 | sa-lns | 3 | 13,320 | 2 | — | — | 1.8 |
| small-8 | hybrid | 1 | 13,320 | 2 | — | 1/8 | 14.4 |
| small-8 | hybrid | 2 | 13,320 | 3 | — | 1/8 | 13.9 |
| small-8 | hybrid | 3 | 13,320 | 1 | — | 1/8 | 10.3 |
| small-8 | cp-sat | 1 | 13,320 | 3 | 55% | — | 13.1 |
| small-8 | cp-sat | 2 | 13,399 | 2 | 55% | — | 13.2 |
| small-8 | cp-sat | 3 | 13,320 | 3 | 32% | — | 14.1 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → sa-lns. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
