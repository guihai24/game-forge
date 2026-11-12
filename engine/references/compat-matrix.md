# 兼容性矩阵

## 运行时提供 vs shim 补

| API | 小游戏运行时 | 处理 |
|-----|-------------|------|
| `window` | ✅ 有（只读 getter） | 增补，不替换 |
| `document` | ⚠️ 只有 `location` | 增补 `getElementById` / `createElement` / `addEventListener` / `hidden` |
| `requestAnimationFrame` | ✅ 有 | 直接用 |
| `Image` | ❌ 没有 | `function Image(){ return wx.createImage(); }` |
| `AudioContext` | ✅ 有 | 直接用（游戏内有 try/catch 兜底） |
| `innerWidth/innerHeight` | ⚠️ 是 1×1 | 用 `wx.getWindowInfo()` 覆盖 |
| `devicePixelRatio` | ❌ null | 同上 |
| Pointer Events | ❌ 没有 | 由 `wx.onTouch*` 合成 `pointerdown/move/up/cancel` |
| `visibilitychange` | ❌ 没有 | 由 `wx.onShow/onHide` 合成 |
| `window.resize` | ❌ 没有 | 由 `wx.onWindowResize` 合成 |
| ��盘事件 | ❌ 小游戏无键盘 | 忽略（移动端本来就靠触摸） |
| `localStorage` | ❌ 没有 | **未处理**，需要时改 `wx.setStorageSync` |
| `fetch` / `XMLHttpRequest` | ❌ 没有 | **未处理**，需改 `wx.request` |
| WebGL | ⚠️ 需用 `wx.createCanvas` 的上下文 | **未处理** |

## g2wx 会扫描并告警的写法

`game.js` 里命中以下任一模式会打印警告，命中不代表必然失败，但必须逐条确认：

| 模式 | 说明 |
|------|------|
| `document.querySelector` | 小游戏没有 DOM 查询 |
| `getBoundingClientRect` | 没有布局系统（shim 会给 canvas 一个假实现） |
| `localStorage` | 改用 `wx.setStorageSync` |
| `XMLHttpRequest` / `fetch(` | 改用 `wx.request`，且必须是白名单域名 |
| `new Worker(` | 改用 `wx.createWorker` |
| `getContext('webgl')` | 需走小游戏 WebGL 上下文 |
| `document.body.appendChild` | 无 DOM（当前模板走不到这条分支） |
| `window.crypto` | 无此对象 |

## 已实测跑通的品类

- **collector 模板**（俯视 2D，Canvas 2D，键盘 + 虚拟摇杆）：完全跑通
  - 1128×720 世界、60fps、透明 PNG 精灵、SVG 栅格化背景平铺、虚拟摇杆、失败/重开
  - 包体积 170 KB

## 未验证、风险较高的品类

- 三消 / 卡牌 / 节奏类：若用 DOM 叠层做 UI，需要重写成 canvas 绘制
- 塔防 / 平台跳跃：若依赖 WebGL 或自定义音频节点，需要额外适配
- 任何用了 `__autoplay` 的自定义品类：逻辑本身没问题，但要确认没碰上面表里的禁用 API
