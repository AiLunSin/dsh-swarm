# 发布说明与检查清单

当前版本 **0.1.0**，已在本地 `desktop` profile 以目录链接方式安装并通过端到端验证。公开发布还差两件事：**npm 包名**与**真实模型基准**。

版本亮点与已知限制见 [release-notes-0.1.0.md](./release-notes-0.1.0.md)。

## 1. npm 包名冲突（阻塞公开发布）

需求单约定包名 `dsh-swarm`，但该名字已被占用：

```text
$ npm view dsh-swarm
name: dsh-swarm
version: 0.0.1
description: Multi-agent orchestration for dsh - one declarative swarm, auditable routing, hard budget caps. Name reserved; spec below; first release in development.
repository: https://github.com/dushaobindoudou/dsh-swarm
maintainer: dushaobindoudou
```

这是另一位开发者的同名预留包（不同实现）。不要覆盖、抢注或发布同名包。可选方案：

| 方案 | 包名 | 优点 | 代价 |
| --- | --- | --- | --- |
| A（推荐） | `@ailunsin/dsh-swarm` | 与 GitHub 仓库同 owner，语义清晰 | 需要创建/拥有 npm scope |
| B | `dsh-swarm-bundle` | 无 scope，当前可用 | 名字略长，与需求单不一致 |
| C | `dsh-swarm-plugin` | 无 scope，当前可用 | 同上 |
| D | 联系现所有者转让 | 保留 `dsh-swarm` | 不可控、耗时 |

确认方案后，用发布构建脚本生成改名副本，**不要手工全仓替换**：

```bash
# 方案 A（scoped）
node scripts/build-release.mjs --name @ailunsin/dsh-swarm

# 方案 B（无 scope）
node scripts/build-release.mjs --name dsh-swarm-bundle

# 产物在 dist/<name>/，package.json、cordis.patch.yml 行名、client module id 已一致
cd dist/dsh-swarm-bundle
npm pack --dry-run
```

脚本会校验三处名称一致并做 `node --check client.js`。发布工作流用 `--out dist/release` 固定输出目录，避免包名转义问题。当前已生成并验证两个变体：

- `dist/dsh-swarm-bundle/`：54 个文件，119.6 kB；
- `dist/ailunsin--dsh-swarm/`：54 个文件，119.6 kB。

`dsh-swarm-bundle` 变体已实际安装验证两次：

1. 目录安装：`swarm_status` 返回 `no swarm runs`、`/swarm/api/health` 正常、12 个工具注册；
2. tarball 安装：`dsh-swarm-bundle-0.1.0.tgz` 复制到包目录之外后安装，同样通过上述检查。

随后已切回源码目录链接。scoped 变体只做了 `npm pack --dry-run`，未安装（scope 归属待确认）。

> 本地 tarball 验证时，先把 `.tgz` 复制到包目录之外再安装；从产物目录内直接安装会让 pnpm/插件管理器清空源目录。

手工替换清单（脚本已自动处理 1–3 项，发布后仍需核对 4–5 项）：

1. `package.json` 的 `name`（以及 `repository`/`homepage`/`bugs`）。
2. `cordis.patch.yml` 中 `name: dsh-swarm` 的行（改用新包名）。
3. `client.js` 的 `__ModuleLoader__.load({ id })` 保持与包名一致。
4. README / docs / `dsh plugin add` 命令。
5. 重新安装并验证 `swarm_status` 与面板。

## 2. 发布前检查清单

- [ ] 包名冲突已按上表决策并全仓替换。
- [ ] `npm run lint`、`npm test`（92 用例）全绿。
- [ ] `npm run demo` 通过。
- [ ] `npm run bench` 生成 `bench/results/latest.*`；若做真实模型 bench，另存 `real-*.json`。
- [ ] `npm pack --dry-run` 文件清单包含 `src/`、`client.js`、`cordis.patch.yml`、`locale/`、`icon.svg`、`docs/`、`bench/`。
- [ ] `package.json` 的 `engines.dsh` 仍为 `>=0.2.2-rc.1 <0.3.0`。
- [ ] 浏览器人工验收面板七页、拓扑、时间线播放、CSV 下载。
- [ ] 配置默认值与 `docs/config.md` 一致。
- [ ] CHANGELOG 把 `[Unreleased]` 收口到本次版本。
- [ ] 准备 `NPM_TOKEN`（ Automation token）与 GitHub release 权限。

## 3. 本地打包验证

```bash
npm pack
# 产物：<name>-0.1.0.tgz
tar -tzf <name>-0.1.0.tgz | head
```

当前已验证 `npm pack --dry-run` 输出 41 个文件、约 90 KB（不含 bench 结果时更小），包含 host、client、locale、icon、docs、bench。

## 4. 发布步骤（命名确定后）

```bash
# 1. 登录或配置 token
npm login
# 或：export NODE_AUTH_TOKEN=...

# 2. 生成改名发布包（包名确定后）
node scripts/build-release.mjs --name <name>
cd dist/<dir>

# 3. 本地验证
npm pack --dry-run

# 4. 发布
npm publish --access public --provenance

# 5. 打 tag 触发 .github/workflows/release.yml
#    tag 推送只做构建 + 校验 + 打包检查，不会发布；真正发布需在
#    workflow_dispatch 中把 dry-run 设为 false（需先配置 secrets.NPM_TOKEN）。
#    包名默认 @ailunsin/dsh-swarm，也可在 workflow_dispatch 时传 package-name。
git tag v0.1.0 && git push origin v0.1.0
```

发布后验证：

```bash
npm view <name> version
dsh plugin add <name>
# 新会话执行 swarm_status 应返回 "no swarm runs"
```

## 5. 当前明确未完成

1. **真实模型 bench**：已完成两组单样本（2 任务：墙钟 1.27x/token 1.52x；3 任务：墙钟 1.37x/token 1.02x，per-task 墙钟 0.46x）。仍缺重复试验与一次通过率统计；`bench/results/latest.*` 的 fake runner 结果只测协调开销。
2. **npm 首发**：受包名与凭据阻塞。
3. **浏览器视觉验收**：本会话无浏览器控制，只验证了槽位注册与 HTTP 数据通道。
