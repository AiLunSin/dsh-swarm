# 架构说明

本文记录 0.1.0 的实现结构与不变量。需求编号（FR-*）引用《dsh-swarm 需求单》。

## 1. 分层

```text
会话 / 工具调用 / HTTP
        │
        ▼
SwarmService（单例，按 run 隔离）
  ├─ EventLog      哈希链 JSONL + 快照
  ├─ 状态投影      project.js：applyEvent / replay
  ├─ 市场          market.js：竞价评分、租约、fencing
  ├─ 蜂巢          blackboard.js + pheromone.js
  ├─ 评审          review.js：非作者、证据、quorum
  ├─ 预算          budget.js：运行/任务/成员三级账本
  └─ 工作区        workspace.js：worktree 池、门禁、串行合并
        │
        ▼
宿主能力（后续里程碑接入）
  ctx.subagents / ctx.jobs / ctx.webServer
```

设计原则是"不造 agent 运行时，只造蜂群层"。工作区与合并门禁已落地；成员执行层通过 `ctx.subagents` 在 M1 后半段接入。

## 2. 事件溯源

每运行一份 `events.jsonl`：

```json
{"v":1,"seq":1,"id":"evt_...","runId":"swarm_...","type":"swarm/created",
 "at":1763000000000,"actor":"human","causationId":null,
 "payload":{...},"prev":"genesis","hash":"<sha256>"}
```

- `hash = sha256(stableStringify(除 hash 外的整个事件))`，`prev` 指向上一条的 hash。
- 打开日志时校验：JSON 可解析、`seq` 从 1 连续、`runId` 一致、`prev` 断链、`hash` 匹配。任一失败抛 `EVENT_LOG_CORRUPT`，不会静默跳过。
- 写入流程：`scrub(payload)` → 组事件 → `write + fsync` → 入内存 → 通知监听者。
- 状态变更流程：先 `append` 成功，再 `applyEvent`。`applyEvent` 会 `structuredClone` payload，避免状态里的嵌套对象反向修改已写事件（这曾导致哈希漂移，测试 `service.test.js` 覆盖）。

事件类型（0.1.0）：

```text
swarm/created            swarm/status/changed      swarm/recovered
swarm/member/joined      swarm/member/updated      swarm/member/left
swarm/task/created       swarm/task/advertised     swarm/bid/submitted
swarm/task/awarded       swarm/task/working        swarm/task/submitted
swarm/task/state         swarm/task/merged         swarm/review/opened
swarm/vote/cast          swarm/board/written       swarm/board/removed
swarm/pheromone/updated  swarm/budget/reserved     swarm/budget/settled
swarm/budget/released    swarm/budget/adjusted     swarm/tick
swarm/intervened         swarm/converged           swarm/aborted
swarm/security/rejected  swarm/message/expired
```

未知类型在重放时忽略，便于新版本写入、旧版本读取。

## 3. 状态机

三套状态机集中在 `state.js`，服务层每次迁移前调用 `assertTransition`：

```text
Swarm:  created → running ⇄ paused → draining → converged | aborted | failed
Task:   draft → advertised → bidding → awarded → working → submitted
              → reviewing → approved → merged
              ↘ blocked / failed / cancelled / expired(lease)
Member: joining → idle ⇄ busy → draining → left | lost
```

`allocated` 的租约带 `fence`（单调递增）与 `expiresAt`。提交时必须同时匹配 `memberId` 与 `fence`；过期租约在 tick 中回收：`expired → advertised`，旧持有者的写入被 `STALE_LEASE` 拒绝。

### 3.1 轮次

一轮 = 一批派发 + 评审 + 合并。tick 检查：没有活动派发、没有在途任务、队列仍有 ready 任务、且本轮有活动时，judge 汇总 `merges / gateFailures / conflicts / votes / spend / completion`，写 `swarm/judge` 与 `swarm/round`，轮次 +1；预算使用 ≥90% 且完成度 <50% 时以 `budget_risk` 收敛，达到 `maxRounds` 时以 `max_rounds` 收敛。没有活动的空队列不会推进轮次，交给停滞检测。

