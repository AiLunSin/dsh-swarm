# dsh-swarm（蜂群）

> 受控多 agent 协作的 DeepSeek Harness 组合包：共享蜂巢、任务市场、独立工作区、评审门禁、三层预算与可回放事件流。

当前版本 **0.1.1（M0–M3）**，已发布到 npm：[`@ailunsin/dsh-swarm`](https://www.npmjs.com/package/@ailunsin/dsh-swarm)。目标不是"开更多 agent"，而是让多个 agent 在同一个仓库上**可控地并行、交叉验证、花得住钱**。

- 需求与设计：[《dsh-swarm 需求单》](../dsh-swarm-需求单.md)、[《dsh-swarm 技术方案》](../dsh-swarm-技术方案.md)
- 架构说明：[docs/architecture.md](./docs/architecture.md)
- 配置参考：[docs/config.md](./docs/config.md)
- 需求覆盖：[docs/status.md](./docs/status.md)
- 常见问题：[docs/faq.md](./docs/faq.md) · 故障排查：[docs/troubleshooting.md](./docs/troubleshooting.md)
- 发布记录与下一版本清单：[docs/release.md](./docs/release.md) · 0.1.1 发布说明：[docs/release-notes-0.1.1.md](./docs/release-notes-0.1.1.md) · 0.1.0：[docs/release-notes-0.1.0.md](./docs/release-notes-0.1.0.md)
- npm：[`@ailunsin/dsh-swarm`](https://www.npmjs.com/package/@ailunsin/dsh-swarm)

---

## 1. 现在能做什么

已实现并测试通过的能力（0.1.0 + M1a/M1b）：

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 蜂群生命周期 | `swarm_start` / `swarm_intervene` | 创建、暂停、恢复、排水、中止、追加预算、强制收敛 |
| 任务市场 | `swarm_task` / `swarm_bid` | 任务 DAG、验收标准校验、竞价打分、防饥饿老化、强制指派 |
| 租约与 fencing | `swarm_submit` | 限时租约 + 单调 fence，过期租约自动回收并重播任务 |
| 成员消息 | `swarm_message` / `swarm_inbox` | 点对点请求/响应、主题广播、TTL、去重投递、限速折叠到黑板、跨运行拒绝 |
| 拓扑路由 | 消息总线 | mesh 全通；star/hierarchy 仅女王边；pipeline 仅相邻成员 |
| 异构评审 | 评审分配 | 可行时至少一名评审与作者的 model tier 不同 |
| 共享黑板 | `swarm_board` | 六类条目、TTL、置信度、容量淘汰、密钥脱敏、按权重与预算取 top-k |
| 信息素 | `swarm_board`（`deposit`） | 成功 / 警示 / 热度三种信号，按半衰期挥发，查询时即时衰减 |
| 交叉评审 | `swarm_review` | 非作者评审、证据校验、quorum 计票、blocking 一票否决、弱赞成票不计入、僵持升级 blocked |
| 隔离工作区 | `swarm_task`（授标时） | 一任务一 git worktree + 一分支，补丁从 commit 自动收集，不污染用户仓库 |
| 真实成员执行 | `swarm_dispatch` | 用宿主 `ctx.subagents` 在任务 worktree 内启动子代理；自动提交、收集 diff、开评审 |
| 动态成员 | `swarm_intervene` | 运行中增删 worker/reviewer；女王不可移除，忙成员和在审成员拒绝退休 |
| 自动调度 | tick + `dispatch.auto` | `autoDispatch` 开启后 tick 自动派发就绪任务；冲突带冲突卡自动回到作者 |
| 评审超时 | tick | 超时评审记弃权且不阻塞合并；没有有效赞成时任务退回 `blocked` |
| 工作区治理 | 授标 / 收敛 | worktree 并发上限、磁盘阈值、`keep=false` 时收敛后自动清理 |
| Web 面板 | 侧边栏「蜂群」 | 概览 / 成员 / 任务 / 拓扑 / 蜂巢 / 时间线 / 预算七页，3 秒轮询，中英双语 |
| 时间线回放 | 面板时间线页 | 事件列表 + 拖拽定位 + 播放/暂停/单步 + 完整载荷 |
| 蜂巢视图 | 面板蜂巢页 | 黑板条目（类型/主题/置信度/TTL）、信息素轨迹、消息元数据 |
| 成本拆分 | 预算页 | 按任务/成员/角色的成本条，运行/任务/成员/角色账本 CSV |
| 合并门禁 | `swarm_merge` | 合并前后各跑一次真实命令（lint/typecheck/test），失败自动打回或回滚集成分支 |
| 串行合并 | 服务层合并队列 | 集成分支单一写者，`--no-ff` 合并；冲突返回文件列表并交回作者 |
| 三层预算 | 服务 API | 运行 / 任务 / 成员三级，调用前预留、调用后结算，超限拒绝 |
| 实时用量 | `session/event` | 子代理每条 assistant 消息的 token 用量按运行/任务/成员入账，预算耗尽自动中止派发 |
| 停滞收敛 | tick + judge | 无活动派发且超过 `convergence.stallMs` 无进展 → 记录 judge 证据并收敛 |
| 轮次与裁判 | tick + judge | 一批在途工作结束即汇总 merges/gates/conflicts/spend，写 judge 并进入下一轮；预算风险/轮次上限自动收敛 |
| 自适应并发 | judge + `swarm/scale` | 队列积压且预算充裕时提高并发（上限 `maxConcurrent`），预算紧张/连续无合并时收缩 |
| 事件溯源 | 全部写操作 | append-only JSONL + SHA-256 哈希链 + 序号连续校验，崩溃后可回放 |
| 仓库预检 | `swarm_start` | 目录、写权限、磁盘、git、验收命令五项检查，失败给修复建议 |
| 本地 HTTP | `GET/POST /swarm/api/*` | 只监听回环；读接口开放，写接口（干预/建任务/合并）需 `http.token` |

**明确的边界（见路线图）**：CLI 与按模型价格计费尚未实现；Web 面板、npm 发布、bench 对照已完成。冲突自动回合已实现；成员执行通过 `swarm_dispatch` 或 `autoDispatch` 调用真实子代理，协调状态仍由蜂群服务统一记账。

---

## 2. 为什么需要它

DSH 已经能把任务委派给子 agent，也有一块共享任务板。但树形拓扑、Lead 手动派活、共享检出目录、没有蜂群级预算与评审，导致"能开很多 agent，但不敢开、开完收不住"。

蜂群的增量不在 agent 数量，而在三件事的基础设施：

1. **可并行的任务切分**：任务市场 + DAG + 文件范围声明。
2. **互相验证的评审**：非作者评审 + 测试证据 + 门禁优先于票数。
3. **失败后不重复踩坑的共享记忆**：黑板 + 信息素 + TTL。

对应到本项目的结构：`planner → worker → reviewer → judge`，每轮重启，单一写者合并。不做自由涌现。

---

## 3. 快速开始

### 3.1 安装到 DSH profile

```bash
# 已发布（npm）
dsh plugin add @ailunsin/dsh-swarm

# 本地开发目录（等价于在 Harness 里对目录执行 install_bundle）
dsh plugin add ./dsh-swarm
```

发布改名副本用 `node scripts/build-release.mjs --name <name>` 生成，脚本会同步包名、bundle 行名与 client module id。

安装后确认：

```text
swarm_start ...   # 工具列表里出现 12 个 swarm_* 工具
```

侧边栏会出现「蜂群」入口，点开是概览 / 成员 / 任务 / 拓扑 / 蜂巢 / 时间线 / 预算；没有运行时显示启动引导。

本仓库当前已按本地目录方式安装到 `desktop` profile；插件行 id 为 `dsh-swarm`。

### 3.2 无模型跑通一次完整蜂群

```bash
node scripts/demo.mjs
```

约 1 秒内完成：启动 3 人蜂群 → 建任务 → 竞价 → 授标 → 租约 → 预算预留/结算 → 提交补丁 → 两名非作者评审 → 合并 → 收敛。输出包含事件流尾部与最终账本。

### 3.3 在会话里使用

```text
swarm_start { goal: "给导出功能加 CSV 格式，带测试", repo: "C:/work/app", members: 3, autoDispatch: true }
swarm_task  { action: "create", title: "实现 toCsv", acceptance: ["npm test 通过"], files: ["src/export.js"] }
swarm_task  { action: "advertise", taskId: "task_..." }
swarm_bid   { taskId: "task_...", memberId: "member_...", reason: "熟悉 export 模块" }
swarm_task  { action: "award", taskId: "task_..." }   # 自动创建 worktree 与分支
swarm_dispatch { taskId: "task_...", memberId: "member_...", fence: 1, wait: false }
# 子代理在 worktree 内实现并提交；服务自动收集补丁并开评审。手动提交仍可用：
swarm_submit{ taskId: "task_...", memberId: "member_...", fence: 1,
              tests: [{ name: "csv", passed: true, output: "3 passed" }] }
swarm_review{ patchId: "patch_...", memberId: "member_...", verdict: "approve",
              evidence: ["npm test: 3 passed"] }
swarm_merge { patchId: "patch_..." }   # 服务自动跑门禁并串行合并
swarm_status{ detail: true }
```

`swarm_submit` 在 worktree 模式下自动收集 commit、diff、文件列表；非 git 或关闭工作区时仍需显式传 `branch`/`files`。`swarm_merge` 会在任务 worktree 与集成分支各跑一次门禁，冲突时返回文件列表并把任务退回作者。

---

## 4. 工具

| 工具 | 作用 | 关键约束 |
| --- | --- | --- |
| `swarm_start` | 创建并启动蜂群 | 预检失败默认拒绝；`single` 模式用于基线对照 |
| `swarm_status` | 快照 / 运行列表 | `detail: true` 附带黑板、评审、信息素、最近事件 |
| `swarm_task` | 建任务、列出、查询、广播、授标、取消 | 验收标准必填；依赖必须存在；WIP 超限拒绝 |
| `swarm_bid` | 对任务竞价 | 一人一标；评分可解释（返回五个分量） |
| `swarm_dispatch` | 启动真实 worker 子代理 | 在任务 worktree 内执行；自动提交、收集 diff、开评审 |
| `swarm_submit` | 提交补丁与证据 | 必须带租约 `fence`；worktree 模式下自动收集 commit/diff |
| `swarm_review` | 结构化评审投票 | 自评拒绝；无证据的赞成记为 `weak`，不计票 |
| `swarm_merge` | 合并已批准补丁 | 任务未批准拒绝；真实门禁失败回退任务或回滚集成分支 |
| `swarm_board` | 读写黑板 / 沉积信息素 | 写入前脱敏；单条 ≤ 8KB，单运行 ≤ 2MB |
| `swarm_message` | 点对点 / 主题广播 | 只能发给同运行成员；TTL、每发送者限速、跨运行拒绝 |
| `swarm_inbox` | 拉取成员信箱 | 至少一次投递 + 确认去重；`consume=false` 可只读 |
| `swarm_intervene` | 人类干预 | pause/resume/drain/abort/steer/budget/add_member/remove_member/converge，全部记入事件流 |

所有工具输出规范 JSON，可被 `run_code`（PTC）直接消费；人类可读摘要放在 `render`。

---

## 5. 配置

插件默认配置（`cordis.patch.yml` 只覆盖需要的字段）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `dataDir` | `''` | 空表示 `$DSH_HOME/swarm`；也可指向共享数据目录 |
| `members` | `3` | 默认蜂群规模（含蜂后） |
| `maxMembers` | `8` | 硬上限，尊重宿主 `maxActiveSubagents` |
| `topology` | `mesh` | `mesh` / `pipeline` / `star` / `hierarchy` |
| `budget.tokens` | `2000000` | 运行级硬预算 |
| `taskBudget.tokens` | `400000` | 单任务预算 |
| `memberBudget.tokens` | `800000` | 单成员预算 |
| `market.leaseMs` | `120000` | 任务租约时长 |
| `market.wipPerMember` | `2` | 成员并行任务上限 |
| `review.reviewersPerPatch` | `2` | 每个补丁的评审人数 |
| `review.quorum` | `0.667` | 通过比例（对非作者成员计） |
| `review.timeoutMs` | `600000` | 评审超时；超时记弃权并按已投票数计 quorum |
| `board.maxEntryBytes` | `8192` | 单条黑板容量 |
| `board.maxTotalBytes` | `2097152` | 单运行黑板总容量 |
| `pheromone.halfLifeMs` | `1800000` | 信息素半衰期 |
| `workspace.enabled` | `true` | 是否为一任务创建独立 worktree |
| `workspace.root` | `''` | 空表示 `<repo>/.dsh-swarm/worktrees`，自动写入 `.git/info/exclude`，不污染 `git status` |
| `workspace.maxConcurrent` | `6` | 同时持有 worktree 的任务上限 |
| `workspace.diskThresholdMb` | `2048` | 仓库所在盘余量低于该值时拒绝新 worktree |
| `workspace.keep` | `true` | `false` 时运行收敛/中止后自动移除 worktree（保留分支） |
| `gate.commands` | `[]` | 合并前后执行的门禁命令；空则自动探测测试命令 |
| `gate.timeoutMs` | `300000` | 单条门禁命令超时 |
| `dispatch.provider` | `spawn` | 宿主子代理 provider 名称 |
| `dispatch.timeoutMs` | `1800000` | 单次派发超时，同时用于延长任务租约 |
| `dispatch.auto` | `false` | tick 自动派发（需绑定父 Agent；也可用 `swarm_start` 的 `autoDispatch` 单次开启） |
| `dispatch.autoCommit` | `true` | 子代理未提交时自动 commit 后再收集补丁 |
| `messages.maxPerMinute` | `120` | 每发送者每分钟消息上限，超限折叠为黑板事实 |
| `messages.maxPayloadBytes` | `4096` | 单条消息载荷上限 |
| `messages.defaultTtlMs` | `300000` | 消息默认 TTL；过期自动标记 |
| `messages.maxInbox` | `200` | 单次拉取上限 |
| `orchestrator.tickMs` | `5000` | 调度心跳 |
| `prompt.enabled` | `true` | 是否注入蜂群协议分节 |
| `http.enabled` | `true` | 是否注册本地 HTTP API |
| `http.token` | `''` | 空表示禁用写接口；配置后 POST 需 Bearer/`x-swarm-token` |

字段级校验失败会在插件加载时直接报错，而不是等到第一个 tick。完整说明见 [docs/config.md](./docs/config.md)。

---

## 6. 数据与事件

```text
$DSH_HOME/swarm/runs/<runId>/
  events.jsonl    # append-only，seq 连续，SHA-256 哈希链
  snapshot.json   # 每 100 条事件或状态变化后原子写入
```

- **事件是唯一事实**：状态由 `applyEvent` 重放得出，UI/报表只读快照。
- **写入顺序**：先 fsync 事件，再改内存状态；返回成功即持久化成功。
- **恢复语义**：启动时扫描历史运行；`running` 的运行标记 `recovered` 并转 `paused`，租约在 tick 中立即过期回收。
- **篡改检测**：序号空洞、`prev` 断链、哈希不符都会在打开日志时报 `EVENT_LOG_CORRUPT`，不会静默接受。

---

## 7. 安全

- 成员由宿主创建并继承父级沙箱，蜂群层不提供提权路径。
- 黑板、事件、日志三处写入前都做密钥脱敏（`sk-`、`ghp_`、`AKIA`、Bearer、私钥、高熵串）。
- 越权消息与跨运行操作被拒绝并记安全事件。
- 本地 HTTP 仅接受回环地址；写接口默认关闭，配置 `http.token` 后可用 Bearer 或 `x-swarm-token` 调用。
- 仓库文本按不可信输入处理，不进入系统提示词的指令区。

漏洞报告方式见 [SECURITY.md](./SECURITY.md)。

---

## 8. 与内置能力的关系

| 能力 | 关系 |
| --- | --- |
| `ctx.subagents` | 真实成员执行载体：`swarm_dispatch` 通过它启动子代理，父代理为调用工具的 Agent |
| `agent-team` | 共存：Team 是任务板，Swarm 是"任务板 + 市场 + 黑板 + 工作区 + 评审"；不抢占其工具名与投影键 |
| `workflow` | 互补：固定 DAG 用 workflow，运行时涌现的任务切分用 swarm |
| `ctx.worktrees` | 宿主能力；蜂群使用自建 worktree 池（`<repo>/.dsh-swarm`，已排除 git status），因为要为成员预建目录且不改变调用方 cwd |

---

## 9. 路线图

| 里程碑 | 状态 | 内容 |
| --- | --- | --- |
| M0 骨架 | ✅ 0.1.0 | 事件、状态机、配置、服务、9 个工具、预检、测试、CI、文档 |
| M1 能干活 | 🟡 功能完成 | worktree、真实门禁、串行合并、真实子代理、自动派发与冲突自动回合；bench 对照待 M4 |
| M2 能收住 | ✅ | 评审超时/僵持、真实用量、停滞/轮次/自适应并发、面板四视图 |
| M3 能看懂 | ✅ | 拓扑图、时间线回放、成本拆分与 CSV、自适应并发 |
| M4 能发布 | ✅ | 已发布 npm `@ailunsin/dsh-swarm@0.1.1`；浏览器人工验收与更多真实 bench 样本待补 |

---

## 10. 开发

```bash
npm run lint          # node --check 所有源码
npm test              # node:test，93 个用例
npm run test:coverage # 当前行覆盖 86%
npm run demo          # 无模型端到端演练
npm run bench         # single vs swarm 确定性对照，输出 bench/results/
```

### 基准（真实模型，两轮单样本）

2026-11-13 在真实子代理上的两组对照（`npm test` 门禁）：

| 样本 | 模式 | 任务 | token | calls | 墙钟 | 质量 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 模块 | single | 1 | 6059 | 9 | 68.1s | 3/3 测试通过 |
| 2 模块 | swarm | 2 | 9221 | 14 | 86.2s | 3/3 测试通过 |
| 3 模块 | single | 1 | 11873 | 9 | 56.3s | 7/7 测试通过 |
| 3 模块 | swarm | 3 | 12105 | 19 | 77.0s | 5/5 测试通过 |

两轮总墙钟都是蜂群更慢（1.27x、1.37x），**没有达到 ≤70% 的目标**；但 3 模块轮的总 token 基本持平（1.02x），按任务摊薄墙钟 0.46x、token 0.34x。结论：蜂群改善吞吐而不是端到端延迟，小任务默认用 `single`。样本量各 1 次，不能据此宣称普遍收益。原始数据见 [2 模块](bench/results/real-latest.md) 与 [3 模块](bench/results/real-3task.md)。

- 纯 ESM，零运行时依赖；只用 Node 22+ 内置模块。
- 核心模块带 JSDoc 类型，事件与状态迁移是纯函数，便于确定性测试。
- 不提交 `node_modules/`、`worktrees/`、运行数据。

目录结构：

```text
src/
  index.js       # apply / 注入 / 定时器
  service.js     # SwarmService：生命周期、市场、蜂巢、预算
  project.js     # 事件 → 状态（唯一变更入口）
  events.js      # 哈希链事件日志 + 快照
  state.js       # swarm/task/member 状态机
  blackboard.js  # 条目、TTL、容量、脱敏、查询
  pheromone.js   # 沉积、挥发、扩散
  market.js      # 竞价评分、租约、fencing
  budget.js      # 三层账本、预留/结算
  review.js      # 评审、quorum、证据校验
  workspace.js   # 仓库预检、worktree、门禁、合并队列
  runner.js      # 真实子代理派发与任务卡
  tools.js       # 12 个 swarm_* 工具
  http.js        # 本地 HTTP：只读 API + token 保护的写接口
client.js        # Web 面板：概览 / 成员 / 任务 / 拓扑 / 蜂巢 / 时间线 / 预算
test/            # node:test 单元与 e2e
```

---

## 11. 许可证

MIT。见 [LICENSE](./LICENSE)。
