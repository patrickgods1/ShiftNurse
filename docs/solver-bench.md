# Solver benchmark (M15)

Generated 2026-10-17 by `npm run bench:solvers` on darwin 25.5.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); the first slot short on a shift costs 3,000, the second 6,000 more, the third 9,000 more (convex, D10).

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Most short on one shift | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 80,811 | 7,472 | 1,280 | 44,093 | 7,453 | 19,182 | 0 | 0 | 9.7 |
| demo | hybrid | 77,486 | 7,368 | 2,560 | 41,502 | 7,548 | 19,035 | 0 | 0 | 24.5 |
| demo | cp-sat | 464,287 | 372,800 | 5,320 | 55,499 | 10,212 | 20,391 | 13 | 8 | 68.2 |
| synthetic-24 | sa-lns | 5,741 | 872 | 0 | 1,735 | 3,045 | 0 | 0 | 0 | 3.6 |
| synthetic-24 | hybrid | 5,470 | 824 | 0 | 1,702 | 2,965 | 0 | 0 | 0 | 28.3 |
| synthetic-24 | cp-sat | 12,177 | 6,600 | 0 | 2,717 | 2,860 | 0 | 0 | 0 | 28.5 |
| small-8 | sa-lns | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 1 | 1.8 |
| small-8 | hybrid | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 2 | 1 | 13.3 |
| small-8 | cp-sat | 13,320 | 13,200 | 0 | 120 | 0 | 0 | 2 | 1 | 13.7 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Most short on one shift | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 85,680 | 1 | 1 | — | — | 9.1 |
| demo | sa-lns | 2 | 78,608 | 0 | 0 | — | — | 14.1 |
| demo | sa-lns | 3 | 80,811 | 0 | 0 | — | — | 9.7 |
| demo | hybrid | 1 | 77,486 | 0 | 0 | — | 8/8 | 24.5 |
| demo | hybrid | 2 | 77,401 | 0 | 0 | — | 8/8 | 32.2 |
| demo | hybrid | 3 | 77,774 | 0 | 0 | — | 8/8 | 22.0 |
| demo | cp-sat | 1 | 464,287 | 17 | 8 | 89% | — | 63.9 |
| demo | cp-sat | 2 | 307,837 | 13 | 8 | 84% | — | 68.2 |
| demo | cp-sat | 3 | 478,235 | 11 | 10 | 89% | — | 68.9 |
| synthetic-24 | sa-lns | 1 | 5,741 | 0 | 0 | — | — | 3.6 |
| synthetic-24 | sa-lns | 2 | 5,644 | 0 | 0 | — | — | 3.6 |
| synthetic-24 | sa-lns | 3 | 5,888 | 0 | 0 | — | — | 3.3 |
| synthetic-24 | hybrid | 1 | 5,462 | 0 | 0 | — | 4/8 | 24.8 |
| synthetic-24 | hybrid | 2 | 5,498 | 0 | 0 | — | 5/8 | 28.3 |
| synthetic-24 | hybrid | 3 | 5,470 | 0 | 0 | — | 7/8 | 31.1 |
| synthetic-24 | cp-sat | 1 | 10,487 | 0 | 0 | 66% | — | 21.6 |
| synthetic-24 | cp-sat | 2 | 12,177 | 0 | 0 | 66% | — | 33.2 |
| synthetic-24 | cp-sat | 3 | 15,084 | 0 | 0 | 72% | — | 28.5 |
| small-8 | sa-lns | 1 | 13,320 | 1 | 1 | — | — | 1.9 |
| small-8 | sa-lns | 2 | 13,320 | 2 | 1 | — | — | 1.8 |
| small-8 | sa-lns | 3 | 13,320 | 2 | 1 | — | — | 1.8 |
| small-8 | hybrid | 1 | 13,320 | 2 | 1 | — | 1/8 | 13.3 |
| small-8 | hybrid | 2 | 13,320 | 3 | 1 | — | 2/8 | 14.1 |
| small-8 | hybrid | 3 | 13,320 | 2 | 1 | — | 1/8 | 12.3 |
| small-8 | cp-sat | 1 | 13,320 | 2 | 1 | 55% | — | 13.7 |
| small-8 | cp-sat | 2 | 13,320 | 2 | 1 | 55% | — | 14.3 |
| small-8 | cp-sat | 3 | 13,320 | 1 | 1 | 55% | — | 13.5 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → sa-lns. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