并发槽 `state.concurrencyLimit` 初始为 `min(3, workspace.maxConcurrent)`；在 queue 积压且预算 <70% 时每轮 +1，在预算 >80% 或连续两轮无合并时 -1（下限 2），写 `swarm/scale`。自动派发使用该槽位，worktree 创建仍受 `workspace.maxConcurrent` 硬上限约束。评审全部投票但既不过也不拒（如全部弃权）时写 `swarm/review/escalated` 并把任务置 `blocked`。

### 3.2 消息总线

- 信封：`id, from, to (memberId | topic:<name>), kind(request/response/broadcast/event), topic, correlationId, payload, sentAt, expiresAt, deliveredTo[], status`。
- 发送校验：发送者与点对点目标必须属于同一 run；广播必须带 topic；payload ≤ `messages.maxPayloadBytes`；每发送者每分钟上限，超限折叠为黑板 `throttled` 事实。
- 拓扑路由：`mesh` 全通；`star`/`hierarchy` 只允许女王参与的边；`pipeline` 只允许按加入顺序相邻的成员（女王例外）；违规写 `swarm/security/rejected` 并抛 `TOPOLOGY_FORBIDDEN`。
- 投递：`swarm_inbox` 按成员过滤（点对点目标或非自身的主题广播），返回未确认消息；`consume=true` 写 `swarm/message/delivered` 并去重，`consume=false` 只读。
- TTL：过期消息跳过并写 `swarm/message/expired`；tick 主动清理。
- 事件：`swarm/message/sent` / `delivered` / `expired`，载荷经过统一脱敏；跨运行目标返回 `MEMBER_NOT_FOUND`。

## 4. 市场

```text
score = 0.35*capability + 0.20*idle + 0.25*successRate
      + 0.10*aging - 0.30*normalizedCost
```

- `capability`：任务 tags / 文件扩展名与成员技能、角色的匹配度。
- `idle`：`1 - load/wipPerMember`。
- `successRate`：贝叶斯平滑，冷启动 0.5。
- `aging`：`min(1, waitingRounds/agingRounds)`，防饥饿。
- `normalizedCost`：预估 token / 任务预算。

授标只做一次 `argmax`，不做多轮议价。若没有超过阈值的竞价，回退顺序为：最佳低价竞价 → 女王指派（`force` 必须带理由）→ `NO_BIDS`。WIP 超限直接拒绝。

## 5. 蜂巢

- 六类条目：`fact` / `decision` / `hypothesis` / `warstory` / `lock` / `artifact`。
- TTL 到期后不进入默认查询，`includeExpired` 可查历史（FR-3.2）。
- 排序权重：`confidence × recency × (0.5 + 0.5 × pheromone)`，按 token 预算截断并标记 `truncated`。
- 写入前脱敏；单条 ≤ 8KB；总量超 2MB 时按权重淘汰并记 `swarm/board/removed(reason='capacity')`。
- 信息素只存 `w0/t0`，读取时按半衰期即时衰减；挥发不产生全量写事件。

## 6. 成员执行（M1b）

`swarm_dispatch` 把"协调"与"执行"分开：

1. 服务在 run 锁内校验任务、worktree 与租约，把租约延长到覆盖派发超时，构造固定前缀的任务卡。
2. 通过 `ctx.subagents.startActivation({ provider: 'spawn', parent: 调用工具的 Agent, cwd: worktree, prompt, outputSchema, maxDepth: 1, delivery: 'caller' })` 启动真实子代理。
3. 子代理在自己的 worktree 内改码、跑测试、`git commit`，返回 `{summary, tests, risks}` 结构化 handoff。
4. 服务记录 `swarm/dispatch/finished`；若子代理漏提交则按配置自动 commit，然后调用 `submitPatch` 收集 diff 并开评审。
5. 失败、超时或停止原因非 `completed` 时记 `swarm/dispatch/failed`，任务保持 `awarded`/`working`，租约仍有效，可重试。

约束：子代理 `maxDepth: 1`，不能再派孙代理；继承父级沙箱与审批策略；没有 `ctx.subagents` 时派发报 `NO_SUBAGENTS`，手动 `swarm_submit` 仍可用。

