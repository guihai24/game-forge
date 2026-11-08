# game-forge

Turn one sentence of a game idea into something shippable — as a WeChat mini-game or a
standalone web page — with automated play-testing that actually asserts the game runs.

## What it does

```
需求梳理 → brief.json → 生成游戏 → 按渠道转换 → 自动试玩断言 → 截图 → 预览
```

Two parts:

- **需求梳理**（对话）：先问清楚做什么类型、发到哪个渠道、怎么算做成了，落成 `brief.json`
- **交付流水线**（脚本）：`publish.mjs` 一条命令跑完转换、试玩、断言、预览

The same `brief.acceptance` drives both channels — only the executor differs.

## Requirements

| 能力 | 需要 |
|------|------|
| 生成游戏 | **DeepSeek Harness** + Game Studio plugin（`game_studio_create` 等工具） |
| `wechat` 渠道 | 微信开发者工具 + [wechatide-skill](../wechatide-skill/) |
| `web` 渠道 | Chrome + `playwright-core` |
| SVG 栅格化 | 无头 Chrome（或用 `CHROME_PATH` 指定） |

> ⚠️ 生成这一步依赖 DSH 的 Game Studio 插件。没有 DSH 时，`g2wx`/`build`/`verify`
> 仍可对**任何符合产物契约**的游戏目录工作：`dist/index.html` 内含
> `window.GAME = {title, rules, slots, assets}`，以及同目录的 `game.js`。

## Install

```bash
cp -r skills/game-forge ~/.claude/skills/        # Claude Code
cp -r skills/game-forge ~/.agents/skills/        # 其他 agent 运行时
```

## Usage

```bash
S=~/.claude/skills/game-forge/scripts

node $S/doctor.mjs                                            # 环境自检
node $S/brief.mjs init --out <游戏目录>/game.brief.json --title "月夜狐灯" --target wechat
node $S/brief.mjs check --file <游戏目录>/game.brief.json      # 校验需求

# 微信：转换 → 模拟器 → 断言 → 二维码
node $S/publish.mjs --target wechat --game <游戏目录> --preview

# 网页：打包 → 无头浏览器 → 断言
node $S/publish.mjs --target web --game <游戏目录>
```

Exit codes: `0` pass · `1` args/env · `2` build failed · `3` tool failed · `4` **assertion failed**.

## Design notes

- **零改写**：转换器不改游戏代码，浏览器差异全部吸收进 `targets/wechat/wx-shim.js`。
  Game Studio 重建后重跑转换即可，不需要合并。
- **断言分软硬**：`fps ≥ N` 是软指标（窗口不在前台会被 Chromium 节流到 ~20），
  只保留 `fps 未塌方 ≥ 10` 当硬门槛。要严格判定加 `--require-fps`。
- **兼容性默认拒绝**：扫描到小游戏不支持的 API 就停止转换并给出行号，确认后 `--force` 放行。
  产出「能编译但黑屏」的包比直接报错糟糕得多。

## Layout

```
game-forge/
├── SKILL.md                     # 路由：需求梳理 → 选 target → 分支
├── scripts/
│   ├── doctor.mjs               # 环境自检
│   ├── brief.mjs                # 需求落盘与校验
│   ├── publish.mjs              # 编排 + 断言
│   ├── lib.mjs                  # 共用工具
│   ├── targets/wechat/          # g2wx 转换器 + wx-shim
│   └── targets/web/             # 打包 + 无头浏览器验证
└── references/
    ├── intake.md                # 需求梳理话术与判据
    ├── wechat-gotchas.md        # 10 个实测坑
    ├── compat-matrix.md         # API 支持矩阵
    └── web.md                   # 网页渠道现状与部署待办
```
