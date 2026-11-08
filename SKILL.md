---
name: game-forge
version: 0.2.0
description: >-
  把一句话的游戏需求做成能交付的成品：先跟用户把需求问清楚（做什么类型、发到哪个渠道、
  怎么算做成了），落成 brief.json，再用 Game Studio 生成游戏，转成微信小游戏工程或网页，
  自动试玩、断言、截图、预览。用户说想做个小游戏 / 小游戏上微信 / 做个网页游戏 /
  把某个游戏做成小程序时使用。
metadata:
  short-description: 需求梳理 → 游戏生成 → 分渠道交付
related-skills:
  - name: wechatide-skill
    why: 微信渠道的编译/预览/上传/截图/自动化全由它提供
---

# game-forge

两条腿：**需求梳理**（对话）和 **交付流水线**（确定性脚本）。
微信和网页共用前半段，只在最后一段分叉。

## 第一步：需求梳理（不能跳过）

用户一句话往往只有"做个 XXX 的游戏"。先按 `references/intake.md` 的三层问题补齐，
**不要跳过渠道这一层**——它决定后面整条路径。

问完把结论写进 `<游戏目录>/game.brief.json`：

```bash
node scripts/brief.mjs init --out <游戏目录>/game.brief.json --title <名字> --target wechat
# 然后补全 genre / rules / acceptance
node scripts/brief.mjs check --file <游戏目录>/game.brief.json
```

`brief.json` 不是文档，是**断言来源**：后面 `publish.mjs` 直接读 `acceptance`
判断这次交付算不算成功，而不是靠 agent 记住用户说过什么。

关键字段：

| 字段 | 作用 |
|------|------|
| `target` | `wechat` / `web`，决定走哪条分支 |
| `rules` | 时长、命数、速度等，与 `game.json` 对齐 |
| `acceptance.mustReachPhase` | 至少要经过哪些阶段，默认 `["playing"]` |
| `acceptance.minFps` | 帧率参考值，默认 45（**软指标**，见下方说明） |
| `acceptance.mustScore` | 要求的最低分，0 表示不校验 |
| `channel.orientation` | `landscape` / `portrait` |

## 第二步：按 target 分支

| target | 打包 | 验证 | 部署 |
|--------|------|------|------|
| `wechat` | ✅ | ✅ 模拟器 + 状态日志断言 | ✅ 预览；上传待验证 |
| `web` | ✅ 单文件 HTML | ✅ 无头浏览器 + 同一套断言 | ⏸ 待定（见 `references/web.md`） |

两个渠道**共用同一套验收标准**（读 `brief.acceptance`），只是执行器不同：
微信读 console 状态日志，网页直接 `page.evaluate(window.__gameState)`。

## 微信分支

### 先自检

```bash
node scripts/doctor.mjs
```

检查 Node、脚本完整性、无头 Chrome、`wechatide`、开发者工具 skill 版本、登录态、小游戏 AppID。
有阻塞项时退出码 1，先修再跑。

### 一条命令

```bash
node scripts/publish.mjs --target wechat --game <游戏目录> --preview
```

依次：转换（带调试日志）→ 导入 → 开模拟器 → 等启动 → 点击开始 → 拖摇杆 →
**断言**（读 `brief.acceptance`）→ 截图存档 → 重建生产包 → 生成预览二维码。

产物在 `<游戏目录>/.pipeline/`：`report.json`、`debug-*.jpg`、`release-*.jpg`、`qrcode.jpg`。

退出码：`0` 通过 ｜ `1` 参数/环境 ｜ `2` 转换失败 ｜ `3` 开发者工具失败 ｜ `4` **断言失败** ｜ `5` 目标未实现。

| 开关 | 作用 |
|------|------|
| `--preview` | 生成预览二维码 |
| `--upload` | 上传体验版（需正式 AppID；**未验证**） |
| `--brief <路径>` | 指定简报，默认找 `<游戏目录>/game.brief.json` |
| `--strict` | console 出现任何 error 即失败 |
| `--min-fps 50` | 覆盖简报里的帧率门槛 |
| `--keep-open` | 结束后不关项目窗口 |

### 批量

```bash
node scripts/publish.mjs --all <根目录> [--targets wechat,web] [--preview]
```

扫描根目录下所有含 `game.brief.json` 的游戏目录，逐个跑，输出汇总表并写 `.pipeline/all-report.json`。

**必须串行**——多个模拟器窗口同时开会让 `simulator_screenshot` 串图（见已知坑第 3 条）。
脚本在每两个之间关窗口并等待，不要改成并发。

### 手工分步（排查时用）

```bash
S=<本 skill 目录>/scripts
node $S/targets/wechat/g2wx.mjs --src <游戏目录> --out <游戏目录>/targets/wechat --appid <appid> --debug
wechatide -c <clientName> project_import      --project <out>
wechatide -c <clientName> open_project_window --project <out>
wechatide -c <clientName> get_simulator_console --project <out> --command 'grep -n g2wx'
wechatide -c <clientName> automation_game_action --project <out> --action tap --x 422 --y 195
wechatide -c <clientName> simulator_screenshot --project <out>
```