开启 `dispatch.auto` 后，tick 会对 `awarded` 任务与"冲突后退回 working"的任务自动派发；失败派发退避 2 分钟，避免坏子代理打转。冲突任务的任务卡会附带 `## Conflict to resolve`，要求作者在 worktree 内 `git merge swarm/<runId>/integration`、解决冲突、跑测试并提交。

## 7. 工作区、门禁与合并

一任务一 worktree、一分支：

```text
<dataDir>/worktrees/<runId>/<taskId>        # 任务 worktree
<dataDir>/worktrees/<runId>/integration     # 集成分支 worktree
swarm/<runId>/task/<taskId>                 # 任务分支
swarm/<runId>/integration                   # 集成分支
```

- worktree 默认位于仓库内 `.dsh-swarm/worktrees`（子代理沙箱以仓库为工作区），并通过 `.git/info/exclude` 排除，`git status` 不被污染。
- 授标时创建（失败则记 `swarm/workspace/degraded` 并降级为补丁模式）。
- 提交前要求 commit 干净；服务用 `git diff base..HEAD` 收集文件、stat 与 diff，写入 `runs/<runId>/patches/<patchId>.diff`。
- 门禁：`gate.commands`（或预检探测到的测试命令）先在任务 worktree 跑一次，合并后在同一分支的集成分支再跑一次；任一失败都记 `swarm/task/gate` 并把任务退回 `working`，合并后失败还会 `git reset --hard` 回滚。
- 合并队列按仓库串行（`--no-ff`），冲突时 `git merge --abort`，返回冲突文件并记 `swarm/merge/conflict`；作者在 worktree 内解决后重新提交。
- 所有 git 写操作经过仓库级互斥锁，避免 Windows 上的 `index.lock` 竞争。
- 授标前检查并发上限（`workspace.maxConcurrent`）与磁盘余量（`workspace.diskThresholdMb`），超限拒绝并保持任务 `advertised`。
- `workspace.keep: false` 时，收敛/中止后移除 task 与 integration worktree，保留分支与补丁文件。
- 0.1.0 的门禁与合并仍在 run 锁内执行，会阻塞同一运行的其他命令；M2 拆出独立合并 worker。

## 8. 评审与门禁

- 成员名单运行中可增减：`swarm_intervene add_member` 新增 worker/reviewer（受 `maxMembers` 限制、名字唯一），`remove_member` 退休非女王成员；仍有归属任务或未完成评审的成员返回 `MEMBER_BUSY`。退出成员保留在快照中供审计，但不再参与派发、竞价与评审。
- 评审人从非作者成员中按负载挑选，作者不能给自己投票；可行时保证至少一名评审与作者的 model tier 不同（FR-6.7）。
- 通过条件：有效赞成票 ≥ `ceil(非作者人数 × quorum)`，且没有 blocking、没有 request_changes。
- 无证据的赞成票记为 `weak`，不计入 quorum（FR-6.8 的配套约束）。
- 超时评审由 tick 自动转成 `abstain` 并记 `swarm/review/timeout`；此时 quorum 按已投出的票计，超时本身不阻塞合并。没有有效赞成时任务转 `blocked`，等待人工或重派。
- 门禁与评审分离：评审只决定"是否放行"，真实门禁决定"是否正确"。`mergePatch` 在门禁失败时抛 `GATE_FAILED`，即使全票通过也不合并。

## 9. 预算

```text
reserve(scope, key, tokens) → reservationId
settle(reservationId, actual) → 释放预留、记实际用量
release(reservationId) → 取消预留
```

- 预留同时检查运行、任务、成员三级余额；任一不足即 `BUDGET_EXCEEDED`。
- 结算时计算 `drift = |actual - reserved| / reserved`，> 20% 供后续校准。
- 真实子代理用量通过宿主 `session/event` 的 `assistant/message.usage` 归集：插件按 child session id 找到 run/task/member，追加 `swarm/budget/charged`，同时记账三级；硬上限触发时立即 abort 在跑的派发，下一次 tick 中止运行。
- 费用（USD）暂按 0 记录：没有稳定的模型价目表，token 是主计量；价格接入在 M3 成本报告里做。
- 成本 CSV 输出 run/task/member/role 四类行；面板预算页按任务、成员、角色分别画成本条。
- 硬上限触发 `swarm/aborted(reason='budget' | 'wall_clock')`，保留现场。

