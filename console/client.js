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
.gc-verdict{font-size:11px;margin-top:2px;line-height:1.5}
.gc-verdict.good{color:var(--dsw-alias-state-success-primary)}
.gc-verdict.weak{color:var(--dsw-alias-state-warn-primary)}
.gc-verdict.bad{color:var(--dsw-alias-state-error-primary)}
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
.gc-job{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden;margin-bottom:16px}
.gc-job .hd{padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;font-weight:500;display:flex;align-items:center;gap:7px}
.gc-jobline{font-size:11.5px;font-family:ui-monospace,monospace;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gc-btn:disabled{opacity:.4;cursor:default}
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
      const [state, setState] = useState({ loading: true, games: [], tasks: [], error: null });

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
                h('th', { style: { width: '24%' } }, '游戏 / 值不值得上架'),
                CHANNELS.map((c) => h('th', { key: c.id, style: { width: '13%' } }, c.label)),
                h('th', { style: { width: '78px' } }, '合规'),
                h('th', { style: { width: '78px' } }, '基因'),
                h('th', { style: { width: '120px', textAlign: 'right' } }, '')
              )),
              h('tbody', null,
                state.games.length === 0
                  ? h('tr', null, h('td', { colspan: 7 }, h('div', { className: 'gc-empty' }, '工作区里还没有游戏。用 Game Studio 做一个，或把已有工程放进工作区。')))
                  : state.games.map((g) => {
                    const channels = g.state.channels || {};
                    const busy = state.jobRunning && state.job && state.job.project === g.project;
                    const anyBusy = state.jobRunning;
                    return h('tr', { key: g.project },
                      h('td', null,
                        h('div', { className: 'gc-name' }, g.state.title || g.project),
                        // 值不值得上架：把合规和基因合起来一句话说完，不用点开
                        (() => {
                          const parts = [];
                          const a = g.state.audit;
                          if (a) {
                            const blocks = a.items.filter((i) => i.level === 'BLOCK').length;
                            parts.push(blocks ? `合规：有 ${blocks} 项 BLOCK` : '合规：通过');
                          }
                          if (g.state.viral) parts.push(`基因：${g.state.viral.score}/${g.state.viral.total}`);
                          if (!parts.length) return h('div', { className: 'gc-gid' }, g.project);
                          return h('div', {
                            className: `gc-verdict ${a && a.items.some((i) => i.level === 'BLOCK') ? 'bad' : (g.state.viral && g.state.viral.verdict === 'suggest-drop' ? 'weak' : 'good')}`,
                            title: g.state.viral ? g.state.viral.summary : ''
                          }, parts.join('　·　'));
                        })(),
                        g.state.probe
                          ? h('div', { className: 'gc-gid', title: '产物实测（Gate 2）' }, `实测：${g.state.probe.summary}`)
                          : null
                      ),
                      CHANNELS.map((c) => {
                        // TapTap 没建台账时，用打包产物说明状态：有 zip 就是「已打包」
                        if (c.id === 'taptap' && !stageSummary(channels.taptap) && g.state.taptapZip) {
                          return h('td', { key: c.id },
                            h('span', { className: 'gc-st gc-run', title: `${g.state.taptapZip.file} · ${Math.round(g.state.taptapZip.bytes / 1024)} KB` },
                              `○ 已打包`)
                          );
                        }
                        const s = stageSummary(channels[c.id]);
                        const cls = s ? { ok: 'gc-ok', warn: 'gc-warn', err: 'gc-err', run: 'gc-run', none: 'gc-none' }[s.tone] : 'gc-none';
                        return h('td', { key: c.id },
                          h('span', { className: `gc-st ${cls}` }, s ? `${s.mark} ${s.text}` : '—')
                        );
                      }),
                      h('td', null,
                        (() => {
                          const a = g.state.audit;
                          if (!a) return h('span', { className: 'gc-st gc-none' }, '—');
                          const blocks = a.items.filter((i) => i.level === 'BLOCK');
                          const warns = a.items.filter((i) => i.level === 'WARN');
                          if (blocks.length) {
                            return h('span', {
                              className: 'gc-st gc-err',
                              title: blocks.map((b) => `${b.msg}\n→ ${b.hint}`).join('\n\n')
                            }, `✗ ${blocks.length} 阻断`);
                          }
                          if (warns.length) {
                            return h('span', {
                              className: 'gc-st gc-warn',
                              title: warns.map((w) => `${w.msg}\n→ ${w.hint}`).join('\n\n')
                            }, `⚠ ${warns.length}`);
                          }
                          return h('span', { className: 'gc-st gc-ok' }, '✓');
                        })()
                      ),
                      // 基因：Gate 1 打分 + 砍线状态；悬停看每一项
                      h('td', null,
                        (() => {
                          const v = g.state.viral;
                          if (!v) return h('span', { className: 'gc-st gc-none' }, '—');
                          const tone = v.verdict === 'suggest-drop' ? 'gc-warn' : 'gc-ok';
                          const tip = [
                            `viral-dna ${v.score}/${v.total}`,
                            ...v.failed.map((i) => `${i.needsHuman ? '?' : '⚠'} ${i.id} ${i.label}：${i.detail}`),
                            '',
                            v.summary
                          ].join('\n');
                          return h('span', { className: `gc-st ${tone}`, title: tip }, `${v.score}/${v.total}`);
                        })()
                      ),
                      h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                        busy
                          ? h('span', { className: 'gc-st gc-run' }, `◐ ${state.job.total ? `${state.job.phase}/${state.job.total}` : '…'}`)
                          : h(Fragment, null,
                            h('button', {
                              className: 'gc-btn sm',
                              disabled: anyBusy,
                              title: anyBusy ? '已有任务在跑（模拟器串行）' : '转换 + 试玩 + 断言 + 截图',
                              onClick: () => startBuild(g.project, 'wechat')
                            }, '构建'),
                            h('button', {
                              className: 'gc-btn sm',
                              style: { marginLeft: 6 },
                              disabled: anyBusy,
                              title: anyBusy ? '已有任务在跑' : '打成单文件 HTML 并验证',
                              onClick: () => startBuild(g.project, 'web')
                            }, '网页'),
                            h('button', {
                              className: 'gc-btn sm',
                              style: { marginLeft: 6 },
                              disabled: anyBusy || (g.state.audit ? !g.state.audit.ok : false),
                              title: g.state.audit && !g.state.audit.ok
                                ? `自审有 ${g.state.audit.blocked} 项阻断，先改：${g.state.audit.items.filter((i) => i.level === 'BLOCK').map((i) => i.msg).join('；')}`
                                : '打成 TapTap 合规 zip（一级目录 + index.html，排除 game.json）',
                              onClick: () => startBuild(g.project, 'web', 'package-taptap')
                            }, 'TT包'),
                            h('button', {
                              className: 'gc-btn sm',
                              style: { marginLeft: 6 },
                              disabled: anyBusy,
                              title: anyBusy
                                ? '已有任务在跑'
                                : 'Gate 2：起浏览器实测分享/反馈延迟/单局时长/冷启动，不采信 brief 自述',
                              onClick: () => startBuild(g.project, 'web', 'probe')
                            }, '实测')
                          )
                      )
                    );
                  })
              )
            )
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
        )
      );
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

      const runBuild = async (project, target, action) => {
        try {
          const sid = currentSessionId(ctx);
          if (!sid) return { ok: false, text: '没有打开中的会话：先在左侧打开一个会话，构建需要它来接收输出' };
          const line = `/game-console run ${JSON.stringify({ project, target, action: action || 'build' })}`;
          const result = await ctx.remote.commands.execute(sid, line, []);
          if (!result || !result.ok) {
            return { ok: false, text: (result && result.error && result.error.message) || '构建启动失败' };
          }
          const value = result.value && result.value.result !== undefined ? result.value.result : result.value;
          if (value === undefined) return { ok: false, text: '命令在当前会话不可用' };
          return { ok: value.kind === 'success', text: String(value.text !== undefined ? value.text : '') };
        } catch (error) {
          return { ok: false, text: error instanceof Error ? error.message : String(error) };
        }
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
            runBuild
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
