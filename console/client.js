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

    const inject = ['slots', 'locale', 'remote', 'remote.commands', 'sessions'];

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
.gc-top{height:46px;flex:none;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.gc-top h1{font-size:14px;font-weight:600;margin:0}
.gc-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.gc-grow{flex:1}
.gc-btn{font:inherit;font-size:12px;padding:5px 11px;border-radius:7px;cursor:pointer;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit}
.gc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gc-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.gc-btn.sm{padding:3px 9px;font-size:11.5px}
.gc-scroll{overflow:auto;padding:14px 18px 40px}
.gc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.gc-stat{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:10px 12px}
.gc-stat .k{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}
.gc-stat .v{font-size:19px;font-weight:600}
.gc-stat .v small{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary);margin-left:3px}
.gc-board{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden;margin-bottom:16px}
.gc-board table{width:100%;border-collapse:collapse}
.gc-board th{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);text-align:left;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}
.gc-board td{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:middle}
.gc-board tr:last-child td{border-bottom:0}
.gc-board tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}
.gc-name{font-weight:500}
.gc-gid{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,monospace;margin-top:1px}
.gc-st{display:inline-flex;align-items:center;gap:5px;font-size:12px}
.gc-ok{color:var(--dsw-alias-state-success-primary)}
.gc-warn{color:var(--dsw-alias-state-warn-primary)}
.gc-err{color:var(--dsw-alias-state-error-primary)}
.gc-none{color:var(--dsw-alias-label-tertiary)}
.gc-run{color:var(--dsw-alias-brand-primary)}
.gc-todo{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden}
.gc-todo .hd{padding:9px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;font-weight:500;display:flex;align-items:center;gap:7px}
.gc-badge{font-size:11px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-state-warn-primary);color:#fff}
.gc-it{display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-start}
.gc-it:last-child{border-bottom:0}
.gc-it .t{font-size:12.5px}
.gc-it .d{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px;white-space:pre-line}
.gc-it .ic{flex:none;width:16px;text-align:center}
.gc-it .go{margin-left:auto;align-self:center;flex:none}
.gc-empty{padding:28px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.gc-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:14px;line-height:1.7}
.gc-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);margin-right:4px;white-space:nowrap}
.gc-chip.done{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.gc-chip.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.gc-chip.failed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
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
        // 失败/受阻要显眼：说清卡在哪一步，并带上原因的前半句
        const why = failed.note ? ` · ${String(failed.note).split(/[。；\n]/)[0].slice(0, 28)}` : '';
        return { tone: 'err', mark: failed.status === 'blocked' ? '⊘' : '✕', text: failed.label + why };
      }
      if (allDone) return { tone: 'ok', mark: '●', text: '已上线' };
      if (active) return { tone: active.automated === false ? 'warn' : 'run', mark: '◐', text: active.label };
      const pending = ch.stages.filter((s) => s.status === 'pending').length;
      return { tone: 'none', mark: '○', text: pending === ch.stages.length ? '未启动' : '等待中' };
    }

    /* ---------- 主组件 ---------- */
    function ConsolePanel(props) {
      const sessionId = props.consoleSessionId || props.sessionId || '';
      const runCommand = props.runCommand;
      const [state, setState] = useState({ loading: true, games: [], tasks: [], error: null });

      // 主区面板从侧栏打开时没有 sessionId，需要自己找当前会话。
      // 官方做法：ctx.sessions.list 里 retainedBy.mainView > 0 的那条。
      const resolveSession = useCallback(() => {
        if (sessionId) return sessionId;
        try {
          const list = props.sessions && props.sessions.list;
          const rows = list && list.getSnapshot ? list.getSnapshot().byId : null;
          if (rows) {
            const current = Object.values(rows).find((row) => (row.retainedBy && row.retainedBy.mainView) > 0);
            if (current && current.id) return current.id;
            const any = Object.values(rows)[0];
            if (any && any.id) return any.id;
          }
        } catch (e) { /* 落到下面的报错 */ }
        return '';
      }, [sessionId, props.sessions]);

      const call = useCallback(async (input) => {
        if (!runCommand) throw new Error('命令通道不可用');
        const sid = resolveSession();
        if (!sid) throw new Error('没有可用会话：先在左侧点开一个会话，再回到工作室');
        const res = await runCommand(sid, input);
        if (!res || !res.ok) throw new Error((res && res.text) || '命令失败');
        return JSON.parse(res.text);
      }, [runCommand, resolveSession]);

      const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true, error: null }));
        try {
          const data = await call('scan');
          setState({ loading: false, games: data.games || [], tasks: data.tasks || [], error: null });
        } catch (error) {
          setState({ loading: false, games: [], tasks: [], error: String(error.message || error) });
        }
      }, [call]);

      useEffect(() => { load(); }, [load]);

      const stats = useMemo(() => {
        const games = state.games;
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
          tasks: state.tasks.length,
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
          h('h1', null, '工作室'),
          h('span', { className: 'gc-sub' }, `${stats.total} 款游戏`),
          h('span', { className: 'gc-grow' }),
          h('button', { className: 'gc-btn', onClick: load }, '刷新')
        ),
        h('div', { className: 'gc-scroll' },
          state.error && h('div', { className: 'gc-empty', style: { color: 'var(--dsw-alias-state-error-primary)' } }, state.error),

          h('div', { className: 'gc-stats' },
            h('div', { className: 'gc-stat' }, h('div', { className: 'k' }, '游戏'), h('div', { className: 'v' }, String(stats.total))),
            h('div', { className: 'gc-stat' }, h('div', { className: 'k' }, '已上线'), h('div', { className: 'v' }, String(stats.live))),
            h('div', { className: 'gc-stat' }, h('div', { className: 'k' }, '进行中'), h('div', { className: 'v' }, String(stats.review))),
            h('div', { className: 'gc-stat' }, h('div', { className: 'k' }, '待你处理'), h('div', { className: 'v', style: { color: stats.tasks ? 'var(--dsw-alias-state-warn-primary)' : undefined } }, String(stats.tasks)))
          ),

          h('div', { className: 'gc-board' },
            h('table', null,
              h('thead', null, h('tr', null,
                h('th', { style: { width: '30%' } }, '游戏'),
                CHANNELS.map((c) => h('th', { key: c.id, style: { width: '17%' } }, c.label)),
                h('th', null, '备注')
              )),
              h('tbody', null,
                state.games.length === 0
                  ? h('tr', null, h('td', { colspan: 5 }, h('div', { className: 'gc-empty' }, '工作区里还没有游戏。用 Game Studio 做一个，或把已有工程放进工作区。')))
                  : state.games.map((g) => {
                    const channels = g.state.channels || {};
                    return h('tr', { key: g.project },
                      h('td', null,
                        h('div', { className: 'gc-name' }, g.state.title || g.project),
                        h('div', { className: 'gc-gid' }, g.project)
                      ),
                      CHANNELS.map((c) => {
                        const s = stageSummary(channels[c.id]);
                        const cls = s ? { ok: 'gc-ok', warn: 'gc-warn', err: 'gc-err', run: 'gc-run', none: 'gc-none' }[s.tone] : 'gc-none';
                        return h('td', { key: c.id },
                          h('span', { className: `gc-st ${cls}` }, s ? `${s.mark} ${s.text}` : '—')
                        );
                      }),
                      h('td', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } },
                        g.state.inferred ? '尚未建台账' : (g.state.offline ? '单机' : '联网')
                      )
                    );
                  })
              )
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
        )
      );
    }

    /* ---------- 注册 ---------- */
    function apply(ctx) {
      // 和旧插件同一套命令通道：execute(sessionId, "/命令 参数", [])
      // 返回值 { ok, value: { result: { kind, text } } }
      const runCommand = async (sessionId, input) => {
        try {
          const result = await ctx.remote.commands.execute(sessionId, `/game-console ${input}`, []);
          if (!result || !result.ok) {
            return { ok: false, text: (result && result.error && result.error.message) || '命令失败' };
          }
          const value = result.value && result.value.result !== undefined ? result.value.result : result.value;
          if (value === undefined) return { ok: false, text: '命令在当前会话不可用' };
          return { ok: value.kind === 'success', text: String(value.text !== undefined ? value.text : '') };
        } catch (error) {
          return { ok: false, text: error instanceof Error ? error.message : String(error) };
        }
      };

      ctx.effect(() => ctx.slots.inject('main', function* () {
        yield ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: (sessionId) => ({
            consoleSessionId: typeof sessionId === 'string' ? sessionId : '',
            runCommand,
            sessions: ctx.sessions
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
