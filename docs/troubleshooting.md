# 故障排查

先看 `swarm_status { detail: true }` 与面板时间线；大多数问题都能在事件流里定位。事件日志在 `$DSH_HOME/swarm/runs/<runId>/events.jsonl`。

## 启动与安装

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `CONFIG_INVALID` | 配置字段类型/范围不对 | 按报错 `details.field` 修 `cordis.patch.yml`；`config` 是整体替换，不要只写半个分节 |
| 工具列表没有 `swarm_*` | bundle 未启用或插件加载失败 | `dsh plugin add dsh-swarm`；查看 profile 日志与插件页诊断 |
| 面板没有「蜂群」 | 客户端产物未加载 | 刷新页面；确认 `dsh.client` 与 `exports['./client']` 未被改动 |
| `PLUGIN_ENGINE_MISMATCH` / 版本不满足 | DSH 不在 `>=0.2.2-rc.1 <0.3.0` | 升级/切换 DSH，或调整 `engines.dsh` 前先做契约测试 |

## 启动蜂群

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `PREFLIGHT_FAILED` | 目录、权限、磁盘或 git 检查失败 | 看 `details.preflight.fixes`；修好后重试，或 `force: true` 跳过（不推荐） |
| `INVALID_GOAL` | goal 为空 | 给一句可验收的目标 |
| `TOO_MANY_MEMBERS` | 超过 `maxMembers` | 降低 members 或调大上限（≤8 建议） |

## 工作区与派发

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `WORKTREE_FAILED` | `git worktree add` 失败 | 检查分支是否已存在、路径是否被占用、git 版本 ≥2.40；失败会降级为补丁模式并记 `workspace/degraded` |
| `WORKTREE_LIMIT` | 活跃 worktree 达到 `workspace.maxConcurrent` | 等待任务合并/清理，或调大上限 |
| `DISK_LOW` | 磁盘低于阈值 | 清理磁盘或调低 `workspace.diskThresholdMb` |
| `WORKTREE_DIRTY` | 子代理/工蜂没有提交 | `git add -A && git commit` 后重新 `swarm_submit`；或开启 `dispatch.autoCommit` |
| `NO_CHANGES` | worktree 相对基线没有新提交 | 确认改动已提交到任务分支 |
| `NO_WORKTREE` | 派发需要 worktree | 当前仓库不是 git 或评分关闭了 workspace；改用手动 `swarm_submit` |
| `NO_SUBAGENTS` | 宿主没有子代理服务 | 检查 DSH 版本/组合；手动提交补丁仍可用 |
| `subagent depth ... exceeds maxDepth` | 子代理层级限制 | 插件已用 `maxDepth: 1`；不要从 worker 再派孙代理 |

## 评审与合并

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `SELF_REVIEW` | 作者给自己投票 | 换非作者评审 |
| `NOT_REVIEWER` | 不在该补丁的评审名单 | 用 `swarm_status detail` 的 `reviewers` |
| `GATE_FAILED` | 门禁命令失败 | 看 `details.gate.checks[].output`；修复后重新提交 |
| `MERGE_CONFLICT` | 与集成分支冲突 | 作者在 worktree 合并集成分支、解决冲突后重新提交；集成分支已回退 |
| `MERGE_FAILED` | git merge 其他失败 | 看 `details.stderr`；检查 index.lock、权限、分支是否存在 |
| 任务卡在 `reviewing` | 评审未投/超时 | 等待 `review.timeoutMs` 自动弃权，或让评审投票；全部投票无结论会 blocked |
| 任务 `blocked` | 评审僵持/超时无赞成 | 人工裁决后重新广播或强制派发 |

## 预算与收敛

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `BUDGET_EXCEEDED` | 预留超过运行/任务/成员余额 | 追加预算 `swarm_intervene {action:'budget', tokens}` 或缩小任务 |
| 预算不增长 | 没有真实子代理用量 | 只有子代理 assistant 消息 usage 入账；手动提交不计量 |
| 运行被 `budget` 中止 | 硬上限耗尽 | 追加预算后 resume；或下次调大预算 |
| 运行被 `stalled_no_progress` 收敛 | 超过 `stallMs` 无进展 | 检查是否有 blocked 任务/无人评审；resume 或重派 |
| 运行被 `max_rounds` 收敛 | 达到轮次上限 | 调大 `convergence.maxRounds` 或拆小目标 |

## 数据与恢复

| 错误码/现象 | 含义 | 处理 |
| --- | --- | --- |
| `RUN_NOT_FOUND` | runId 不存在/已清理 | `swarm_status` 列出当前运行 |
| `RUN_NOT_RUNNING` | 运行 paused/ended | `swarm_intervene {action:'resume'}` |
| `RUN_ENDED` | 已终止 | 新建运行；产物保留在数据目录 |
| `EVENT_LOG_CORRUPT` | 哈希链/序号校验失败 | 不要手改 `events.jsonl`；从快照/备份恢复，或保留现场排查 |
| 重启后运行变 paused | 恢复语义 | resume 后租约在 tick 中回收，working 任务可继续 |
| 磁盘占用大 | worktree/补丁/事件累积 | `workspace.keep: false`；定期清理 `$DSH_HOME/swarm/runs` 与 `<repo>/.dsh-swarm` |

## 收集诊断信息

```bash
swarm_status { detail: true }          # 当前快照、评审、事件尾部
node scripts/check-syntax.mjs          # 源码语法
npm test                               # 协调层回归
npm run bench                          # 确定性对照
```

报告问题时附：DSH 版本、Node 版本、`swarmId`、错误码、事件尾部（已脱敏）。
