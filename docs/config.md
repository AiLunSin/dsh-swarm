# 配置参考

插件通过 `cordis.patch.yml` 的 `config` 传参。未提供的字段使用默认值；类型或范围非法的字段会在插件加载时抛 `CONFIG_INVALID`，并指出字段路径。

## 完整默认值

```yaml
dataDir: ''
members: 3
maxMembers: 8
topology: mesh            # mesh | pipeline | star | hierarchy
mode: swarm               # swarm | single

budget:
  tokens: 2000000
  usd: 0
  wallMs: 0               # 0 = 不限制
  hardStop: true

taskBudget:
  tokens: 400000

memberBudget:
  tokens: 800000

market:
  minScore: 0.3
  wipPerMember: 2
  leaseMs: 120000
  bidWindowMs: 60000
  agingRounds: 5

board:
  maxEntryBytes: 8192
  maxTotalBytes: 2097152
  defaultTtlMs: 0
  queryTokenBudget: 800

pheromone:
  halfLifeMs: 1800000
  success: 0.3
  warning: 0.5
  heat: 0.1
  diffuseAlpha: 0.05

review:
  reviewersPerPatch: 2
  quorum: 0.667
  timeoutMs: 600000
  requireEvidence: true

convergence:
  idleRounds: 3
  maxRounds: 50
  stallMs: 600000

orchestrator:
  tickMs: 5000
  autoStart: true

preflight:
  enabled: true
  minFreeMb: 256

workspace:
  enabled: true
  root: ''
  keep: true
  maxConcurrent: 6
  diskThresholdMb: 2048

gate:
  commands: []
  autoDetect: true
  timeoutMs: 300000

merge:
  strategy: merge

dispatch:
  provider: spawn
  timeoutMs: 1800000
  autoCommit: true
  auto: false

messages:
  maxPerMinute: 120
  maxPayloadBytes: 4096
  defaultTtlMs: 300000
  maxInbox: 200

prompt:
  enabled: true

http:
  enabled: true
  token: ''
```

## 字段说明

| 字段 | 类型 | 约束 | 作用 |
| --- | --- | --- | --- |
| `dataDir` | string | 绝对路径或空 | 运行数据根目录；空表示 `$DSH_HOME/swarm`，每个 run 在 `runs/<runId>/` 下 |
| `members` | integer | 1..`maxMembers` | 默认成员数（含蜂后）；`single` 模式固定 1 |
| `maxMembers` | integer | 1..32 | 蜂群规模硬上限 |
| `topology` | enum | 四种之一 | 通信拓扑；0.1.0 记录语义，M1 强制路由 |
| `mode` | enum | `swarm` / `single` | `single` 用于基线对照与成本兜底 |
| `budget.tokens` | integer | ≥ 1000 | 运行级 token 硬上限 |
| `budget.usd` | number | ≥ 0 | 运行级费用上限；0 表示不启用 |
| `budget.wallMs` | integer | ≥ 0 | 墙钟上限；0 表示不限制 |
| `budget.hardStop` | boolean | — | 超限时中止运行（默认）还是仅告警 |
| `taskBudget.tokens` | integer | ≥ 1 | 单任务默认预算，也是竞价成本归一化分母 |
| `memberBudget.tokens` | integer | ≥ 1 | 单成员累计预算 |
| `market.minScore` | number | 0..1 | 竞价进入授标比较的最低分 |
| `market.wipPerMember` | integer | 1..8 | 成员并行任务上限 |
| `market.leaseMs` | integer | 5000..86400000 | 任务租约时长，过期自动回收 |
| `market.bidWindowMs` | integer | 1000..3600000 | 竞价窗口（M1 用于到期授标） |
| `market.agingRounds` | integer | 1..100 | 防饥饿老化因子饱和轮数 |
| `board.maxEntryBytes` | integer | 256..1048576 | 单条黑板条目上限 |
| `board.maxTotalBytes` | integer | 1024..67108864 | 单运行黑板总量，超限按权重淘汰 |
| `board.defaultTtlMs` | integer | ≥ 0 | 未指定 TTL 时的默认值；0 表示不过期 |
| `board.queryTokenBudget` | integer | 64..32000 | 查询结果的 token 预算 |
| `pheromone.halfLifeMs` | integer | 5 分钟..240 分钟 | 信息素半衰期 |
| `pheromone.success/warning/heat` | number | 0..10 | 三类信号的默认沉积量 |
| `pheromone.diffuseAlpha` | number | 0..0.5 | 扩散到相邻主题的比例 |
| `review.reviewersPerPatch` | integer | 1..7 | 每个补丁分配的评审人数 |
| `review.quorum` | number | 0.5..1 | 通过所需的有效赞成比例 |
| `review.timeoutMs` | integer | 10 秒..24 小时 | 评审超时；超时记弃权，按已投票数计 quorum；无赞成则任务 blocked |
| `review.requireEvidence` | boolean | — | 赞成票是否必须带证据，否则记 `weak` |
| `convergence.idleRounds` | integer | 1..100 | 预留：停滞目前按 `stallMs` 时间窗判定 |
| `convergence.maxRounds` | integer | 1..10000 | 轮次硬上限，达到后以 `max_rounds` 收敛 |
| `convergence.stallMs` | integer | ≥ 60 秒 | 无进展多久后 judge 收敛 |
| `orchestrator.tickMs` | integer | 500..60000 | 调度心跳间隔 |
| `orchestrator.autoStart` | boolean | — | 创建后是否立即进入 `running` |
| `preflight.enabled` | boolean | — | 是否在创建前检查仓库 |
| `preflight.minFreeMb` | integer | ≥ 0 | 磁盘最低余量 |
| `workspace.enabled` | boolean | — | 是否为一任务创建独立 worktree |
| `workspace.root` | string | 绝对路径或空 | worktree 根目录；空表示 `<repo>/.dsh-swarm/worktrees`（自动加入 `.git/info/exclude`） |
| `workspace.keep` | boolean | — | `false` 时运行收敛/中止后移除 worktree，保留分支与补丁 |
| `workspace.maxConcurrent` | integer | 1..32 | 同时持有 worktree 的任务上限，超限拒绝新授标 |
| `workspace.diskThresholdMb` | integer | ≥ 0 | 低于该余量时拒绝新建 worktree（`DISK_LOW`） |
| `gate.commands` | string[] | ≤ 20 条，每条 ≤ 500 字符 | 合并前（任务 worktree）与合并后（集成分支）执行；空则自动探测 |
| `gate.autoDetect` | boolean | — | 未配置命令时使用预检探测到的测试命令 |
| `gate.timeoutMs` | integer | 1000..3600000 | 单条门禁命令超时 |
| `merge.strategy` | enum | `merge` | 0.1.0 仅支持 `--no-ff` 合并 |
| `dispatch.provider` | string | — | 宿主子代理 provider（默认 `spawn`） |
| `dispatch.timeoutMs` | integer | 30000..14400000 | 单次派发超时；租约会延长到覆盖该窗口 |
| `dispatch.autoCommit` | boolean | — | 子代理未提交时自动 `git commit` 后再收集补丁 |
| `dispatch.auto` | boolean | — | tick 自动派发就绪任务；需由 `swarm_start` 绑定父 Agent（重启后先手动派发一次），也可用 `swarm_start` 的 `autoDispatch` 单次开启 |
| `messages.maxPerMinute` | integer | 1..10000 | 每发送者每分钟消息上限，超限折叠为黑板 `throttled` 事实 |
| `messages.maxPayloadBytes` | integer | 64..1048576 | 单条消息载荷上限 |
| `messages.defaultTtlMs` | integer | 1 秒..24 小时 | 消息默认 TTL；投递/拉取时过期会记 `swarm/message/expired` |
| `messages.maxInbox` | integer | 1..10000 | 单次 `swarm_inbox` 返回上限 |
| `prompt.enabled` | boolean | — | 是否注入蜂群协议系统提示分节 |
| `http.enabled` | boolean | — | 是否注册本地只读 + 写 HTTP API |
| `http.token` | string | 空或 ≥16 字符建议 | 空表示禁用写接口；非空时 POST 需 `Authorization: Bearer` 或 `x-swarm-token` |

