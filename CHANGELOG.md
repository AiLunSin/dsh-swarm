# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - M1a/M1b/M2a/M2b/M2c

### Added

- Live token accounting: `session/event` usage from every child assistant message is attributed to the run, task, and member via `swarm/budget/charged`; exhausting the hard budget aborts running dispatches.
- Stall convergence: when a run has open tasks, no active dispatch, and no progress for `convergence.stallMs`, the judge records evidence and converges with reason `stalled_no_progress`.
- Rounds: once a dispatched batch settles with queued work remaining, the judge records merges/gateFailures/conflicts/votes/spend and the run opens the next round; budget risk (>=90% spent, <50% complete) and `maxRounds` converge.
- Review deadlock escalation: when every assigned reviewer has voted but the result is neither approval nor rejection, the judge records `swarm/review/escalated` and blocks the task instead of leaving it in review.
- Adaptive concurrency: the dispatch limit scales between 2 and `workspace.maxConcurrent` based on the ready queue, budget pressure, and repeated no-merge rounds (`swarm/scale`).
- Topology view: snapshot detail exposes member nodes plus aggregated review/dependency edges; the Web panel renders them as an SVG ring colored by role.
- Cost CSV: `GET /swarm/api/runs/:id/report.csv` exports the run/task/member ledger, linked from the budget page.
- Timeline page: event list with seek, play/pause, step controls, and full payload detail.
- Cost breakdown bars on the budget page, per task and per member.
- Deterministic `npm run bench`: single vs swarm coordination comparison with `bench/results/latest.json` and `latest.md`.
- Message bus: `swarm_message` / `swarm_inbox` with point-to-point, topic broadcast, correlation ids, TTL expiry, at-least-once delivery with acknowledgement, per-sender rate limiting, and cross-run rejection.
- Topology-aware routing: `mesh` is unrestricted, `star`/`hierarchy` only allow queen edges, and `pipeline` only adjacent members; violations emit `swarm/security/rejected`.
- Heterogeneous review: when possible, at least one reviewer uses a different model tier than the patch author.
- Hive panel page: blackboard entries, pheromone trails, and message metadata in the Web UI (seven tabs total).
- Cost by role: ledger CSV adds role aggregates and the budget page shows task/member/role bars.
- Dynamic roster: `swarm_intervene add_member/remove_member` adds or retires workers/reviewers; the queen cannot be removed, and busy or reviewing members are rejected.
- Token-protected HTTP writes: `POST /swarm/api/runs/:id/intervene|tasks|merge`; an empty `http.token` disables writes, reads stay loopback-only.
- `scripts/build-release.mjs`: builds a publishable renamed variant with matching package name, bundle row, and client module id (verified for `dsh-swarm-bundle` and `@ailunsin/dsh-swarm`; the bundle-name variant was installed from both the directory and a packed `.tgz` into the desktop profile and passed `swarm_status`/health checks).
- Real-model single-vs-swarm sample with token accounting: single 6059 tok / 68.1s, swarm (2 tasks) 9221 tok / 86.2s; total wall 1.27x, per-task wall 0.63x. Results and caveats in `bench/results/real-latest.md`.
- Second real-model sample (3 tasks): single 11873 tok / 56.3s, swarm 12105 tok / 77.0s; total wall 1.37x, token 1.02x, per-task wall 0.46x. See `bench/results/real-3task.md`.
- Release workflow builds the renamed variant and publishes from `dist/` (default `dsh-swarm-bundle`, overridable via `package-name`), with a tag/version match check.
- Release workflow on `v*` tags also runs tests, pack check, demo, npm publish, and GitHub release; FAQ/troubleshooting docs added.
- `docs/release.md` records the npm name conflict (`dsh-swarm` is reserved by another author), candidate package names, and the publish checklist.
- `docs/release-notes-0.1.0.md` summarizes the public feature set, live verification evidence, and known limitations.
- Web panel (`client.js`): a sidebar entry and main page with overview, members, tasks, and budget views, three-second polling, run selector, recent-event list, worktree/gate/conflict columns, and budget ledgers.
- Bilingual panel locale (`dshSwarm` namespace) with English and Chinese dictionaries and theme-derived styles.
- Review timeout: overdue reviews become recorded abstentions; quorum is then computed over cast votes, so a timeout does not block a merge that has enough approval. No approval at timeout blocks the task.
- Worktree governance: concurrency limit, disk free-space floor, and optional cleanup of task/integration worktrees at convergence while keeping branches and patches.
- Git worktree isolation: one branch and one checkout per task, created at award time under `<repo>/.dsh-swarm/worktrees` and excluded via `.git/info/exclude` so `git status` stays clean.
- Patch collection from committed worktree changes: commit, changed files, diff stat, and a `.diff` file under the run directory.
- Real merge gates: configured commands run on the task worktree before merging and on the integration branch afterwards; failures return the task to `working`.
- Serial merge queue with `--no-ff` merges into `swarm/<runId>/integration`, conflict detection with `git merge --abort`, and conflict file reporting.
- Post-merge gate rollback via `git reset --hard`.
- Real member execution: `swarm_dispatch` spawns one host subagent (`ctx.subagents`, provider `spawn`) in the task worktree with a fixed task card and JSON handoff schema.
- Dispatch lease extension, background execution, automatic commit of leftover child work, automatic patch collection, and review opening.
- Auto scheduling: with `dispatch.auto` (or `autoDispatch` on `swarm_start`), the tick loop dispatches ready tasks and backs off failed dispatches for two minutes.
- Conflict auto-round: a merge conflict returns the task to its author with a conflict card that names the files and the integration branch to merge; the author's resolution is collected as a new patch.
- Dispatch failure/timeout events, child disposal, and teardown abort on plugin unload.
- Events `swarm/task/gate`, `swarm/task/lease`, `swarm/merge/conflict`, `swarm/workspace/degraded`, `swarm/dispatch/started|finished|failed`; snapshots expose worktree, gate, conflict, dispatch, and merge commit.
- Config sections `workspace`, `gate`, `merge`, and `dispatch`; preflight reports the base commit.
- Eight git-backed integration tests, six dispatch tests, and HTTP route tests, plus timeout, governance, usage, stall, round, scale, escalation, topology, CSV, timeline, messaging, quorum, roster, release-build, and client-wiring coverage (92 tests total).
- Quorum is computed from the reviewers actually assigned to a patch (not the whole non-author roster), so large swarms no longer deadlock on unreachable thresholds.

