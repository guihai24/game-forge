# game-forge

**确定性交付流水线**：一句话的游戏需求 → 能交付的成品 → 各渠道产物。
分为两层，同一个仓库、两个包：

| 目录 | 包名 | 是什么 |
|---|---|---|
| `engine/` | `game-forge-engine` | 引擎。转换、试玩断言、截图、上传。**可脱离 agent / DSH 单独跑**，退出码说话。 |
| `console/` | `@guihai24/dsh-game-console` | DSH 插件。看板、渠道编排、待办、台账。只加载这个。 |

游戏由 `@zseven-w/dsh-game-studio` 生成，本仓库不重复造生成器。

```bash
game-forge build  --game <目录> --target wechat --preview   # 转换+试玩+断言+截图+二维码
game-forge upload --game <目录> --version 1.0.0             # miniprogram-ci 上传开发版
game-forge doctor                                           # 环境自检
```


**一句话的游戏想法 → 能交付的成品。** 不是"生成游戏"的包装，而是一条带断言的交付流水线：
需求梳理 → 生成 → 按渠道转换 → 自动试玩验证 → 预览/发布。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Targets](https://img.shields.io/badge/targets-wechat%20%7C%20web-green)]()
[![Runtime](https://img.shields.io/badge/runtime-Node%2020%2B-yellow)]()

```
                    ┌──────────────────────────────┐
   一句话需求  ───▶  │  ① 需求梳理（对话）            │
                    │     渠道 / 玩法 / 交付 三层问题  │
                    └──────────────┬───────────────┘
                                   ▼
                          brief.json   ← 验收标准落盘
                                   │
                    ┌──────────────┴───────────────┐
                    ▼                              ▼
          ┌──────────────────┐          ┌──────────────────┐
          │ ② target=wechat  │          │ ② target=web     │
          │ 小游戏工程        │          │ 单文件 HTML       │
          │ g2wx + wx-shim   │          │ 复制 + 自包含体检  │
          └────────┬─────────┘          └────────┬─────────┘
                   ▼                             ▼
          ┌──────────────────┐          ┌──────────────────┐
          │ 模拟器 + 状态日志  │          │ 无头浏览器         │
          │ automation 驱动   │          │ page.evaluate     │
          └────────┬─────────┘          └────────┬─────────┘
                   └──────────────┬───────────────┘
                                  ▼
                     同一套断言（读 brief.acceptance）
                                  ▼
                       截图 · report.json · 预览二维码
```

## 为什么是"流水线"而不是"技能"

| | 普通 skill | game-forge |
|---|---|---|
| 交互 | 对话里读指令 | 对话决定方向，脚本执行交付 |
| 产物 | 文档、配置 | 可运行的工程 / 可玩的包 |
| 验证 | 靠人看 | **机器断言**：阶段迁移、帧率、分数 |
| 可重复 | 每次重来 | 一条命令，退出码说话 |

`SKILL.md` 只负责路由；真正的系统在 `engine/scripts/` 里，能脱离 agent 独立运行，
也能进 CI。

## 两个渠道

| target | 打包 | 验证 | 部署 |
|--------|------|------|------|
| `wechat` | 小游戏工程（约 170 KB） | 开发者工具模拟器 + console 状态日志 | 预览二维码 ✅；上传体验版 ⏳ 待正式 AppID |
| `web` | 单文件 HTML（约 120 KB，零外链） | 无头 Chrome + `page.evaluate` | ⏸ 待定，见 [references/web.md](engine/references/web.md) |

**同一份 `brief.acceptance`，两个执行器。** 这是两个渠道能共存的根本原因。

## 快速开始

```bash
git clone https://github.com/guihai24/game-forge.git
cd game-forge

node engine/scripts/doctor.mjs                 # 环境自检

# 需求落盘
node engine/scripts/brief.mjs init --out <游戏目录>/game.brief.json \
  --title 月夜狐灯 --genre collect-and-dodge --target wechat --appid wx...
node engine/scripts/brief.mjs check --file <游戏目录>/game.brief.json

# 一条命令跑完
node engine/scripts/publish.mjs --target wechat --game <游戏目录> --preview
node engine/scripts/publish.mjs --target web    --game <游戏目录>

# 批量：扫工作区里所有带 game.brief.json 的游戏
node engine/scripts/publish.mjs --all games --targets wechat,web
```

退出码：`0` 通过 · `1` 参数/环境 · `2` 构建失败 · `3` 工具失败 · `4` **断言失败** · `5` 目标未实现。

实测（月夜狐灯）：微信 150 秒、网页 15 秒，双双退出码 0。
批量模式两个游戏串行跑，微信各约 100 秒、网页各约 13 秒，汇总成一张表。

## 三条设计原则

**① 零改写。** 转换器不改游戏代码——`game.js` 原样搬运，浏览器差异全部吸收进
`engine/scripts/targets/wechat/wx-shim.js`。上游重建后重跑转换即可，不需要合并。
一旦转换器开始改写游戏代码，每次重建都会变成手工冲突。

**② 断言分软硬。** `fps ≥ N` 是软指标（窗口不在前台会被 Chromium 节流到 ~20），
只保留 `fps 未塌方 ≥ 10` 当硬门槛。要严格判定加 `--require-fps`。
产出「跑了但没人知道对不对」的结果，比不跑更糟。

**③ 兼容性默认拒绝。** 扫描到小游戏不支持的 API 就停止转换并给出行号：

```
✗ 检测到小游戏不支持的 API，已停止转换：
  · localStorage —— 请改用 wx.setStorageSync
    命中 1 次，行号 965
```

确认风险后 `--force` 放行。产出「能编译但黑屏」的包，比直接报错糟糕得多。

## 工作台插件

已迁移到 `console/`（`@guihai24/dsh-game-console`），取代原来挂在右栏的 tab：
扫描、试玩、预览、上传都搬进看板，右栏不再单独占一个入口。

旧插件的两条设计约束仍然有效，写在这里免得重踩：

- 任务进度不能拿命令轮询——命令每执行一次都会记进会话、显示在对话里。进度应写到工作区文件，面板读文件。
- `client.js` 按普通脚本加载，不能写 `import` / `export`，要包在 `window.__ModuleLoader__.load({ id, factory(require) { … } })` 里；写错了 DSH 直接启动失败。

## 作为技能安装

```bash
# 软链（推荐：单一事实源）
ln -s "$PWD" ~/.agents/skills/game-forge

# 或直接拷贝
cp -r . ~/.agents/skills/game-forge
```

配合 `SKILL.md` 使用，agent 会按需求梳理 → 分支 → 交付的流程走。

## 依赖

| 能力 | 需要 |
|------|------|
| 生成游戏 | DeepSeek Harness + Game Studio 插件 |
| `wechat` 渠道 | 微信开发者工具（自带 `wechatide` CLI），踩坑记录见 `engine/references/wechat-gotchas.md` |
| `web` 渠道 | Chrome + `playwright-core` |
| SVG 栅格化 | 无头 Chrome（`CHROME_PATH` 可覆盖） |

> 没有 DSH 时，`g2wx` / `build` / `verify` 仍可对**任何符合产物契约**的目录工作：
> `dist/index.html` 内含 `window.GAME = {title, rules, slots, assets}`，以及同目录的 `game.js`。

## 目录

```
├── SKILL.md                       # 路由：需求梳理 → 选 target → 分支
├── engine/                        # game-forge-engine（可单独跑）
│   ├── bin/game-forge.mjs         # 统一入口
│   ├── scripts/
│   ├── doctor.mjs                 # 环境自检
│   ├── brief.mjs                  # 需求落盘与校验
│   ├── publish.mjs                # 编排 + 断言
│   ├── lib.mjs                    # 共用工具
│   ├── targets/wechat/            # g2wx 转换器 + wx-shim + upload-ci
│   └── targets/web/               # 打包 + 无头浏览器验证
│   └── references/
    ├── intake.md                  # 需求梳理话术与判据
    ├── wechat-gotchas.md          # 10 个实测坑
    ├── compat-matrix.md           # API 支持矩阵
    └── web.md                     # 网页渠道现状与部署待办
```

## Roadmap

- [ ] 网页渠道部署（rsync / 对象存储），做成可插拔 backend
- [ ] 微信体验版上传验证（需要正式小游戏 AppID）
- [ ] 更多品类适配（目前只有 collector 实测跑通）
- [ ] 工作台形态：侧栏面板列出游戏与各渠道状态，按钮 shell out 到同一套 CLI
- [ ] CI：把 `publish.mjs` 的断言接进 GitHub Actions

## License

MIT
