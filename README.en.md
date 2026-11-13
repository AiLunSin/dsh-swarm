# dsh-swarm

> Controlled multi-agent collaboration for DeepSeek Harness: a shared hive, a task market, isolated worktrees, review gates, and a three-level budget.

Version **0.1.1 (M0–M3)**, published on npm as [`@ailunsin/dsh-swarm`](https://www.npmjs.com/package/@ailunsin/dsh-swarm). The point is not to run more agents; it is to make several agents on one repository **safe to start, cheap to run, and possible to stop**.

- Requirements and design live in the Chinese documents next to this repository (`dsh-swarm-需求单.md`, `dsh-swarm-技术方案.md`).
- Architecture: [docs/architecture.md](./docs/architecture.md) · Configuration: [docs/config.md](./docs/config.md)
- FAQ: [docs/faq.md](./docs/faq.md) · Troubleshooting: [docs/troubleshooting.md](./docs/troubleshooting.md) · Release checklist: [docs/release.md](./docs/release.md)

## What works today

- Swarm lifecycle: create, pause, resume, drain, abort, add budget, force convergence.
- Task market: DAG validation, acceptance criteria, explainable bid scoring with anti-starvation aging, forced assignment.
- Fenced leases: stale or expired holders cannot submit.
- Hive blackboard: six entry kinds, TTL, confidence, capacity eviction, secret redaction, token-budgeted top-k.
- Pheromones: success / warning / heat with half-life decay.
- Reviews: non-author only, evidence-backed approvals, quorum tally, blocking veto, and timeout-as-abstention.
- Isolated workspaces: one git worktree and branch per task, with patches collected from commits.
- Worktree governance: concurrency limit, disk floor, and optional cleanup at convergence.
- Real member execution: `swarm_dispatch` spawns one host subagent in the task worktree with a task card and JSON handoff schema.
- Auto scheduling: with `autoDispatch`, the tick loop claims and dispatches ready tasks, and a conflict is sent back to its author with a conflict card.
- Member messaging: point-to-point requests/responses and topic broadcasts with TTL, at-least-once delivery, acknowledgement, and per-sender rate limiting.
- Web panel: a sidebar entry with overview, members, tasks, topology, hive, timeline, and budget pages, polling the local API and localized in English and Chinese.
- Topology graph: member nodes with review and dependency edges in an SVG ring layout, colored by role.
- Timeline replay: event list with seek, play/pause, step controls, and full payload detail.
- Cost export and breakdown: per-task and per-member bars plus the three-level ledger as CSV.
- Stall convergence: when nothing progresses for the configured window, the judge records evidence and converges the run.
- Rounds: a settled batch closes the round; the judge records merges, gate failures, conflicts, votes, and spend, then the next round opens for the remaining queue.
- Adaptive concurrency: the judge scales the dispatch limit up when the ready queue backs up and budget is healthy, and down under budget pressure or repeated no-merge rounds.
- Real merge gates: commands run on the task worktree and again on the integration branch; failures return the task or roll it back.
- Serial merge queue: `--no-ff` integration merges, conflict detection, and conflict files reported to the author.
- Three-level budget: run / task / member with reserve-before-call and settle-after-call, plus live token charging from child assistant messages.
- Event sourcing: append-only JSONL with a SHA-256 hash chain and contiguous sequence numbers.
- Repository preflight and a loopback-only read API plus token-protected write endpoints for intervention, task creation, and merge.

Not implemented yet: the Web panel and the CLI.

## Try it

```bash
node scripts/demo.mjs   # worktree + gate + review + merge, no model calls
npm test                # 93 tests
npm run bench           # deterministic single vs swarm comparison
```

Install into a profile:

```bash
# published package
dsh plugin add @ailunsin/dsh-swarm
# local development install:
dsh plugin add ./dsh-swarm
```

The twelve tools are `swarm_start`, `swarm_status`, `swarm_task`, `swarm_bid`, `swarm_dispatch`, `swarm_submit`, `swarm_review`, `swarm_merge`, `swarm_board`, `swarm_message`, `swarm_inbox`, and `swarm_intervene`. They return canonical JSON for `run_code` and render short human summaries.

## Design invariants

1. **Events are the only truth.** `applyEvent` is the only mutation path; live state and recovery replay share it.
2. **Write before acknowledge.** An append is fsynced before the command resolves; a failed append rolls the command back.
3. **Budget before call.** No reservation, no model call.
4. **One writer at merge time.** Work happens in isolated workspaces; the integration branch has a serialized writer.
5. **Votes decide release, gates decide correctness.** A patch with a failing gate never merges, even unanimously approved.

## Layout

```text
src/index.js      plugin entry (tools, prompt section, HTTP, ticker)
src/service.js    SwarmService
src/project.js    event reducer
src/events.js     hash-chained log
src/state.js      state machines
src/blackboard.js hive entries
src/pheromone.js  signal field
src/market.js     bids and leases
src/budget.js     ledgers
src/review.js     reviews and quorum
src/workspace.js  preflight and git primitives
src/tools.js      swarm_* tools
src/http.js       local read API
```

Zero runtime dependencies, Node 22+, MIT.