横屏时画布中心约 `(422, 195)`；实际以启动日志 `[g2wx] viewport w= h=` 为准。

## 网页分支

```bash
node scripts/publish.mjs --target web --game <游戏目录>
```

打包（复制 Game Studio 的 `dist/index.html`，并体检"是否自包含"）+ 无头浏览器试玩 + 断言 + 截图。

产物：`<游戏目录>/targets/web/index.html`（约 120 KB，零外链、零网络请求）。
让用户直接双击就能玩，或丢到任意静态托管上。

**部署未实现**——各家的服务器形态差异太大，见 `references/web.md`。

## 铁律：不修改游戏代码

`g2wx.mjs` 把 `game.js` **原样复制**成 `game-code.js`，一个字节不改，差异全部吸收进
`targets/wechat/wx-shim.js`。

这样 Game Studio 换美术、调规则、重建之后，**再跑一次转换即可**，不需要合并。
一旦转换器开始改游戏代码，每次重建都会变成手工冲突。

## 状态断言

默认构建无调试输出；`publish.mjs` 会用 `--debug` 构建验证包，入口每秒打一条：

```
[g2wx:state] {"phase":"playing","time":51.4,"score":7,"hearts":3,"fps":55,...}
```

**这是小游戏侧唯一可靠的断言通道**——`automation_evaluate` 跑在独立 JS 上下文，
读不到游戏全局（`window.__gameState` 取不到）。截图给人看，状态日志给机器判。

## 断言分软硬两种

| 断言 | 类型 | 说明 |
|------|------|------|
| 游戏启动 | 硬 | 拿不到启动日志 = 黑屏或加载失败 |
| 经过 playing 等阶段 | 硬 | 输入没接上会卡在标题 |
| fps 未塌方（≥10） | 硬 | 抓"根本没在渲染" |
| fps ≥ `minFps` | **软** | 窗口不在前台会被节流到 ~20，只告警不判失败 |
| 状态可读 | 硬 | `__gameState` 契约被破坏 |
| 分数 ≥ `mustScore` | 硬（配置后） | 证明核心循环真能得分 |

要严格判定帧率加 `--require-fps`，但请先确认开发者工具窗口在前台。

## 兼容性：默认拒绝

`g2wx.mjs` 逐行扫描 `game.js` 里的高风险 API，**命中就停止转换**（退出码 3）并给出行号：

```
✗ 检测到小游戏不支持的 API，已停止转换：
  · localStorage —— 请改用 wx.setStorageSync
    命中 1 次，行号 965
```

产出「能编译但黑屏」的包，比直接报错糟糕得多。确认风险后 `--force` 放行，
报告里会记 `forced: true`。清单见 `references/compat-matrix.md`。

## 已知坑

都在 `references/wechat-gotchas.md`，改 shim 前务必看。最容易重新踩的三个：

1. `GameGlobal.window` 是**只读 getter**，只能增补不能替换
2. 运行时 `innerWidth/innerHeight` 是 **1×1**、`devicePixelRatio` 是 **null**
   → 画布会变成 1×1 像素，表现为**黑屏且零报错**
3. 多项目窗口同时打开时 `simulator_screenshot` 会串图 → **测完就关窗口**

## 失败快表

| 现象 | 优先检查 |
|------|----------|
| 黑屏且 console 无报错 | `innerWidth` 是否 1×1；截图是否串到别的窗口 |
| `Cannot set property window ...` | shim 又在替换 window，应改为增补 |
| 贴图不显示 | 素材没栅格化；或 `img.src` 不是包内相对路径 |
| 点击没反应 | 触摸没映射成 pointerdown；canvas 不是 `getElementById('game')` 那块 |
| 上传失败 | AppID 是否有上传权限（测试号只能预览） |
| `Failed to connect to WechatIDE` | 开发者工具自升级了，同步内置 skill 后重开窗口 |

## 文件

| 路径 | 作用 |
|------|------|
| `scripts/doctor.mjs` | 环境自检 |
| `scripts/brief.mjs` | 需求落盘与校验 |
| `scripts/publish.mjs` | 编排 + 断言 |
| `scripts/lib.mjs` | 共用的 CLI / JSON 工具 |
| `scripts/targets/wechat/g2wx.mjs` | 转换器 |
| `scripts/targets/wechat/wx-shim.js` | 运行时适配层 |
| `scripts/targets/web/build.mjs` | 网页打包（复制 + 自包含体检） |
| `scripts/targets/web/verify.mjs` | 网页试玩与断言 |
| `references/intake.md` | 需求梳理话术与判据 |
| `references/wechat-gotchas.md` | 实测踩过的坑 |
| `references/compat-matrix.md` | API 支持矩阵 |
| `references/web.md` | 网页渠道现状与部署待办 |

## 依赖

- 无头 Chrome（栅格化 SVG），可用 `CHROME_PATH` 覆盖
- 微信开发者工具已安装并登录（走 `wechatide-skill`）
