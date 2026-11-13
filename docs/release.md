# 发布说明与检查清单

## 当前状态（2026-11-13）

- 已发布：**`@ailunsin/dsh-swarm@0.1.1`**（npm registry）。0.1.0 为同日首个版本，因 DSH 0.2.2-rc.3 的 `startActivation` 接口变化导致真实派发失败，已被 0.1.1 取代。
- 发布者/维护者：`ailunsin`。
- 0.1.1 已从 registry 安装到本机 `desktop` profile 并验证（详见发布后验证）。
- 无 scope 的 `dsh-swarm` 仍由另一位作者预留（`dushaobindoudou@0.0.1`），**未覆盖、未抢注**；本项目使用 scoped 名发布。

安装：

```bash
dsh plugin add @ailunsin/dsh-swarm
```

0.1.0 与 0.1.1 的差异见 [release-notes-0.1.0.md](./release-notes-0.1.0.md) 与 [release-notes-0.1.1.md](./release-notes-0.1.1.md)。

## 包名决策（已解决）

| 方案 | 包名 | 状态 |
| --- | --- | --- |
| A | `@ailunsin/dsh-swarm` | **已采用并发布** |
| B | `dsh-swarm-bundle` | 备用，未发布 |
| C | `dsh-swarm-plugin` | 未使用 |
| D | 联系现所有者转让 `dsh-swarm` | 未进行 |

工作方式：源码目录保留开发名 `dsh-swarm`，发布时用构建脚本生成改名副本，保证 `package.json`、`cordis.patch.yml` 行名、client module id 三处一致。

```bash
node scripts/build-release.mjs --name @ailunsin/dsh-swarm
# 产物：dist/ailunsin--dsh-swarm/
cd dist/ailunsin--dsh-swarm && npm pack --dry-run
```

发布工作流使用 `--out dist/release` 固定目录，默认包名 `@ailunsin/dsh-swarm`。

## 发布前检查清单

- [x] 包名使用 `@ailunsin/dsh-swarm`，不覆盖 `dsh-swarm`。
- [x] `npm run lint`、`npm test`（93 用例）全绿。
- [x] `npm run demo` 通过。
- [x] `npm run bench` 生成 `bench/results/latest.*`；真实模型两组样本另存 `real-*.json/md`。
- [x] `npm pack --dry-run` 包含 `src/`、`client.js`、`cordis.patch.yml`、`locale/`、`icon.svg`、`docs/`、`bench/`。
- [x] `engines.dsh` 为 `>=0.2.2-rc.1 <0.3.0`。
- [x] 从 registry 安装并验证 `swarm_status`、health、槽位、工具与消息。
- [ ] 浏览器人工验收七页、拓扑、时间线播放、CSV 下载。
- [ ] 更多真实模型重复样本与一次通过率统计。
- [ ] GIF/短视频演示。

## 0.1.0 → 0.1.1

`0.1.0` 发布后，本地又更新了 README/发布文档和 bench 结果时间戳；更关键的是，**0.1.0 在 DSH 0.2.2-rc.3 上自动派发不可用**：`startActivation` 已改为扁平 spec，旧包仍传嵌套 `request`，导致 `spec.parent` 为空。0.1.1 已修复并新增 `test/runner.test.js`，并用 3 任务真实运行验证（26/26 测试、3/3 合并）。

## 下一版本发布步骤

```bash
# 1. 本地验证
npm run check && npm run demo

# 2. 升版本并更新 CHANGELOG
npm version 0.1.1 --no-git-tag-version

# 3. 生成改名发布包
node scripts/build-release.mjs --name @ailunsin/dsh-swarm
cd dist/ailunsin--dsh-swarm
npm pack --dry-run

# 4. 发布并打 tag
npm publish --access public
git tag v0.1.1 && git push origin v0.1.1
```

发布后验证：

```bash
npm view @ailunsin/dsh-swarm version dist-tags
dsh plugin add @ailunsin/dsh-swarm
# 新会话执行 swarm_status 应返回 "no swarm runs"
```

## 本地 tarball 验证注意

先把 `.tgz` 复制到包目录之外再安装；从产物目录内直接安装会让 pnpm/插件管理器清空源目录。

## 明确未完成

1. 浏览器视觉/交互验收（本会话的无头浏览器被 `dsh web authentication required` 拦截）。
2. 更多真实模型重复样本与一次通过率统计；现有两轮总墙钟均未达 ≤70% 目标。
3. Giphy/GIF 演示与发布公告。
