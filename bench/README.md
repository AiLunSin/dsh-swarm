# Benchmarks

Two different measurements, do not mix them:

| File | Runner | What it measures |
| --- | --- | --- |
| `results/latest.json` / `.md` | fake runner (no model calls) | coordination overhead of worktrees, dispatch, review, merge, convergence |
| `results/real-latest.json` / `.md` | real subagent (`ctx.subagents`) | two-module single-vs-swarm sample |
| `results/real-3task.json` / `.md` | real subagent (`ctx.subagents`) | three-module sample: token 1.02x, per-task wall 0.46x |

## Run the deterministic bench

```bash
npm run bench
```

It creates a temporary git repo, runs a single-mode baseline and a 3-task swarm, and writes
`results/latest.*`. It never calls a model, so it is safe in CI.

## Summarize a real run

```bash
node bench/summarize-run.mjs "$DSH_HOME/swarm/runs/<runId>" single
node bench/summarize-run.mjs "$DSH_HOME/swarm/runs/<runId>" swarm
```

The script reads `events.jsonl`, sums `swarm/budget/charged`, counts merges/votes/dispatches,
and writes `results/real-<mode>-<runId>.json`.

## Caveats

- Real runs are manual and sample-size 1 per workload; they are evidence, not a statistically powered suite.
- The 2-task sample: swarm total wall 1.27x slower, token 1.52x, per-task wall 0.63x.
- The 3-task sample: swarm total wall 1.37x slower, token 1.02x, per-task wall 0.46x, per-task token 0.34x.
- Consistent finding: small workloads are latency-bound by coordination; use `single` unless parallelism
  matters more than end-to-end latency.
- The requirement targets (>=70% one-pass rate, <=70% wall, <=3x token) need a larger toy suite and
  repeated runs before they can be claimed.
