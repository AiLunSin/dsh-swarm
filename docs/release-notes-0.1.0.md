# dsh-swarm 0.1.0 release notes

首个公开版本，已发布到 npm：[`@ailunsin/dsh-swarm@0.1.0`](https://www.npmjs.com/package/@ailunsin/dsh-swarm)。把受控多 agent 蜂群做成可安装的 DSH 组合包。

## 亮点

- **事件溯源**：append-only JSONL + SHA-256 哈希链、快照、崩溃回放；事件是唯一事实。
- **任务市场**：验收标准、DAG、可解释竞价、fencing 租约、WIP 限制、强制指派。
- **共享蜂巢**：六类黑板条目、TTL、容量淘汰、密钥脱敏；成功/警示/热度信息素。
- **成员消息**：点对点请求/响应、主题广播、TTL、至少一次投递 + 确认去重、每发送者限速、跨运行拒绝。
- **动态成员**：运行中增删 worker/reviewer，女王不可移除，忙成员与在审成员拒绝退休。
- **拓扑感知路由**：mesh 全通；star/hierarchy 仅女王边；pipeline 仅相邻成员。
- **异构评审与角色成本**：可行时至少一名评审使用不同 model tier；成本按任务/成员/角色拆分。
- **隔离工作区**：一任务一 worktree（`<repo>/.dsh-swarm`，已排除 git status）、commit 自动收集 diff。
- **真实门禁**：合并前/后各跑一次命令，失败打回或回滚集成分支。
- **串行合并队列**：`--no-ff`，冲突自动回退并带冲突卡回到作者。
- **真实成员执行**：`swarm_dispatch` 通过 `ctx.subagents` 启动子代理；`autoDispatch` 让 tick 自动派发。
- **质量闭环**：非作者评审、证据校验、按实际评审人计 quorum、超时弃权、僵持升级。
- **成本闭环**：运行/任务/成员三级预算，真实子代理 token 用量入账，超限中止派发。
- **收敛与自适应**：停滞收敛、轮次 judge、预算风险/轮次上限收敛、并发槽扩缩。
- **Web 面板**：概览/成员/任务/拓扑/蜂巢/时间线/预算七页，中英双语，成本 CSV。

## 验证

- 93 个 `node:test` 用例，覆盖事件链、状态机、市场、租约、黑板、信息素、消息总线、拓扑路由、评审、预算、worktree、门禁、合并、冲突、派发、用量、停滞、轮次、扩缩、动态成员、拓扑、CSV、HTTP 写接口、发布构建、子代理激活。
- 真实子代理 live 验证：实现 `add()`、3/3 测试、commit、双评审、双门禁、合并、收敛；自动派发 run 产生 8 次 `swarm/budget/charged`，5629 tokens / 8 calls。
- `npm run demo`：真实 git + `npm test` 门禁的端到端演练。
- `npm run bench`：确定性 single vs swarm 对照（fake runner，仅协调开销）。

## 已知限制

1. **发布名使用 scope**：无 scope 的 `dsh-swarm` 仍属另一位作者；本版本发布为 `@ailunsin/dsh-swarm`。
2. **真实模型 bench 只有两组单样本**：2 模块轮 swarm 总墙钟 1.27x/token 1.52x；3 模块轮 1.37x/1.02x，per-task 墙钟 0.46x。总墙钟均未达 ≤70% 目标，需要更大 suite 与重复试验。
3. **面板未浏览器人工验收**：槽位注册与 HTTP 数据已验证，视觉/交互仍需人工确认。
4. 拓扑边仅来自评审与任务依赖，未把消息往来画成边；成本无模型维度；USD 固定 0。
5. 成员可动态增减，但新增成员从 idle 开始，不继承历史负载；退出成员保留用于审计。
6. 门禁与合并在 run 锁内执行，长门禁会阻塞同一运行的其他命令。

## 快速开始

```bash
dsh plugin add @ailunsin/dsh-swarm
node scripts/demo.mjs
npm test
npm run bench
# 在 DSH 中：
swarm_start { goal: "...", repo: "C:/work/app", members: 3, autoDispatch: true }
```

详细安装与发布步骤见 [release.md](./release.md)。
