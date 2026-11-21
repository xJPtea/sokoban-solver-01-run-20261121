# sokoban-solver-01-run-20261121 — a push-optimal Sokoban solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/xJPtea/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/xJPtea/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in a single dependency-free `main.ts` (Node 22).
It answers all 5 instances of a set in one run, in under a second.

## How it works

A level is a 1-wide hallway with 1–4 rooms off it, 3–4 boxes per room. A box
pushed into the hallway can never come back, so every box stays in its own
room and the level optimum is the sum of the rooms' optima. The solver:

1. Splits the level into rooms by cutting the hallway row's dead floor (a box
   there reaches no goal) and taking each connected floor part holding boxes.
2. Solves each room on its own with breadth-first search over pushes, so the
   first solved state found uses the fewest pushes. A state is the sorted box
   squares plus the player's reachable region (named by its lowest square).
3. Prunes only dead states: a box may sit only on a "live" square (reachable
   by pulls from a goal), and a push that freezes a 2×2 block of walls/boxes
   with a box off its goal is dropped. Neither prune removes a solvable state.
4. Stitches the rooms' move strings together, walking the player between
   doors through the hallway. If the split fails, it falls back to a
   whole-level push search.

The search is bounded by states expanded, never by the wall clock, so two
runs write byte-identical outputs.

## Results

Practice set: **1,000,000** — every level solved in exactly P* pushes
(13, 16, 29, 47, 60). Also 1,000,000 on three freshly generated sets drawn
from other seeds (P* 12/14/32/47/60, 12/16/29/45/61, 13/15/29/42/65).
Runtime per set: under 1 second, far inside the 60-second budget.
Determinism: two runs on the practice set produce byte-identical outputs.
