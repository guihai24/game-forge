# 网页渠道

## 现状

**生成 → 打包 → 验证 整条链已经跑通**，只差「发布到服务器」。

| 环节 | 状态 | 怎么做 |
|------|------|--------|
| 生成游戏 | ✅ | `game_studio_create`（与微信渠道完全相同） |
| 打包成单文件 | ✅ | `targets/web/build.mjs` 复制 `dist/index.html` 并做自包含体检 |
| 自动验证 | ✅ | `targets/web/verify.mjs`：无头 Chrome 试玩 + 同一套 `brief.acceptance` 断言 |
| 本地预览 | ✅ | 直接双击 `targets/web/index.html` |
| **部署上线** | ⏸ 未做 | 取决于用户的服务器形态，见下 |

```bash
node scripts/publish.mjs --target web --game <游戏目录>
```

实测（月夜狐灯）：产物 119.5 KB、4 个内联图片、CSP 存在、外链 0；
960×540 视口下 phases=playing、稳态 60fps、断言全过。

## 为什么部署仍然暂缓

部署方式的分叉太大，写死一种就是错的：

- **静态托管**：OSS / COS / S3 / Cloudflare Pages / Vercel — 走各自的 CLI 或 API
- **自有服务器**：`rsync` / `scp` / `ssh` + nginx / Caddy
- **容器**：镜像构建 + 推仓库 + 滚动更新
- **内网/离线**：干脆不部署，只交付 HTML 文件

每种的凭据、回滚、缓存策略都不一样。**没有明确目标环境之前，写出来的 `deploy.mjs` 只是猜测。**

## 将来补的时候怎么做

### ✅ 验证已完成（2026-11-08）

`targets/web/verify.mjs` 用 playwright-core 打开产物，驱动鼠标画圈模拟摇杆，
每 400ms 采一次 `window.__gameState()`，最后按 `brief.acceptance` 断言。

与微信渠道**共用同一套断言语义**，只有执行器不同——网页侧没有"独立上下文"的问题，
`page.evaluate` 直接就能读到游戏全局，比微信简单。

playwright-core 的解析顺序（`lib.mjs` 的 `resolvePlaywright`）：
`PLAYWRIGHT_CORE` 环境变量 → DSH 桌面 profile → web profile → 当前目录 `node_modules`。
找不到时 `verify.mjs` 退出码 3，doctor 会给出警告。

### 2. 部署做成可插拔的 backend

```
targets/web/deploy/
  ├── rsync.mjs     # ssh + rsync，适合自有服务器
  ├── oss.mjs       # 对象存储
  └── static.mjs    # 只产出文件，不部署（默认）
```

`publish.mjs --target web --deploy rsync --host ...` 按需选。

### 3. 需要用户提供的信息

做之前必须问清楚，缺一个就别开工：

- 服务器怎么登（SSH 别名 / 密钥路径）
- 用什么提供静态服务（nginx / Caddy / 对象存储）
- 发到哪个路径、哪个域名
- 有没有 CDN 缓存需要刷新
- 出问题怎么回滚

## 现在的临时做法

用户急着要网页版时：

```bash
# 在对话里让 Game Studio 导出
game_studio_export(path="games/xxx", name="月夜狐灯")
# → games/xxx/export/月夜狐灯.html
```

然后把文件给用户，让他自己传。**这一步不要写进自动化**，因为无法验证"传上去了"。