### Changed

- `swarm_submit` no longer requires `branch`/`files` when a worktree exists; the server reads the commit and diff.
- `swarm_merge` ignores self-reported gate results when real gate commands are configured.
- Demo now initializes a real git repository, implements the toy task, runs `npm test` as a gate, and shows the integration branch.
- High-entropy secret detection no longer redacts long filesystem paths (it previously corrupted repository metadata and disabled worktree creation).
- `detectTestCommand` tolerates a UTF-8 BOM in `package.json`, so gate auto-detection works on Windows-authored repositories.

## [0.1.0] - 2026-11-13

First milestone: an installable DSH bundle with the coordination core.

### Added

- Swarm lifecycle: create, pause, resume, drain, abort, budget adjustment, force convergence.
- Event-sourced state: append-only JSONL, contiguous sequence numbers, SHA-256 hash chain, atomic snapshots, recovery replay.
- Explicit state machines for swarm, task, and member with coded illegal-transition errors.
- Task market: acceptance-criteria validation, dependency checks, explainable bid scoring, anti-starvation aging, forced assignment with reason, WIP limits.
- Fenced leases with expiry, automatic reclaim, and stale-write rejection.
- Shared blackboard: six entry kinds, TTL, confidence, capacity eviction, token-budgeted queries, secret redaction on write.
- Pheromone field: success / warning / heat, half-life decay, diffusion.
- Review engine: non-author reviewers, evidence-backed approvals, quorum tally, blocking veto, weak-vote exclusion.
- Three-level budget ledger with reserve/settle/release and hard-stop detection.
- Repository preflight: directory, writability, disk, git, acceptance command, with actionable fixes.
- Nine model-facing tools: `swarm_start`, `swarm_status`, `swarm_task`, `swarm_bid`, `swarm_submit`, `swarm_review`, `swarm_merge`, `swarm_board`, `swarm_intervene`.
- Stable system-prompt protocol section and a loopback-only read API.
- Chinese and English README, architecture and configuration docs, CI workflow, demo script, toy repository.
- 49 `node:test` cases, 86% line coverage.

### Known limitations

- Members are coordination records; real `ctx.subagents` execution lands in M1.
- No git worktree pool, merge queue, or gate runner yet (M1).
- No Web panel or CLI yet (M2/M3).
- Not published to npm yet (M4).
