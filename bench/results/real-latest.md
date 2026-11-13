# Real-model bench (one sample)

- runner: real subagent (`ctx.subagents`, session default model)
- environment: Node 26.x / workstation / 2026-11
- workload: implement `alpha` and `beta` modules + tests, gate `npm test`
- baseline: one task does both modules
- swarm: two independent tasks, two workers, cross review, serial merge

| mode | tasks | merged | votes | tokens | calls | wall ms | quality |
| --- | --- | --- | --- | --- | --- | --- | --- |
| single | 1 | 1 | 0 | 6059 | 9 | 68145 | 3/3 tests pass |
| swarm | 2 | 2 | 4 | 9221 | 14 | 86229 | 3/3 tests pass |

| ratio | value |
| --- | --- |
| wall total | **1.27x** (slower) |
| token total | **1.52x** |
| wall per task | **0.63x** |
| token per task | **0.76x** |
| calls per task | **0.78x** |

## Reading

- Total wall clock is 27% slower for the swarm at this tiny scale; the requirement target
  (`swarm wall <= 70% single`) is **not** met.
- Per-task wall clock is 37% lower and per-task tokens 24% lower, because two children ran
  concurrently and each had a smaller task card.
- Token total is 52% higher, within the 3x ceiling; USD is not reported (no price table).
- Both integrations pass all 3 tests, so quality did not regress.
- One sample only; this is a sanity check, not a benchmark suite. Do not use it to claim a
  general speedup. For small work, `mode: "single"` is the right default.

## Reproduce

The repository and run logs were removed after measurement. To reproduce manually:

1. Create a git repo with `package.json` (`test: node --test`) and one passing base test.
2. Single run: `swarm_start` with `mode: "single"`, `autoDispatch: true`, then create a task
   that adds two modules and tests; merge after approval.
3. Swarm run: `members: 3`, `autoDispatch: true`, create two tasks (one module each), award to
   two workers, approve both patches, merge, tick to convergence.
4. Record `swarm/budget/charged` totals and `created`→`converged` timestamps
   (`node bench/summarize-run.mjs <runDir> <mode>`).

The deterministic fake-runner bench (`npm run bench`) remains the fast smoke check; this file is
the real-model evidence and is intentionally kept separate.