## 覆盖示例

```yaml
# <profile>/cordis.patch.yml
- id: dsh-swarm
  name: dsh-swarm
  config:
    dataDir: 'D:/swarm-data'
    members: 4
    budget:
      tokens: 3000000
      wallMs: 3600000
    review:
      reviewersPerPatch: 2
      quorum: 0.75
      requireEvidence: true
    http:
      enabled: true
```

按 Loader 规则，`config` 是整体替换而不是深合并，所以覆盖时必须重述该分节需要的所有字段。

## 数据位置

| 内容 | 路径 |
| --- | --- |
| 事件日志 | `<dataDir>/runs/<runId>/events.jsonl` |
| 快照 | `<dataDir>/runs/<runId>/snapshot.json` |
| 补丁 diff | `<dataDir>/runs/<runId>/patches/<patchId>.diff` |
| 任务 worktree | `<workspace.root>/<runId>/<taskId>`；默认 `<repo>/.dsh-swarm/worktrees/<runId>/...` |
| 集成分支 worktree | `<workspace.root>/<runId>/integration` |
| 默认 `dataDir` | `$DSH_HOME/swarm`（`DSH_HOME` 默认 `~/.dsh`） |
| 默认 `workspace.root` | `<repo>/.dsh-swarm/worktrees` |

worktree 默认位于仓库内 `.dsh-swarm/worktrees`（子代理沙箱以仓库为工作区，放在仓库外会被拒绝写），并通过 `.git/info/exclude` 排除，因此 `git status` 保持干净。分支命名为 `swarm/<runId>/task/<taskId>` 与 `swarm/<runId>/integration`；显式配置 `workspace.root` 可放到其他可写位置。

## 校验与错误

- 非法字段抛 `SwarmError`，`code = CONFIG_INVALID`，`details.field` 指向具体字段。
- `members > maxMembers` 直接拒绝。
- `review.quorum` 超出 0.5–1 直接拒绝。
- 运行期的错误码：`RUN_NOT_FOUND`、`RUN_NOT_RUNNING`、`RUN_ENDED`、`TASK_NOT_FOUND`、`TASK_INVALID_STATE`、`STALE_LEASE`、`LEASE_EXPIRED`、`BUDGET_EXCEEDED`、`SELF_REVIEW`、`NOT_REVIEWER`、`BOARD_CONFLICT`、`EVENT_LOG_CORRUPT`、`WORKTREE_FAILED`、`WORKTREE_DIRTY`、`NO_CHANGES`、`GATE_FAILED`、`MERGE_CONFLICT`、`MERGE_FAILED`。
