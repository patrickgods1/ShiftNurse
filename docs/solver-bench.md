# Solver benchmark (M15)

Generated 2026-09-27 by `npm run bench:solvers` on darwin 25.5.0, Apple M1 × 8; OR-Tools 9.15.6755.

Budgets: SA + LNS and hybrid 200,000 annealing iterations (the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units of deterministic time over the whole period. Objective is in points (lower is better); a floor short costs 3,000.

## Median over seeds 1–3

| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 78,748 | 6,880 | 1,440 | 43,613 | 7,221 | 19,244 | 0 | 6.6 |
| demo | hybrid | 76,737 | 7,152 | 1,600 | 41,985 | 6,665 | 19,202 | 0 | 36.8 |
| demo | cp-sat | 181,638 | 93,696 | 5,280 | 53,429 | 7,449 | 20,314 | 13 | 59.1 |
| synthetic-24 | sa-lns | 6,028 | 1,180 | 0 | 1,708 | 3,110 | 0 | 0 | 2.5 |
| synthetic-24 | hybrid | 5,341 | 840 | 0 | 1,591 | 2,910 | 0 | 0 | 28.9 |
| synthetic-24 | cp-sat | 11,942 | 6,608 | 0 | 2,701 | 2,700 | 0 | 0 | 26.4 |
| small-8 | sa-lns | 13,320 | 13,020 | 0 | 360 | 0 | 0 | 2 | 1.3 |
| small-8 | hybrid | 13,320 | 13,020 | 0 | 300 | 0 | 0 | 1 | 15.2 |
| small-8 | cp-sat | 13,320 | 13,080 | 0 | 240 | 0 | 0 | 3 | 13.0 |

## Every run

| Unit | Solver | Seed | Objective | Floors short | Gap | Windows improved | Time (s) |
|---|---|--:|--:|--:|--:|--:|--:|
| demo | sa-lns | 1 | 78,748 | 0 | — | — | 6.6 |
| demo | sa-lns | 2 | 78,846 | 0 | — | — | 6.5 |
| demo | sa-lns | 3 | 77,911 | 0 | — | — | 6.6 |
| demo | hybrid | 1 | 76,567 | 0 | — | 8/8 | 39.2 |
| demo | hybrid | 2 | 76,933 | 0 | — | 8/8 | 35.0 |
| demo | hybrid | 3 | 76,737 | 0 | — | 8/8 | 36.8 |
| demo | cp-sat | 1 | 174,301 | 13 | 69% | — | 60.6 |
| demo | cp-sat | 2 | 181,638 | 12 | 70% | — | 58.9 |
| demo | cp-sat | 3 | 204,014 | 14 | 74% | — | 59.1 |
| synthetic-24 | sa-lns | 1 | 5,778 | 0 | — | — | 2.6 |
| synthetic-24 | sa-lns | 2 | 6,028 | 0 | — | — | 2.5 |
| synthetic-24 | sa-lns | 3 | 6,216 | 0 | — | — | 2.5 |
| synthetic-24 | hybrid | 1 | 5,341 | 0 | — | 7/8 | 27.8 |
| synthetic-24 | hybrid | 2 | 5,301 | 0 | — | 6/8 | 29.9 |
| synthetic-24 | hybrid | 3 | 5,525 | 0 | — | 6/8 | 28.9 |
| synthetic-24 | cp-sat | 1 | 9,030 | 0 | 60% | — | 22.6 |
| synthetic-24 | cp-sat | 2 | 11,942 | 0 | 66% | — | 26.4 |
| synthetic-24 | cp-sat | 3 | 12,009 | 0 | 65% | — | 32.1 |
| small-8 | sa-lns | 1 | 13,320 | 2 | — | — | 1.3 |
| small-8 | sa-lns | 2 | 13,388 | 2 | — | — | 1.3 |
| small-8 | sa-lns | 3 | 13,320 | 2 | — | — | 1.4 |
| small-8 | hybrid | 1 | 13,320 | 3 | — | 1/8 | 15.2 |
| small-8 | hybrid | 2 | 13,320 | 1 | — | 1/8 | 16.1 |
| small-8 | hybrid | 3 | 13,320 | 1 | — | 1/8 | 11.4 |
| small-8 | cp-sat | 1 | 13,320 | 3 | 55% | — | 13.0 |
| small-8 | cp-sat | 2 | 13,320 | 3 | 55% | — | 13.3 |
| small-8 | cp-sat | 3 | 13,320 | 3 | 55% | — | 12.8 |

## Result

Best median per unit: demo → hybrid, synthetic-24 → hybrid, small-8 → sa-lns. SA + LNS beats whole-period CP-SAT on 3 of 3 units, so the fallback order after hybrid is **sa-lns, then cp-sat**: `FALLBACK_ORDER = ['hybrid', 'sa-lns', 'cp-sat']`.
