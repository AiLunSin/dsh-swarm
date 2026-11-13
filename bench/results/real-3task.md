# Real-model bench — 3 tasks (one sample)

- runner: real subagent (`ctx.subagents`, session default model)
- environment: Node v26.13.0 / win32 / 2026-11-13
- workload: implement `alpha`, `beta`, `gamma` + tests, gate `npm test`
- baseline: one task does all three modules
- swarm: three independent tasks, three workers, cross review, serial merge

| mode | tasks | merged | votes | tokens | calls | wall ms | quality |
| --- | --- | --- | --- | --- | --- | --- | --- |
| single | 1 | 1 | 0 | 11873 | 9 | 56258 | 7/7 tests pass |
| swarm | 3 | 3 | 6 | 12105 | 19 | 76955 | 5/5 tests pass |

| ratio | value |
| --- | --- |
| wall total | **1.37x** (slower) |
| token total | **1.02x** |
| wall per task | **0.46x** |
| token per task | **0.34x** |
| calls per task | **0.70x** |

## Reading

- Total wall clock is 37% slower for the swarm at this scale; the requirement target
  (`swarm wall <= 70% single`) is **not** met.
- Total tokens are essentially equal (1.02x), while per-task tokens are 66% lower and
  per-task wall clock is 54% lower: the swarm improves throughput, not end-to-end latency.
- Both integrations pass, but the runs wrote different test counts (7 vs 5); this is a
  pass-rate comparison, not identical coverage.
- One sample only. Combined with the two-task sample (`real-latest.md`), the consistent
  finding is: small workloads are latency-bound by coordination; use `single` unless the
  task graph is genuinely parallel and latency is not the only goal.

## Reproduce

Same protocol as [`real-latest.md`](./real-latest.md), with three tasks instead of two.
