# FAQ

## 安装与卸载

**Q: 怎么安装？**
```bash
dsh plugin add dsh-swarm
```
本地开发目录用 `dsh plugin add ./dsh-swarm`，或在 Harness 里对目录执行插件安装。安装后侧边栏出现「蜂群」，工具列表出现 12 个 `swarm_*`。

**Q: 怎么卸载？**
```bash
dsh plugin remove dsh-swarm
```
运行数据不会自动删除；如需清理，删除 `$DSH_HOME/swarm/`。

## 什么时候该用蜂群

**Q: 单 agent 能做的任务要用蜂群吗？**
不要。任务无法切成独立、可验收的小块时，`mode: "single"` 更便宜也更稳。蜂群适合：多文件/多模块并行、需要交叉评审、需要共享踩坑记忆。

**Q: `single` 和 `swarm` 的区别？**
`single` 只有一个 worker，没有评审（直接 approved），用于基线对照和成本兜底；`swarm` 有女王 + 多个 worker + 非作者评审 + 门禁。

**Q: 和内置 `agent-team` 冲突吗？**
不冲突。Team 是共享任务板；Swarm 是任务板 + 市场 + 黑板 + worktree + 评审 + 预算。工具名、面板 id、投影键都不重叠。

## 执行与工作区

**Q: worktree 在哪？**
默认 `<repo>/.dsh-swarm/worktrees/<runId>/<taskId>`，并写入 `.git/info/exclude`，不会出现在 `git status`。设置 `workspace.root` 可改到其他可写目录。

**Q: 为什么授标失败？**
常见原因：`WORKTREE_LIMIT`（活跃 worktree 达到 `workspace.maxConcurrent`）、`DISK_LOW`（低于 `workspace.diskThresholdMb`）、`WIP_LIMIT`（成员任务已满）。降低并发或清理旧运行后重试。

**Q: 子代理没有执行？**
自动派发需要 `dispatch.auto` 或 `swarm_start` 的 `autoDispatch: true`，并且运行必须绑定父 Agent（`swarm_start` 或手动 `swarm_dispatch` 会绑定）。DSH 重启后需要先手动派发一次。没有 `ctx.subagents` 时派发会报 `NO_SUBAGENTS`，可继续用 `swarm_submit` 手动提交。

**Q: 子代理改完没提交怎么办？**
`dispatch.autoCommit: true`（默认）会自动 `git commit` 后再收集补丁。关闭后，worktree 脏会报 `WORKTREE_DIRTY`，需要先提交。

## 评审与合并

**Q: 需要几个评审？**
`review.reviewersPerPatch`（默认 2），quorum 按**实际分配的评审人数**计算，默认 2/3。作者不能评审自己的补丁；无证据的赞成票记为 `weak`，不计入 quorum。

**Q: 评审一直不投票？**
超过 `review.timeoutMs`（默认 10 分钟）自动记为弃权并留痕；没有有效赞成时任务转 `blocked`。所有评审都投票但无结论也会升级为 `blocked`（`swarm/review/escalated`）。

**Q: 合并冲突怎么处理？**
`swarm_merge` 返回 `MERGE_CONFLICT` 和冲突文件，集成分支自动回退；开启自动派发时，冲突卡会带回作者，作者在 worktree 内 `git merge swarm/<runId>/integration` 解决后重新提交。

**Q: 门禁失败但评审全票通过？**
不会合并。门禁优先于票数；合并后门禁失败会 `reset --hard` 回滚集成分支。

## 预算、面板与数据

**Q: 为什么预算一直是 0？**
只有真实子代理的 assistant 消息 usage 会入账；手动 `swarm_submit` 或 FakeRunner 不产生用量。USD 目前固定为 0（无稳定价目表），token 是主计量。

**Q: 面板空白/没有「蜂群」？**
确认 bundle 已安装且客户端产物被加载；刷新页面。没有运行时面板显示空状态引导，先 `swarm_start` 一次。

**Q: 数据与事件在哪？**
`$DSH_HOME/swarm/runs/<runId>/events.jsonl`、`snapshot.json`、`patches/*.diff`。事件是 append-only + SHA-256 哈希链，可用面板时间线回放。

**Q: 怎么导出成本？**
预算页「导出 CSV」，或 `GET /swarm/api/runs/<runId>/report.csv`。

**Q: 运行失败了怎么恢复？**
重启 DSH 后服务会回放事件，把 `running` 标为 `paused`；`swarm_intervene` 执行 `resume` 继续。已合并任务不会重复执行；working 任务的 worktree 保留供排查。

更多错误码见 [troubleshooting.md](./troubleshooting.md)。
