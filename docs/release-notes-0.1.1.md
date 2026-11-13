# dsh-swarm 0.1.1 release notes

Patch release fixing real subagent dispatch on DSH 0.2.2-rc.3, plus the first real-task demo.

## Fixed

- DSH 0.2.2-rc.3 changed `subagents.startActivation` to take a **flat** activation spec. 0.1.0 still nested the request under `request`, so `spec.parent` was undefined and every auto-dispatch failed with `Cannot read properties of undefined (reading 'id')`.
- 0.1.1 passes `provider`, `label`, `parent`, `cwd`, `prompt`, `outputSchema`, `maxDepth`, `signal`, and `delivery` at the top level.
- Added `test/runner.test.js` asserting the flat spec and parent binding.

## Live verification

Real swarm run on DSH 0.2.2-rc.3:

| item | result |
| --- | --- |
| tasks / merged | 3 / 3 |
| reviews | 6 approvals, 0 rejections |
| integration tests | 26 / 26 pass |
| tokens | 62,183 / 80,000 |
| calls | 23 |
| wall clock | 203 s |
| outcome | converged |

Evidence: [bench/results/live-demo-2026-11-13.md](../bench/results/live-demo-2026-11-13.md).

## Upgrade

```bash
dsh plugin remove @ailunsin/dsh-swarm
dsh plugin add @ailunsin/dsh-swarm@0.1.1
```

0.1.0 cannot dispatch real workers on DSH 0.2.2-rc.3; upgrade if you use `swarm_dispatch` or `autoDispatch`.
