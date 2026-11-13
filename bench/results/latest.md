# dsh-swarm bench (latest)

- runner: fake (no model calls)
- node: v26.13.0 / win32
- at: 2026-11-13T11:37:49.019Z

| mode | tasks | merged | wall ms | tokens | calls |
| --- | --- | --- | --- | --- | --- |
| single | 1 | 1 | 1233 | 1200 | 1 |
| swarm | 3 | 3 | 2754 | 3600 | 3 |

wall ratio: 2.23x · token ratio: 3x

> Deterministic coordination bench; fake children do not call models. Use a real SubagentRunner for cost/quality benchmarks.
