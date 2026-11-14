/* 客户端：主区「工作室」面板（与对话并列，不是右栏 tab）。
 *
 * 只渲染，不做事：扫描、聚合、写入都在服务端 /game-console 命令里。
 *
 * 注册方式照官方 plugin-manager 的做法：
 *   - main（kind: keyed）注册一个 key，切过去用 ctx.layout.selectPanel(key)
 *   - sidebar.panellist 注册一个入口，侧栏才出现「工作室」
 *
 * DSH 前端把 client.js 当普通脚本加载：不能写 import/export，
 * 必须包在 __ModuleLoader__.load 里，依赖用 require 取。
 */

window.__ModuleLoader__.load({
  id: '@guihai24/dsh-game-console',
  factory(require) {
    const { createElement: h, useCallback, useEffect, useMemo, useState } = require('react');
    const Fragment = require('react').Fragment;

    const PANEL_ID = 'game-console';
    const NS = '@guihai24/dsh-game-console';

    const inject = ['slots', 'locale', 'remote', 'remote.commands', 'sessions', 'resources'];

    /* ---------- 图标 ---------- */
    function PanelIcon(props) {
      const size = (props && props.size) || 16;
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 1.6, y: 2.2, width: 5.2, height: 5.2, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('rect', { x: 9.2, y: 2.2, width: 5.2, height: 5.2, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('rect', { x: 1.6, y: 8.6, width: 5.2, height: 5.2, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('rect', { x: 9.2, y: 8.6, width: 5.2, height: 5.2, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.3 })
      );
    }

    /* ---------- 样式：只用 --dsw-alias-* token，跟随宿主主题 ---------- */
    const CSS = `
.gc-root{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
/* 全局兜底：面板内任何可聚焦元素都必须有可见焦点环。
   宿主样式会清掉 outline，不给个兜底键盘就没法用。 */
.gc-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.gc-top{height:52px;flex:none;display:flex;align-items:center;gap:10px;padding:0 20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.gc-top h1{font-size:20px;font-weight:600;margin:0;letter-spacing:-.01em}
.gc-count{font-size:13px;color:var(--dsw-alias-label-tertiary);margin-left:8px;
  font-variant-numeric:tabular-nums}
.gc-todo-pill{font-size:12px;padding:5px 12px;border-radius:999px;margin-right:10px;
  background:var(--dsw-alias-state-warn-primary);color:#fff;font-variant-numeric:tabular-nums}
.gc-btn-icon{padding:5px 10px;font-size:14px;line-height:1}
/* 桌面应用用了隐藏式标题栏，红黄绿窗口按钮会盖住左上角内容。
   给这块留出空间，Web 端窗口按钮不在文档流里所以不影响。 */
/* 桌面窗口的红黄绿按钮压在这块区域，Web 端没有。
   不做环境探测——探测不可靠，宁可让 Web 端多 78px 左边距，
   也不能让桌面端标题被窗口按钮盖住。 */
.gc-top-safe{display:none}
.gc-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.gc-grow{flex:1}
.gc-btn{font:inherit;font-size:12px;padding:5px 11px;border-radius:7px;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;transition:background-color .12s,border-color .12s,color .12s}
.gc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 焦点必须可见：宿主把默认 outline 清了，这里补回来。
   用 :focus-visible 而不是 :focus，避免鼠标点击后也出现焦点环。 */
.gc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:7px}
.gc-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.gc-btn.sm{padding:3px 9px;font-size:11.5px}
.gc-btn.ghost{border-color:transparent;color:var(--dsw-alias-label-tertiary);padding-left:6px;padding-right:6px}
.gc-btn.ghost:hover{color:var(--dsw-alias-state-error-primary);background:transparent;border-color:var(--dsw-alias-border-l3)}
.gc-scroll{overflow:auto;padding:14px 18px 40px}
.gc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.gc-stat{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:10px 12px}
.gc-stat .k{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}
.gc-stat .v{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}
.gc-stat .v small{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary);margin-left:3px}
.gc-board{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden;margin-bottom:24px}
/* 窄屏（<1100px）列会挤：让表格自己横向滚动，而不是撑破外层或压缩文字。 */
.gc-board-scroll{overflow-x:auto;overscroll-behavior-x:contain}
.gc-board table{width:100%;min-width:820px;border-collapse:collapse}
.gc-board th{font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary);text-align:left;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}
.gc-board td{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:middle}
.gc-board tr:last-child td{border-bottom:0}
.gc-board tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}
.gc-name{font-weight:500}
.gc-gid{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,monospace;margin-top:1px}
.gc-verdict{font-size:11.5px;margin-top:3px;line-height:1.5}
.gc-verdict.good{color:var(--dsw-alias-state-success-primary)}
.gc-verdict.weak{color:var(--dsw-alias-state-warn-primary)}
.gc-verdict.bad{color:var(--dsw-alias-state-error-primary)}
.gc-st{display:inline-flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.gc-ok{color:var(--dsw-alias-state-success-primary)}
.gc-warn{color:var(--dsw-alias-state-warn-primary)}
.gc-dots{display:inline-flex;gap:2px;margin-right:3px}
.gc-dots span{display:block;width:3px;height:9px;border-radius:1px;background:currentColor;opacity:.18}
.gc-dots span.on{opacity:.85}
.gc-err{color:var(--dsw-alias-state-error-primary)}
.gc-none{color:var(--dsw-alias-label-tertiary)}
.gc-run{color:var(--dsw-alias-brand-primary)}
.gc-todo{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden}
.gc-todo .hd{padding:9px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;font-weight:500;display:flex;align-items:center;gap:7px}
.gc-badge{font-size:11px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-state-warn-primary);color:#fff;font-variant-numeric:tabular-nums}
.gc-it{display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-start}
.gc-it:last-child{border-bottom:0}
.gc-it .t{font-size:12.5px}
.gc-it .d{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px;line-height:1.55;white-space:pre-line}
.gc-it .ic{flex:none;width:16px;text-align:center}
.gc-it .go{margin-left:auto;align-self:center;flex:none}
.gc-empty{padding:28px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.gc-job{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden;margin-bottom:16px}
.gc-job .hd{padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;font-weight:500;display:flex;align-items:center;gap:7px}
.gc-jobline{font-size:11.5px;font-family:ui-monospace,monospace;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gc-btn:disabled{opacity:.4;cursor:default}
.gc-hint{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:18px;line-height:1.7}
.gc-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);margin-right:4px;white-space:nowrap}
.gc-chip.done{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.gc-chip.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.gc-chip.failed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}

/* ══════════ 游戏画廊 ══════════
   卡片是页面主体：先看见游戏长什么样，再看它的体检报告。
   状态收成封面上的徽章，不占正文空间。 */
.gc-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;margin-bottom:28px}
.gc-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  border-radius:14px;overflow:hidden;display:flex;flex-direction:column;
  transition:border-color .16s,box-shadow .16s}
.gc-card:hover{border-color:var(--dsw-alias-border-l3);box-shadow:0 4px 16px rgba(0,0,0,.06)}

/* 封面：真实美术居中，四周留白，不放满整个卡片 */
.gc-cover{position:relative;aspect-ratio:2.28/1;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(150deg,var(--cov-a,#e8eef2),var(--cov-b,#d5e2ea))}
/* 覆盖层：让主形象和背景融为一体，而不是贴上去 */
.gc-cover::after{content:'';position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(ellipse at 50% 108%,rgba(0,0,0,.10),transparent 62%)}
.gc-cover-img{max-height:74%;max-width:72%;object-fit:contain;
  filter:drop-shadow(0 6px 14px rgba(0,0,0,.13))}
.gc-cover-fallback{font-size:44px;font-weight:600;color:var(--dsw-alias-label-tertiary);opacity:.5}

.gc-badges{position:absolute;top:9px;left:9px;display:flex;flex-direction:column;align-items:flex-start;gap:5px}
.gc-badge2{font-size:10.5px;font-weight:500;padding:3px 9px;border-radius:999px;
  backdrop-filter:blur(8px);white-space:nowrap;font-variant-numeric:tabular-nums}
.gc-badge2.bad{background:rgba(255,236,232,.94);color:#b4342a}
.gc-badge2.warn{background:rgba(255,247,230,.94);color:#8a5a12}
.gc-badge2.ok{background:rgba(234,247,239,.94);color:#1f7a4d}

.gc-cover-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  gap:7px;background:rgba(255,255,255,.86);font-size:12px;color:var(--dsw-alias-brand-primary);
  padding:0 16px;text-align:center;line-height:1.5}

.gc-card-body{padding:16px 18px 14px;flex:1}
.gc-card-title{font-size:17px;font-weight:600;margin:0;line-height:1.3;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-card-sub{font-size:12.5px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
/* 下一步：一句话说清最该处理的事，最多两行 */
.gc-card-next{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2);
  line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
  overflow:hidden}

.gc-card-actions{display:flex;gap:1px;border-top:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-border-l2)}
.gc-abtn{flex:1;font:inherit;font-size:12px;padding:9px 4px;border:0;cursor:pointer;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  transition:background-color .12s,color .12s}
.gc-abtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gc-abtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.gc-abtn:disabled{opacity:.34;cursor:default}
.gc-abtn-ghost{color:var(--dsw-alias-label-tertiary);flex:0 0 auto;padding:9px 12px}
.gc-abtn-ghost:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}

.gc-empty-card{grid-column:1/-1;padding:52px 24px;text-align:center;
  border:1px dashed var(--dsw-alias-border-l3);border-radius:14px}
.gc-empty-t{font-size:14px;font-weight:600;margin-bottom:6px}
.gc-empty-d{font-size:12.5px;color:var(--dsw-alias-label-secondary)}

/* ══════════ 新建游戏弹层 ══════════ */
.gc-new{font:inherit;font-size:12px;font-weight:500;padding:6px 13px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff;
  white-space:nowrap;transition:filter .12s}
.gc-new:hover{filter:brightness(1.07)}

.gc-mask{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(16,19,23,.44)}
.gc-modal{width:min(680px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;
  box-shadow:0 24px 64px rgba(0,0,0,.24);overflow:hidden}
.gc-modal-hd{flex:none;display:flex;align-items:center;gap:10px;padding:16px 20px;
  border-bottom:1px solid var(--dsw-alias-border-l2)}
.gc-modal-hd h2{font-size:15px;font-weight:600;margin:0}
.gc-modal-x{margin-left:auto;font:inherit;font-size:16px;line-height:1;padding:5px 9px;border-radius:7px;
  border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;
  transition:background-color .12s,color .12s}
.gc-modal-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gc-modal-bd{flex:1;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px}
.gc-modal-ft{flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px;
  border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}

.gc-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.gc-row.one{grid-template-columns:1fr}
.gc-row.tri{grid-template-columns:1fr 1fr 1fr}
.gc-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.gc-field>label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.gc-field input,.gc-field select,.gc-field textarea{font:inherit;font-size:13px;
  padding:7px 10px;border-radius:8px;box-sizing:border-box;width:100%;
  border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);transition:border-color .12s}
.gc-field input:hover,.gc-field select:hover,.gc-field textarea:hover{border-color:var(--dsw-alias-label-tertiary)}
.gc-field textarea{resize:vertical;min-height:58px;line-height:1.6}
.gc-note{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.gc-note.bad{color:var(--dsw-alias-state-error-primary)}
.gc-sec{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-tertiary);
  letter-spacing:.04em;margin-top:4px}

/* 结果：先给结论，再给依据 */
.gc-result{display:flex;flex-direction:column;gap:16px}
.gc-score{display:flex;align-items:baseline;gap:10px}
.gc-score .n{font-size:34px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}
.gc-score .d{font-size:13px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.gc-g1bar{display:flex;gap:3px;margin-top:2px}
.gc-g1bar span{flex:1;height:5px;border-radius:2px;background:var(--dsw-alias-border-l3);opacity:.45}
.gc-g1bar span.on{background:var(--dsw-alias-brand-primary);opacity:1}
.gc-g1bar.is-drop span.on{background:var(--dsw-alias-state-warn-primary)}
.gc-concl{font-size:13px;line-height:1.6}
.gc-concl.good{color:var(--dsw-alias-state-success-primary)}
.gc-concl.weak{color:var(--dsw-alias-state-warn-primary)}
.gc-concl.bad{color:var(--dsw-alias-state-error-primary)}
.gc-reason{display:flex;gap:10px;font-size:12.5px;line-height:1.55;padding:9px 11px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
/* 轻重只用小圆点标记区分，不与卡片边框叠加 */
.gc-reason .mk{flex:none;width:6px;height:6px;border-radius:50%;margin-top:6px;
  background:var(--dsw-alias-label-tertiary)}
.gc-reason.miss .mk{background:var(--dsw-alias-state-error-primary)}
.gc-reason.need .mk{background:var(--dsw-alias-border-l3)}
.gc-group{display:flex;flex-direction:column;gap:8px}
.gc-group-hd{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}
.gc-reason .id{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);
  font-family:ui-monospace,monospace;padding-top:1px;min-width:38px}
.gc-reason .lb{font-weight:500}
.gc-reason .dt{color:var(--dsw-alias-label-secondary);margin-top:2px}
.gc-path{font-size:11.5px;font-family:ui-monospace,monospace;color:var(--dsw-alias-label-tertiary);
  word-break:break-all}
.gc-nextbox{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);
  padding:11px 13px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1)}

@media (max-width:720px){
  .gc-row,.gc-row.tri{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){
  .gc-root *{transition:none!important;animation:none!important}
}
`;

    /* ---------- 取数 ---------- */
    const CHANNELS = [
      { id: 'wechat', label: '微信' },
      { id: 'taptap', label: 'TapTap' },
      { id: 'crazygames', label: 'CrazyGames' }
    ];

    function stageSummary(ch) {
      if (!ch || !ch.stages || !ch.stages.length) return null;
      const active = ch.stages.find((s) => s.status === 'active');
      const failed = ch.stages.find((s) => s.status === 'failed' || s.status === 'blocked');
      const allDone = ch.stages.every((s) => s.status === 'done' || s.status === 'skipped');
      if (failed) {
        // 失败/受阻：单元格只放"卡在哪一步 "+ 一个极短的原因关键词，
        // 完整原因进 title。列宽只有 13%，塞长句会折成 4 行、把整行撑高，
        // 反而让真正的问题（合规阻断）不明显。
        return {
          tone: 'err',
          mark: failed.status === 'blocked' ? '⊘' : '✕',
          text: failed.label,
          title: failed.note || failed.label
        };
      }
      if (allDone) return { tone: 'ok', mark: '●', text: '已上线' };
      if (active) return { tone: active.automated === false ? 'warn' : 'run', mark: '◐', text: active.label };
      const pending = ch.stages.filter((s) => s.status === 'pending').length;
      return { tone: 'none', mark: '○', text: pending === ch.stages.length ? '未启动' : '等待中' };
    }

    /* ---------- 主组件 ---------- */
    function ConsolePanel(props) {
      const [state, setState] = useState({ loading: true, games: [], tasks: [], error: null });
      // 新建游戏弹层：null = 关闭，对象 = 正在编辑的表单
      const [draft, setDraft] = useState(null);
      // 新建后的自审结果：落盘成功但还没关弹层时显示
      const [created, setCreated] = useState(null);
      const [creating, setCreating] = useState(false);
      const [createErr, setCreateErr] = useState('');

      // 读快照文件，不走命令通道。
      //
      // 为什么：commands.execute 会往会话写记录，桌面应用持有写句柄时报
      //   session "..." is already owned by an active write handle
      // 面板整块空掉。
      //
      // 两条读路径，按顺序试：
      //   1. 全局快照 ~/.dsh/game-console/state.json（与会话无关，侧栏打开时也能用）
      //   2. 工作区相对路径 .game-console/state.json（跟着当前会话的工作区）
      // 服务端两个位置都写。
      const readSnapshot = useCallback(async () => {
        const readGlobal = props.readGlobal;
        const read = props.readFile;
        let text = null;
        if (readGlobal) text = await readGlobal();
        if (!text && read) text = await read('.game-console/state.json');
        if (!text) return null;
        try { return JSON.parse(text); } catch (e) { return null; }
      }, [props.readFile, props.readGlobal]);

      const load = useCallback(async () => {
        try {
          const data = await readSnapshot();
          if (!data) {
            setState((s) => ({ ...s, loading: false, error: null }));
            return;
          }
          setState({
            loading: false,
            games: data.games || [],
            tasks: data.tasks || [],
            error: null,
            job: data.job || null,
            jobRunning: Boolean(data.jobRunning)
          });
        } catch (error) {
          setState((s) => ({ ...s, loading: false, error: String((error && error.message) || error) }));
        }
      }, [readSnapshot]);

      useEffect(() => { load(); }, [load]);

      // 轮询快照：有任务时快一点，空闲时慢一点。全是只读文件读取。
      useEffect(() => {
        const ms = state.jobRunning ? 1200 : 4000;
        const timer = setInterval(load, ms);
        return () => clearInterval(timer);
      }, [state.jobRunning, load]);

      // 有任务在跑时读快照会更频繁（在下面那个 interval 里已按 jobRunning 调速），
      // 这里不需要额外的轮询循环。

      const startBuild = useCallback(async (project, target, action) => {
        try {
          // 构建是用户主动动作，必须走命令（服务端要 spawn 子进程）。
          // 单次触发、不轮询；进度靠读快照文件。
          if (!props.runBuild) throw new Error('命令通道不可用：请先在左侧打开一个会话');
          const res = await props.runBuild(project, target, action || 'build');
          if (!res || !res.ok) throw new Error((res && res.text) || '启动失败');
          setState((s) => ({ ...s, error: null, jobRunning: true }));
          await load();
        } catch (error) {
          setState((s) => ({ ...s, error: String((error && error.message) || error) }));
        }
      }, [props.runBuild, load]);

      /** 归档 / 恢复：不是构建任务，走通用的 /game-console 命令。 */
      const callCommand = useCallback(async (line) => {
        try {
          if (!props.runCommand) throw new Error('命令通道不可用：请先在左侧打开一个会话');
          const res = await props.runCommand(line);
          if (!res || !res.ok) throw new Error((res && res.text) || '执行失败');
          setState((s) => ({ ...s, error: null }));
          await load();
          return res;
        } catch (error) {
          setState((s) => ({ ...s, error: String((error && error.message) || error) }));
          return null;
        }
      }, [props.runCommand, load]);

      const archiveGame = useCallback(async (project, reason) => {
        await callCommand(`/game-console archive ${JSON.stringify({ project, reason })}`);
      }, [callCommand]);

      const openDraft = useCallback(() => {
        setCreated(null);
        setCreateErr('');
        setDraft({
          title: '', slug: '', genre: '', notes: '',
          target: 'wechat', orientation: 'landscape',
          duration: 60, hearts: 3,
          offline: true, iap: false, share: '',
          pace: '', emotion_theme: '',
          trend_evidence: '', trend_direction: ''
        });
      }, []);

      const closeDraft = useCallback(() => {
        setDraft(null);
        setCreated(null);
        setCreateErr('');
      }, []);

      const patchDraft = useCallback((patch) => {
        setDraft((d) => (d ? { ...d, ...patch } : d));
      }, []);

      const submitDraft = useCallback(async () => {
        if (!draft || creating) return;
        setCreating(true);
        setCreateErr('');
        try {
          if (!props.runCommand) throw new Error('命令通道不可用：请先在左侧打开一个会话');
          const res = await props.runCommand(`/game-console create ${JSON.stringify(draft)}`);
          if (!res || !res.ok) throw new Error((res && res.text) || '新建失败');
          let out = null;
          try { out = JSON.parse(res.text); } catch (e) { out = null; }
          if (!out) throw new Error(`服务端返回无法解析：${String(res.text).slice(0, 200)}`);
          setCreated(out);
          await load();
        } catch (error) {
          setCreateErr(String((error && error.message) || error));
        } finally {
          setCreating(false);
        }
      }, [draft, creating, props.runCommand, load]);

      // Esc 关弹层。只在弹层打开时挂监听，避免常驻抢键。
      useEffect(() => {
        if (!draft) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') closeDraft(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [draft, closeDraft]);

      const stats = useMemo(() => {
        const games = Array.isArray(state.games) ? state.games : [];
        const live = games.filter((g) => Object.values(g.state.channels || {}).some(
          (c) => (c.stages || []).length && c.stages.every((s) => s.status === 'done' || s.status === 'skipped')));
        const inReview = games.filter((g) => Object.values(g.state.channels || {}).some(
          (c) => (c.stages || []).some((s) => s.status === 'active')));
        let income = [];
        for (const g of games) {
          for (const [chan, r] of Object.entries(g.state.revenue || {})) {
            if (r && typeof r.amount === 'number') income.push({ chan, ...r });
          }
        }
        return {
          total: games.length,
          live: live.length,
          review: inReview.length,
          tasks: Array.isArray(state.tasks) ? state.tasks.length : 0,
          income
        };
      }, [state]);

      if (state.loading) {
        return h('div', { className: 'gc-root' },
          h('style', null, CSS),
          h('div', { className: 'gc-top' }, h('h1', null, '工作室')),
          h('div', { className: 'gc-empty' }, '正在扫描工作区…')
        );
      }

      return h('div', { className: 'gc-root' },
        h('style', null, CSS),
        h('div', { className: 'gc-top' },
          // 左侧留出桌面窗口的红黄绿按钮的位置，避免标题被压住
          h('div', { className: 'gc-top-safe' }),
          h('h1', null, '我的游戏'),
          h('span', { className: 'gc-count' }, String(stats.total)),
          h('span', { className: 'gc-grow' }),
          stats.tasks > 0 && h('span', { className: 'gc-todo-pill' },
            `${stats.tasks} 项待处理`),
          h('button', {
            className: 'gc-new',
            onClick: () => { setCreated(null); setDraft({ title: '', slug: '', genre: '', target: 'wechat', duration: 60, hearts: 3, offline: true, iap: false, share: '', pace: '', emotion_theme: '', trend_evidence: '', trend_direction: '', notes: '', orientation: 'landscape' }); }
          }, '+ 新建游戏'),
          h('button', { className: 'gc-btn gc-btn-icon', onClick: load, title: '刷新', 'aria-label': '刷新' }, '⟳')
        ),
        h('div', { className: 'gc-scroll' },
          state.error && h('div', { className: 'gc-empty', style: { color: 'var(--dsw-alias-state-error-primary)' } }, state.error),

          // ── 游戏画廊：卡片是页面主体 ──
          h('div', { className: 'gc-gallery' },
            state.games.length === 0
              ? h('div', { className: 'gc-empty-card' },
                h('div', { className: 'gc-empty-t' }, '还没有游戏'),
                h('div', { className: 'gc-empty-d' }, '用 Game Studio 做一个，或把已有工程放进工作区。'))
              : state.games.map((g) => {
                const st = g.state || {};
                const v = st.viral;
                const a = st.audit;
                const blocks = a ? a.items.filter((i) => i.level === 'BLOCK') : [];
                const hasBlock = blocks.length > 0;
                const busy = state.jobRunning && state.job && state.job.project === g.project;
                const anyBusy = state.jobRunning;
                const cover = st.cover;

                const badges = [];
                if (hasBlock) badges.push({ tone: 'bad', text: '合规 阻断' });
                else if (a) badges.push({ tone: 'ok', text: '合规 通过' });
                if (v) badges.push({ tone: v.verdict === 'suggest-drop' ? 'warn' : 'ok', text: `基因 ${v.score}/${v.total}` });

                let nextText = '';
                if (hasBlock) nextText = blocks[0].msg;
                else if (v && v.negativeTrend) nextText = '品类当前无窗口期，建议归档';
                else if (st.probe && st.probe.ok === false) nextText = st.probe.summary;
                else if (!a) nextText = '还没跑过自审';

                return h('article', { className: 'gc-card', key: g.project },
                  h('div', {
                    className: 'gc-cover',
                    style: (() => { const t = props.coverTone(g.project); return { '--cov-a': t.a, '--cov-b': t.b }; })()
                  },
                    cover
                      ? h('img', {
                        className: 'gc-cover-img',
                        src: cover.url,
                        alt: `${st.title || g.project} 的主形象`,
                        loading: 'lazy'
                      })
                      : h('div', { className: 'gc-cover-fallback' }, (st.title || g.project).slice(0, 1)),
                    badges.length > 0 && h('div', { className: 'gc-badges' },
                      badges.map((b, i) => h('span', { className: `gc-badge2 ${b.tone}`, key: i }, b.text))
                    ),
                    busy && h('div', { className: 'gc-cover-busy' }, '◐ ', state.job.line || '处理中…')
                  ),
                  h('div', { className: 'gc-card-body' },
                    h('h3', { className: 'gc-card-title' }, st.title || g.project),
                    h('div', { className: 'gc-card-sub' },
                      [st.genre, st.offline ? '单机' : '联网'].filter(Boolean).join(' · ')
                    ),
                    nextText && h('div', { className: 'gc-card-next' }, nextText)
                  ),
                  h('div', { className: 'gc-card-actions' },
                    h('button', {
                      className: 'gc-abtn',
                      disabled: anyBusy,
                      title: '转换 + 试玩 + 断言 + 截图',
                      onClick: () => startBuild(g.project, 'wechat')
                    }, '构建'),
                    h('button', {
                      className: 'gc-abtn',
                      disabled: anyBusy,
                      title: 'Gate 2：起浏览器实测产物，不采信 brief 自述',
                      onClick: () => startBuild(g.project, 'web', 'probe')
                    }, '实测'),
                    h('button', {
                      className: 'gc-abtn',
                      disabled: anyBusy || hasBlock,
                      title: hasBlock ? `有 ${blocks.length} 项合规阻断，先改` : '打成 TapTap 合规 zip',
                      onClick: () => startBuild(g.project, 'web', 'package-taptap')
                    }, '打包'),
                    h('button', {
                      className: 'gc-abtn gc-abtn-ghost',
                      disabled: anyBusy,
                      title: '移到归档区，不删文件',
                      onClick: () => {
                        if (typeof window !== 'undefined' && window.confirm && !window.confirm(`把「${st.title || g.project}」移到归档区？\n\n不删任何文件，之后可以从 _archive/ 手动移回。`)) return;
                        archiveGame(g.project, v && v.verdict === 'suggest-drop' ? '基因砍线' : '');
                      }
                    }, '归档')
                  )
                );
              })
          ),

          state.job && h('div', {
            className: 'gc-job',
            style: state.job.status === 'failed' ? { borderColor: 'var(--dsw-alias-state-error-primary)' } : undefined
          },
            h('div', { className: 'hd' },
              h('span', null,
                state.jobRunning ? '正在跑 · ' : (state.job.status === 'passed' ? '✓ 已完成 · ' : '✗ 失败 · '),
                (state.job.project || '').replace(/^games\//, ''),
                ' → ',
                state.job.target
              ),
              state.jobRunning && state.job.total
                ? h('span', { style: { marginLeft: 'auto', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' } },
                  `${state.job.phase}/${state.job.total}`)
                : null
            ),
            h('div', { style: { padding: '8px 12px' } },
              h('div', { className: 'gc-jobline' }, state.job.line || ''),
              state.job.error && h('div', { className: 'gc-jobline', style: { color: 'var(--dsw-alias-state-error-primary)' } }, state.job.error)
            )
          ),

          h('div', { className: 'gc-todo' },
            h('div', { className: 'hd' }, '待你处理',
              state.tasks.length > 0 && h('span', { className: 'gc-badge' }, String(state.tasks.length)),
              h('span', { style: { marginLeft: 'auto', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' } },
                '这些步骤平台替代不了'
            )),
            state.tasks.length === 0
              ? h('div', { className: 'gc-empty' }, '没有待办。')
              : state.tasks.map((t) => h('div', { className: 'gc-it', key: t.id },
                h('div', { className: 'ic gc-warn' }, t.deadline ? '⏱' : '◌'),
                h('div', null,
                  h('div', { className: 't' }, t.title),
                  t.detail && h('div', { className: 'd' }, t.detail),
                  t.deadline && h('div', { className: 'd', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                    `截止 ${String(t.deadline).replace('T', ' ').slice(0, 16)}`)
                )
              ))
          ),

          h('p', { className: 'gc-hint' },
            '数据来自各游戏目录下的 .forge/state.json；没有台账的显示「尚未建台账」，状态由 brief 和 .pipeline 推断。',
            h('br'),
            '人脸、备案短信、微信提审、建广告位这些永远要人做，平台只管把它们列出来，不假装能代办。'
          )
        ),

        draft && renderDraft({
          draft,
          created,
          creating,
          createErr,
          closeDraft,
          submitDraft,
          patchDraft,
          // 「改一下再试」：留着刚填的值回表单，方便补缺项
          back: () => { setCreated(null); setCreateErr(''); },
          // 「再建一个」：清掉这一款的身份字段，结构选项（时长/生命/方向）留着沿用
          reset: () => {
            setCreated(null);
            setCreateErr('');
            setDraft((d) => (d ? {
              ...d,
              title: '', slug: '', genre: '', notes: '',
              share: '', emotion_theme: '',
              trend_evidence: '', trend_direction: ''
            } : d));
          }
        })
      );
    }

    /* ---------- 新建游戏弹层 ---------- */
    // 弹层里的两部分：填表 → 自审结论。
    // 结论必须先于落盘后的下一步动作出现，否则用户建完一只眼睛不知道
    // "这游戏值不值得做"，还得自己回去翻 brief。
    //
    // 这些函数放在 ConsolePanel 外面，靠 o 参数拿 state——
    // 组件里的 useState 在这里不可见。
    function renderDraft(o) {
      const d = o.draft;
      const autoSlug = slugPreview(d.slug || d.title);
      const result = o.created;
      return h('div', {
        className: 'gc-mask',
        onClick: (e) => { if (e.target === e.currentTarget) o.closeDraft(); }
      },
        h('div', { className: 'gc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gc-modal-title' },
          h('div', { className: 'gc-modal-hd' },
            h('h2', { id: 'gc-modal-title' }, result ? '自审结果' : '新建游戏'),
            !result && h('span', { className: 'gc-sub' }, '先过需求阶段的合规 + 爆款基因两道关'),
            h('button', { className: 'gc-modal-x', onClick: o.closeDraft, 'aria-label': '关闭弹层' }, '✕')
          ),

          h('div', { className: 'gc-modal-bd' },
            result ? renderResult(result) : renderForm(o, d, autoSlug)
          ),

          h('div', { className: 'gc-modal-ft' },
            result
              ? [
                h('button', { className: 'gc-btn', onClick: o.closeDraft, key: 'close' }, '关闭'),
                h('span', { className: 'gc-grow', key: 'g' }),
                h('button', { className: 'gc-btn', onClick: o.back, key: 'back' }, '改一下再试'),
                h('button', { className: 'gc-new', key: 'again', onClick: o.reset }, '再建一个')
              ]
              : [
                o.createErr && h('span', { className: 'gc-note bad', style: { flex: 1 } }, o.createErr),
                !o.createErr && h('span', { className: 'gc-note', style: { flex: 1 } }, '只会生成 game.brief.json，不会生成游戏代码'),
                h('button', { className: 'gc-btn', onClick: o.closeDraft, disabled: o.creating, key: 'cancel' }, '取消'),
                h('button', {
                  className: 'gc-new', key: 'ok',
                  disabled: o.creating || !String(d.title || '').trim(),
                  onClick: o.submitDraft
                }, o.creating ? '创建中…' : '创建并自审')
              ]
          )
        )
      );
    }

    function renderForm(o, d, autoSlug) {
      const f = (key, label, node, hint) => h('div', { className: 'gc-field' },
        h('label', { htmlFor: `gc-f-${key}` }, label),
        node,
        hint && h('span', { className: 'gc-note' }, hint)
      );
      const patch = o.patchDraft;
      const input = (key, extra) => h('input', {
        id: `gc-f-${key}`,
        value: d[key] === undefined || d[key] === null ? '' : String(d[key]),
        onChange: (e) => patch({ [key]: e.target.value }),
        ...(extra || {})
      });
      const select = (key, options, coerce) => h('select', {
        id: `gc-f-${key}`,
        value: d[key] === undefined || d[key] === null ? '' : String(d[key]),
        onChange: (e) => patch({ [key]: coerce ? coerce(e.target.value) : e.target.value })
      }, options.map((op) => h('option', { value: op.v, key: op.v }, op.t)));
      const bool = (v) => v === 'true';

      const notesLen = String(d.notes || '').length;

      return h('div', { className: 'gc-result' },

        h('div', { className: 'gc-row' },
          f('title', '游戏名',
            input('title', { placeholder: '潮汐逃亡', autoFocus: true }),
            '会写进 brief.title，也显示在看板上'),
          f('slug', '目录名',
            input('slug', { placeholder: autoSlug || 'tide-escape' }),
            d.slug
              ? `games/${autoSlug || '…'}`
              : (autoSlug ? `留空则用 games/${autoSlug}` : '中文名生成不出目录名，必须手填，用小写字母/数字/连字符'))
        ),

        h('div', { className: 'gc-row' },
          f('genre', '玩法类型',
            input('genre', { placeholder: '解压躲避' }),
            '品类决定单局时长该在什么区间'),
          f('pace', '节奏',
            select('pace', [
              { v: '', t: '不填（按品类推断）' },
              { v: 'twitch', t: 'twitch · 10–90 秒' },
              { v: 'midcore', t: 'midcore · 60–180 秒' },
              { v: 'strategy', t: 'strategy · 180–480 秒' }
            ]),
            '填了就以它为准，不再靠品类猜')
        ),

        f('notes', '一句话规则',
          h('textarea', {
            id: 'gc-f-notes',
            value: String(d.notes || ''),
            placeholder: '按住拖动躲开障碍，吃到贝壳加分，撞三次结束',
            onChange: (e) => patch({ notes: e.target.value })
          }),
          notesLen > 120
            ? h('span', { className: 'gc-note bad' }, `${notesLen} 字，超过 120 字会被判「规则说不清」`)
            : `${notesLen}/120 —— 这一项同时决定 VD-01 和 VD-03（描述里要能看出操作有反馈）`
        ),

        h('div', { className: 'gc-row tri' },
          f('duration', '单局秒数',
            input('duration', { type: 'number', min: 5, max: 1200 }),
            null),
          f('hearts', '初始生命',
            input('hearts', { type: 'number', min: 1, max: 9 }),
            null),
          f('orientation', '屏幕方向',
            select('orientation', [
              { v: 'landscape', t: '横屏' },
              { v: 'portrait', t: '竖屏' }
            ]),
            null)
        ),

        h('div', { className: 'gc-row' },
          f('offline', '变现',
            select('offline', [
              { v: 'true', t: '单机（纯广告）' },
              { v: 'false', t: '联网' }
            ], bool),
            '单机才能走纯广告变现；联网要额外的服务端'),
          f('share', '分享机制',
            input('share', { placeholder: 'leaderboard / 邀请组队 / 留空' }),
            '留空且规则里也没提分享，VD-05 直接判未过')
        ),

        h('div', { className: 'gc-row' },
          f('emotion_theme', '情绪主题',
            input('emotion_theme', { placeholder: '紧张后放松、收集满足感' }),
            '人工项，机器不判'),
          f('trend_direction', '趋势方向',
            select('trend_direction', [
              { v: '', t: '未判断' },
              { v: 'positive', t: '正向 · 有窗口期' },
              { v: 'negative', t: '负向 · 没窗口期（直接砍线）' }
            ]),
            '不填会一直提示补，机器不猜方向')
        ),

        f('trend_evidence', '趋势依据',
          h('textarea', {
            id: 'gc-f-trend_evidence',
            value: String(d.trend_evidence || ''),
            placeholder: '例：2026-11 微信小游戏畅销 Top10 里没有本品类，同类最近一次进榜是 8 月',
            onChange: (e) => patch({ trend_evidence: e.target.value })
          }),
          '至少 10 个字才算有效证据。写负向结论就把上面方向选成「负向」'
        ),

        h('div', { className: 'gc-field' },
          h('label', null, '含内购'),
          h('select', {
            id: 'gc-f-iap',
            value: d.iap ? 'true' : 'false',
            onChange: (e) => patch({ iap: bool(e.target.value) })
          },
            h('option', { value: 'false' }, '否'),
            h('option', { value: 'true' }, '是')
          ),
          d.iap && h('span', { className: 'gc-note bad' }, '个人主体拿不到版号，含内购会被合规直接阻断')
        )
      );
    }

    function renderResult(r) {
      const v = r.viral || {};
      const a = r.audit || null;
      const drop = v.verdict === 'suggest-drop';
      const total = Number(v.total) || 8;
      const score = Number(v.score) || 0;
      const blocks = a ? (a.items || []).filter((i) => i.level === 'BLOCK') : [];
      const warns = a ? (a.items || []).filter((i) => i.level === 'WARN') : [];
      // 只列真正没过的。人工项单独归一堆，别混进"机器判你不过"里。
      const auto = (v.failed || []).filter((i) => !i.needsHuman);
      const human = (v.failed || []).filter((i) => i.needsHuman);

      let concl = '可以往下做：需求阶段两道关都过';
      let tone = 'good';
      if (v.error) { concl = `自审没跑起来：${v.error}（brief 已落盘，可以手动补）`; tone = 'bad'; }
      else if (blocks.length) { concl = `不能做：有 ${blocks.length} 项合规阻断，改需求再来`; tone = 'bad'; }
      else if (drop) { concl = '建议别做：爆款基因没过砍线，做了大概率白烧时间'; tone = 'weak'; }
      else if (auto.length) { concl = `可以做，但先补 ${auto.length} 项；还没到砍线`; tone = 'weak'; }
      else if (v.needsDirection) { concl = '可以做，但趋势方向没标，机器没法定砍线'; tone = 'weak'; }

      return h('div', { className: 'gc-result' },

        h('div', null,
          h('div', { className: 'gc-card-sub', style: { marginBottom: 8 } },
            r.brief && r.brief.title ? r.brief.title : r.project),
          h('div', { className: 'gc-score' },
            h('span', { className: 'n' }, v.error ? '—' : `${score}`),
            h('span', { className: 'd' }, v.error ? '' : `/ ${total} 条基因`),
            !v.error && h('span', {
              className: `gc-badge2 ${drop ? 'warn' : 'ok'}`,
              style: { position: 'static', marginLeft: 6 }
            }, drop ? 'suggest-drop' : 'proceed')
          ),
          !v.error && h('div', { className: `gc-g1bar ${drop ? 'is-drop' : ''}`, style: { marginTop: 10 } },
            Array.from({ length: total }).map((_, i) => h('span', { key: i, className: i < score ? 'on' : '' }))
          )
        ),

        h('div', { className: `gc-concl ${tone}` }, concl),

        blocks.length > 0 && h('div', { className: 'gc-group' },
          h('div', { className: 'gc-group-hd' }, '合规阻断'),
          blocks.map((b, i) => h('div', { className: 'gc-reason miss', key: `b${i}` },
            h('span', { className: 'mk', 'aria-hidden': 'true' }),
            h('span', { className: 'id' }, String(b.id || '').slice(0, 12)),
            h('div', null,
              h('div', { className: 'lb' }, b.msg),
              b.hint && h('div', { className: 'dt' }, b.hint)
            )
          ))
        ),

        auto.length > 0 && h('div', { className: 'gc-group' },
          h('div', { className: 'gc-group-hd' }, `机器判不过 · ${auto.length} 项`),
          auto.map((it, i) => h('div', { className: 'gc-reason miss', key: `a${i}` },
            h('span', { className: 'mk', 'aria-hidden': 'true' }),
            h('span', { className: 'id' }, it.id),
            h('div', null,
              h('div', { className: 'lb' }, it.label),
              it.detail && h('div', { className: 'dt' }, it.detail)
            )
          ))
        ),

        human.length > 0 && h('div', { className: 'gc-group' },
          h('div', { className: 'gc-group-hd' }, `需你自己确认 · ${human.length} 项（不计入砍线）`),
          human.map((it, i) => h('div', { className: 'gc-reason need', key: `h${i}` },
            h('span', { className: 'mk', 'aria-hidden': 'true' }),
            h('span', { className: 'id' }, it.id),
            h('div', null,
              h('div', { className: 'lb' }, it.label),
              it.detail && h('div', { className: 'dt' }, it.detail)
            )
          ))
        ),

        warns.length > 0 && h('div', { className: 'gc-note' },
          `另有 ${warns.length} 条合规提醒，不阻断，构建前会再列一次。`),

        h('div', { className: 'gc-nextbox' },
          h('div', { style: { fontWeight: 500, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 } },
            '下一步'),
          drop || blocks.length
            ? '点「改一下再试」补上缺的字段，退回表单重新自审。不想做就点「关闭」，把目录删掉，别让它占位。'
            : `去对话里让 Game Studio 按 ${r.project}/game.brief.json 生成游戏，生成完回看板点「构建」。`,
          h('div', { className: 'gc-path', style: { marginTop: 8 } }, r.project)
        )
      );
    }

    /** 目录名预览：与服务端 slugify 保持一致。中文会得到空串——这是有意的，
     *  让用户看见"生成不出来"而不是悄悄变成 games/game-1。 */
    function slugPreview(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    }

    /* ---------- 注册 ---------- */
    function apply(ctx) {
      // 两条通道，用途不同：
      //   读：remote.workspaceFiles.readBytes(sessionId, 相对路径) —— 纯只读，不写会话
      //   写：remote.commands.execute —— 仅用户主动触发（构建），单次、不轮询
      //
      // 用命令通道做持续轮询会导致：
      //   session "..." is already owned by an active write handle
      // 桌面应用持有写句柄时整块面板会空掉。
      // 全局快照：优先走宿主的 /api/file 路由（同一套鉴权，简单可靠），
      // 再退回 resources.open。两条都失败就当没数据，不抛错。
      //
      // 多实例：桌面应用和 web 实例会各写一份 state.<id>.json，
      // instances.json 里记着每份的 schema 和时间。挑 schema 最高、最新的那份读，
      // 这样旧进程写的旧格式不会盖住新字段。
      const fetchText = async (absPath) => {
        try {
          const res = await fetch(`/api/file?path=${encodeURIComponent(absPath)}`, { cache: 'no-store' });
          if (res && res.ok) return await res.text();
        } catch (error) { /* 落到下一条 */ }
        try {
          const handle = await ctx.resources.open(`dsh-resource://file/absolute${absPath}`, {});
          if (!handle) return null;
          if (typeof handle === 'string') return handle;
          if (handle.data) return new TextDecoder().decode(handle.data);
          if (typeof handle.text === 'string') return handle.text;
          if (typeof handle[Symbol.asyncIterator] === 'function') {
            for await (const notice of handle) {
              if (!notice || !notice.ok) return null;
              const v = notice.value;
              if (v === undefined) continue;
              if (typeof v === 'string') return v;
              if (v && v.data) return new TextDecoder().decode(v.data);
              if (v && typeof v.text === 'string') return v.text;
            }
          }
          return null;
        } catch (error) {
          return null;
        }
      };

      const readGlobal = async () => {
        const dir = globalSnapshotDir();
        if (!dir) return null;

        // 1. 读实例清单，挑 schema 最高且最新的
        const indexText = await fetchText(`${dir}/instances.json`);
        if (indexText) {
          try {
            const index = JSON.parse(indexText);
            const best = Object.values(index)
              .filter((e) => e && e.file)
              .sort((a, b) => (b.schema || 0) - (a.schema || 0) || String(b.at).localeCompare(String(a.at)))[0];
            if (best) {
              const text = await fetchText(`${dir}/${best.file}`);
              if (text) return text;
            }
          } catch (e) { /* 清单坏了就退到兼容路径 */ }
        }

        // 2. 兼容路径：老的单文件快照，只认 schema 够新的
        const legacy = await fetchText(`${dir}/state.json`);
        if (legacy) {
          try { if ((JSON.parse(legacy).schema || 0) > 0) return legacy; } catch (e) { /* 坏 JSON 不采信 */ }
        }
        return null;
      };

      function globalSnapshotDir() {
        const home = osHomeDir();
        return home ? `${home}/.dsh/game-console` : '';
      }

      /** 客户端的 home 目录：宿主不保证提供，从会话的 cwd 推。 */
      function osHomeDir() {
        try {
          const rows = ctx.sessions && ctx.sessions.list && ctx.sessions.list.getSnapshot
            ? ctx.sessions.list.getSnapshot().byId : null;
          for (const row of rows ? Object.values(rows) : []) {
            const cwd = String((row && (row.cwd || row.workingDirectory)) || '');
            const m = /^(\/(?:Users|home)\/[^/]+)/.exec(cwd);
            if (m) return m[1];
          }
          return '';
        } catch (e) { return ''; }
      }

      /**
       * 每款游戏一个稳定的封面底色。
       * 用项目名哈希取色相，同一款游戏每次打开的配色都一样。
       * 饱和度压得很低——封面是衬托主形象的，不该抢戏。
       */
      const coverTone = (key) => {
        let h = 0;
        for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
        return { a: `hsl(${h} 34% 84%)`, b: `hsl(${(h + 26) % 360} 40% 72%)` };
      };

      const readFile = async (sessionId, relPath) => {
        try {
          const sid = sessionId || currentSessionId(ctx);
          if (!sid) return null;
          const result = await ctx.remote.workspaceFiles.readBytes(sid, relPath, {});
          if (!result || !result.ok) return null;
          return new TextDecoder().decode(result.value.data);
        } catch (error) {
          return null;
        }
      };

      /**
       * 面板动作：POST /api/game-console，不走命令通道。
       *
       * 曾经走 ctx.remote.commands.execute(会话ID, ...)，但那条路要求会话归本实例
       * 所有。桌面应用和 web 实例共享 ~/.dsh，侧栏里能看见对方的会话——一旦面板
       * 绑到对方持有的会话，任何写操作都直接报
       *   session "..." is already owned by an active write handle
       * 新建、归档、构建都不需要会话，只读写工作区文件，所以走这条独立路由。
       * 该路由注册在宿主的鉴权栅栏内，鉴权由连接服务负责。
       *
       * 返回 { ok, text }，text 与旧的命令返回一致，调用方不用改。
       */
      const callApi = async (action, payload) => {
        try {
          const res = await fetch('/api/game-console', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, payload: payload || {} }),
            cache: 'no-store'
          });
          if (!res || !res.ok) {
            let msg = `请求失败（HTTP ${res ? res.status : '?'}）`;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* 用默认文案 */ }
            return { ok: false, text: msg };
          }
          const body = await res.json();
          if (!body || body.ok === false) return { ok: false, text: (body && body.error) || '执行失败' };
          return { ok: true, text: JSON.stringify(body.result) };
        } catch (error) {
          return { ok: false, text: error instanceof Error ? error.message : String(error) };
        }
      };

      const runBuildFor = () => (project, target, action) =>
        callApi('run', { project, target, action: action || 'build' });

      /** 任意面板动作（新建、归档、改阶段）。保留 `/game-console <action> {json}` 的调用形态。 */
      const runCommandFor = () => (line) => {
        const s = String(line || '').trim();
        const m = /^\/game-console\s+(\S+)\s*([\s\S]*)$/.exec(s);
        if (!m) return Promise.resolve({ ok: false, text: '无法解析的动作' });
        let payload = {};
        if (m[2]) {
          try { payload = JSON.parse(m[2]); } catch (e) { return Promise.resolve({ ok: false, text: '动作参数不是合法 JSON' }); }
        }
        return callApi(m[1], payload);
      };

      function currentSessionId(c) {
        try {
          const rows = c.sessions && c.sessions.list && c.sessions.list.getSnapshot
            ? c.sessions.list.getSnapshot().byId : null;
          if (!rows) return '';
          const current = Object.values(rows).find((row) => (row.retainedBy && row.retainedBy.mainView) > 0);
          if (current && current.id) return current.id;
          const first = Object.values(rows)[0];
          return first && first.id ? first.id : '';
        } catch (e) { return ''; }
      }

      ctx.effect(() => ctx.slots.inject('main', function* () {
        yield ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: (sessionId) => ({
            consoleSessionId: typeof sessionId === 'string' ? sessionId : '',
            readFile: (rel) => readFile(sessionId, rel),
            readGlobal,
            runBuild: runBuildFor(),
            runCommand: runCommandFor(),
            coverTone
          })
        }, ConsolePanel);
      }), 'game-console: main panel');

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 0,
        label: () => '工作室',
        locale: NS
      }, PanelIcon)), 'game-console: sidebar entry');
    }

    return { inject, apply };
  }
});