## 10. 恢复

启动时扫描 `$DSH_HOME/swarm/runs/*/events.jsonl`：

1. 打开并校验哈希链；
2. 全量重放得到状态；
3. 若原状态是 `running`，追加 `swarm/recovered` 与 `swarm/status/changed(paused)`；
4. 写快照；租约在第一次 tick 中过期并重新广播。

已 `merged` 的任务不会再次执行；`working` 任务保留 worktree 供取证，恢复后仍可继续提交或合并。

## 11. 测试

- 单元：状态机、事件链、脱敏、黑板容量、信息素单调性、竞价排序、租约、预算、评审 quorum。
- 工作区（真实 git）：worktree 隔离、补丁收集、门禁通过/失败、串行合并、冲突回退、合并后回滚。
- 派发：FakeRunner 覆盖成功、自动提交、失败、无 worktree 四条路径；真实路径通过 live smoke 验证。
- 治理：worktree 并发上限、磁盘阈值、收敛清理；评审超时弃权与 blocked 分支。
- 用量：`swarm/budget/charged` 把每条 assistant 消息的 token 记到运行/任务/成员；停滞 judge 收敛。
- 端到端：临时仓库 + 3 成员完整走完市场 → 工作 → 评审 → 合并 → 收敛；关闭服务后重新打开，校验状态与事件链。
- 覆盖率：`npm run test:coverage`。

## 12. Web 面板

- 清单：`package.json` 的 `dsh.client = { platform: 'web', immediately: true }`，`exports['./client'] = './client.js'`。
- 产物：`client.js` 用 `window.__ModuleLoader__.load({ id, factory(require) })` 注册惰性工厂；React 来自浏览器模块表，不重复打包。
- 槽位：`sidebar.panellist` 注册 `id: 'swarm'`（order 30），`main` 注册 `key: 'swarm'`，点击侧边栏即打开页面。
- 数据：每 3 秒轮询 `GET /swarm/api/runs` 与 `GET /swarm/api/runs/:id`；页面只在可见时运行，卸载时清理定时器与 AbortController。
- 视图：概览（目标、仓库、基线、集成分支、门禁、自动派发、统计、预算条、最近事件）、成员、任务（worktree/gate/conflict/merge 列）、拓扑（成员节点 + 评审/依赖边）、蜂巢（黑板条目/信息素/消息元数据）、时间线（事件游标/播放/单步/载荷）、预算（运行/任务/成员/角色账本 + 成本条 + CSV 导出）。
- 拓扑：快照 detail 输出 `topologyGraph.nodes/edges`（`topology` 字段仍是 mesh/pipeline 字符串）；边由评审票（author→reviewer）与任务依赖（上游作者→下游作者）聚合，客户端用 SVG 环形布局渲染，角色配色、边宽表权重。
- 成本导出：`GET /swarm/api/runs/:id/report.csv` 输出三级账本 CSV（scope,key,tokens,reserved_tokens,calls,usd）。
- 本地化：`ctx.locale.register('dshSwarm', { en, zh })`，通过 `ctx.locale.bind` 取文案；语言切换订阅后重渲染。
- 样式：全部取自 `--dsw-alias-*` 主题变量，支持深浅色；页面自带 `<style>`，卸载即移除。
- 验证：`Slots.listSubTree` 已确认 `sidebar.panellist` 出现 `swarm`、`main` 出现 `swarm` 占用；`/swarm/api/health` 与 `/runs` 返回正常。视觉渲染仍需在浏览器中人工确认（本会话无浏览器控制）。
- HTTP：读接口仅回环；写接口 `POST /runs/:id/intervene|tasks|merge` 需 `http.token`（Bearer 或 `x-swarm-token`），空 token 直接 403 `WRITE_DISABLED`，跨源写拒绝。

## 13. 下一步（M4）

1. **发布**：npm 包、语义化版本、release notes、GitHub Actions 发布任务。
2. **bench**：single 基线对照、toy suite、原始数据与报告。
3. **文档收尾**：FAQ、排障、配置默认值核对、面板七页人工验收。
