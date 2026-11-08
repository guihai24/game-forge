# 小游戏运行时的坑（已实测确认）

环境：微信开发者工具 3.17.5 基础库，macOS，小游戏 `compileType: game`。

## 1. `GameGlobal.window` 是只读 getter

运行时（weapp-adapter 注入，标记 `__isAdapterInjected`）已经提供了 window / document /
requestAnimationFrame。对 `window` 直接赋值会抛：

```
TypeError: Cannot set property window of #<Window> which has only a getter
```

**正确做法**：拿现成的 `GameGlobal.window`，只增补缺失的 API，不替换。

```js
var W = null;
try { W = GameGlobal.window; } catch (e) { W = null; }
if (!W) { try { GameGlobal.window = GameGlobal; } catch (e) {} W = GameGlobal; }
```

## 2. `innerWidth` / `innerHeight` 是 1×1，`devicePixelRatio` 是 null

实测日志：

```
[g2wx] shim start; canvas= 844 390 win= 1 1 dpr= null
```

而 `wx.getWindowInfo()` 给的是 `844 × 390, pixelRatio 3`。

后果非常隐蔽：`resize()` 里 `window.innerWidth || canvas.clientWidth || 1280` 因为 1 是
truthy 而不会走兜底，于是 `canvas.width = 1 * 1 = 1` —— **画布变成 1×1 像素，
表现为纯黑屏、console 零报错**。

**正确做法**：用 `wx.getWindowInfo()` 的值覆盖，并在 `wx.onWindowResize` 时刷新：

```js
Object.defineProperty(W, 'innerWidth',  { configurable: true, get: function () { return viewport.w; } });
Object.defineProperty(W, 'innerHeight', { configurable: true, get: function () { return viewport.h; } });
Object.defineProperty(W, 'devicePixelRatio', { configurable: true, get: function () { return viewport.dpr; } });
```

## 3. `wx.createCanvas()` 第一次调用就是上屏画布

实测：`wx.createCanvas()` 返回的对象 `width/height` 与屏幕一致（844×390），
原型是 `HTMLElement`，带 `style`。后续调用拿到的是离屏画布。

所以 shim 里第一件事就把它拿下来，游戏通过 `document.getElementById('game')` 复用它。

## 4. SVG 素材不支持

小游戏 canvas 的 `Image` 只能加载位图。Game Studio 模板默认角色是 SVG，
必须栅格化。本项目用无头 Chrome 截图实现（`g2wx.mjs` 的 `rasterizeSvg`）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --no-first-run \
  --user-data-dir=<tmp>/profile --force-device-scale-factor=2 \
  --default-background-color=00000000 --window-size=256,256 \
  --screenshot=out.png file://<tmp>/page.html
```

要点：`--default-background-color=00000000` 保留透明通道；`--user-data-dir` 必填，
否则 headless 启动失败；`--force-device-scale-factor=2` 输出 2 倍图保证清晰度。

## 5. 多项目窗口会串截图

同时打开多个工程窗口时，`simulator_screenshot --project A` 可能返回别的内容，
表现为"改完代码还是老画面"或"一直是黑屏"。**测完一个就 close_project_window。**

## 6. `automation_evaluate` 拿不到游戏的全局变量

它运行在独立的 JS 上下文（`WAGameSubContext`），读不到游戏里的
`window.__gameState` / `window.__g2wx`。因此状态断言要走 console 日志：

```bash
node g2wx.mjs ... --debug      # 入口每秒打 [g2wx:state] {...}
wechatide -c <c> get_simulator_console --project <out> --command 'grep -n "g2wx:state"'
```

## 7. 开发者工具会自升级，导致 CLI 连接中断

实测遇到过：调用进行到一半，IDE 自动更新到新版本，随后报
`Failed to connect to WechatIDE`，且 skill 版本落后（`versionRelation: agent_behind`）。

处理：把内置 skill 同步到 `~/.agents/skills/`：

```bash
rsync -a --delete \
  "/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/wechatide-skill/" \
  ~/.agents/skills/wechatide-skill/
```

然后重新 `open_project_window`。

## 8. `create_preview_qrcode --qr-output` 写出来的其实是 JPEG

指定 `--qr-output xxx.png` 时，文件内容是 JPEG（`FFD8FFE0` 开头），扩展名对不上会导致
图片工具拒绝读取。生成后按实际格式改名，或直接指定 `.jpg`。

## 9. 上传受 AppID 权限限制

「接口测试号」（`isGameType: true` 但名称含"接口测试号"）可以预览、可以推送手机，
但**不能上传体验版**。上传需要正式小游戏 AppID 且有开发者权限。
先跑 `get_user_appids --type minigame` 确认账号类型，再决定走预览还是上传。

## 10. 窗口不在前台时 fps 会被节流到 ~20

实测同一份包、同一台机器：

| 场景 | 稳态 fps |
|------|---------|
| 开发者工具窗口在前台 | 55–56 |
| 窗口被遮挡 / 不在前台 | **21–22**（28 个采样全部如此） |

Chromium 对不可见窗口降频渲染。**所以 fps 不能当硬门槛**——它测的是"窗口有没有被看到"，
不是"游戏性能好不好"。

`publish.mjs` 的处理：fps 断言默认是**软指标**（不达标只告警），只保留一条硬门槛
`fps 未塌方 ≥ 10` 用来抓"根本没在渲染"。需要严格时加 `--require-fps`。

另外一个相关陷阱：**冷启动那几帧本来就慢**。断言要丢掉前几个采样取稳态中位数，
否则第一次采样会把整条断言拖垮。
