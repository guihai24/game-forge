/* 客户端：右栏常驻 tab「游戏工坊」。
 *
 * 只渲染，不做事：扫描、跑任务、进度都在服务端命令里。
 * 面板每 1.5 秒轮询一次 status，有任务结束时重新扫描。
 */

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';

const ID = '@guihai24/dsh-game-forge/panel';
const POLL_MS = 1500;

export const inject = [
  'slots', 'locale', 'remote', 'remote.commands', 'sidebarRight', 'sidebarRightTabs'
];

function Icon() {
  return h(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M2 9.5 3.6 4.3A1.6 1.6 0 0 1 5.1 3.2h5.8a1.6 1.6 0 0 1 1.5 1.1L14 9.5v3.3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9.5Z',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round'
    }),
    h('path', { d: 'M5.2 10.6h1.6M9.2 10.6h1.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })
  );
}

const S = {
  root: { height: '100%', overflow: 'auto', padding: '10px 12px', fontSize: 13, lineHeight: 1.5 },
  bar: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  title: { fontWeight: 600, fontSize: 13 },
  count: { opacity: 0.55, fontSize: 12 },
  ghost: {
    font: 'inherit', fontSize: 12, padding: '3px 10px', borderRadius: 6,
    border: '1px solid rgba(128,128,128,.35)', background: 'transparent', cursor: 'pointer'
  },
  card: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, padding: '9px 11px', marginBottom: 8 },
  cardTitle: { fontWeight: 600, fontSize: 13, marginBottom: 2 },
  meta: { fontSize: 12, opacity: 0.6, marginBottom: 6 },
  row: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 4, flexWrap: 'wrap' },
  chip: { fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid rgba(128,128,128,.3)' },
  ok: { color: '#1a9e55' }, bad: { color: '#d0453b' }, none: { opacity: 0.45 },
  btn: {
    font: 'inherit', fontSize: 11.5, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
    border: '1px solid rgba(128,128,128,.35)', background: 'transparent'
  },
  btnOff: { opacity: 0.4, cursor: 'default' },
  track: { height: 4, borderRadius: 999, background: 'rgba(128,128,128,.2)', marginTop: 7, overflow: 'hidden' },
  fill: { height: '100%', background: 'rgba(80,140,255,.75)', transition: 'width .3s ease' },
  hint: { fontSize: 12, opacity: 0.5, marginTop: 12, lineHeight: 1.6 },
  error: { color: '#d0453b', fontSize: 12 },
  line: { fontSize: 11, opacity: 0.55, marginTop: 5, fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
};

function fmtAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.round(hr / 24)} 天前`;
}

const BUTTONS = [
  { action: 'wechat-playtest', label: '试玩' },
  { action: 'wechat-preview', label: '预览' },
  { action: 'web', label: '网页' },
  { action: 'upload', label: '上传' }
];

function Card({ game, job, busy, onRun }) {
  const run = game.lastRun;
  const built = game.built || {};
  const wechatOk = (run && run.target === 'wechat' && run.ok) || Boolean(built.wechat);
  const webOk = (run && run.target === 'web' && run.ok) || Boolean(built.web);
  const mark = (ok, label) =>
    h('span', { style: { ...S.chip, ...(ok ? S.ok : S.none) } }, `${label} ${ok ? '✅' : '—'}`);

  const pct = job && job.total > 0 ? Math.round((job.phase / job.total) * 100) : 0;

  return h(
    'div',
    { style: S.card },
    h('div', { style: S.cardTitle }, game.title),
    h('div', { style: S.meta }, [game.genre, `目标 ${game.target}`, game.orientation].filter(Boolean).join(' · ')),
    h(
      'div',
      { style: S.row },
      mark(wechatOk, '微信'),
      mark(webOk, '网页'),
      run && h('span', { style: { marginLeft: 'auto', opacity: 0.5 } }, fmtAgo(run.at))
    ),
    h(
      'div',
      { style: S.row },
      ...BUTTONS.map((b) =>
        h('button', {
          key: b.action,
          style: { ...S.btn, ...(busy ? S.btnOff : null) },
          disabled: busy,
          onClick: () => onRun(game.project, b.action),
          title: busy ? '有任务正在跑' : `跑 ${b.action}`
        }, b.label)
      )
    ),
    job && h('div', { style: { marginTop: 6 } },
      h('div', { style: { ...S.track } }, h('div', { style: { ...S.fill, width: `${pct}%` } })),
      h('div', { style: S.line }, `${pct}% · ${job.line || ''}`)
    )
  );
}

function Panel(props) {
  const sessionId = props.forgeSessionId || props.sessionId || '';
  const runCommand = props.runCommand;
  const [state, setState] = useState({ games: [], jobs: [], running: null, error: null, loading: true });
  const finishing = useRef(null);

  const call = useCallback(async (input) => {
    if (!runCommand || !sessionId) return { ok: false, text: '命令通道不可用' };
    return runCommand(sessionId, input);
  }, [runCommand, sessionId]);

  const loadGames = useCallback(async () => {
    const res = await call('scan');
    if (!res.ok) { setState((s) => ({ ...s, loading: false, error: res.text })); return; }
    try {
      const data = JSON.parse(res.text);
      setState((s) => ({ ...s, loading: false, error: null, games: data.games || [] }));
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: '无法解析扫描结果' }));
    }
  }, [call]);

  const poll = useCallback(async () => {
    const res = await call('status');
    if (!res.ok) return;
    try {
      const data = JSON.parse(res.text);
      setState((s) => ({ ...s, jobs: data.jobs || [], running: data.running || null }));
      // 任务刚结束 → 重新扫描
      if (finishing.current && !data.running) {
        const id = finishing.current;
        finishing.current = null;
        const done = (data.jobs || []).find((j) => j.id === id);
        if (done) loadGames();
      }
    } catch (e) { /* 忽略一次轮询失败 */ }
  }, [call, loadGames]);

  useEffect(() => { loadGames(); }, [loadGames]);
  useEffect(() => {
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  const onRun = useCallback(async (project, action) => {
    const res = await call(`run ${JSON.stringify({ project, action })}`);
    if (!res.ok) { setState((s) => ({ ...s, error: res.text })); return; }
    try {
      const data = JSON.parse(res.text);
      finishing.current = data.jobId;
      setState((s) => ({ ...s, error: null, running: data.jobId }));
      poll();
    } catch (e) { /* 忽略 */ }
  }, [call, poll]);

  const runningJob = state.running ? (state.jobs || []).find((j) => j.id === state.running) : null;

  return h(
    'div',
    { style: S.root, 'data-plugin': 'dsh-game-forge' },
    h('div', { style: S.bar },
      h(Icon),
      h('span', { style: S.title }, '游戏工坊'),
      h('span', { style: S.count }, state.loading ? '扫描中…' : `${state.games.length} 个游戏`),
      h('button', { style: { ...S.ghost, marginLeft: 'auto' }, onClick: loadGames }, '刷新')
    ),
    state.error && h('div', { style: S.error }, state.error),
    !state.loading && state.games.length === 0 && !state.error &&
      h('div', { style: S.hint }, '工作区里还没有游戏。先让 agent 用 Game Studio 做一个。'),
    state.games.map((g) => {
      const job = runningJob && runningJob.project === g.project ? runningJob : null;
      return h(Card, {
        key: g.project,
        game: g,
        job,
        busy: Boolean(state.running),
        onRun
      });
    }),
    h('div', { style: S.hint },
      '任务在后台跑，切走再回来也不会丢。',
      h('br'),
      '微信任务约 100 秒，期间请勿操作开发者工具。'
    )
  );
}

export function apply(ctx) {
  const runCommand = async (sessionId, input) => {
    try {
      const result = await ctx.remote.commands.execute(sessionId, `/game-forge ${input}`, []);
      if (!result.ok) {
        return { ok: false, text: (result.error && result.error.message) || '命令失败' };
      }
      const value = result.value && result.value.result !== undefined ? result.value.result : result.value;
      if (value === undefined) return { ok: false, text: '命令在当前会话不可用' };
      return { ok: true, text: String(value.text !== undefined ? value.text : '') };
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  };

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: 'game-forge',
    title: () => '游戏工坊',
    guide: [{
      id: 'game-forge',
      order: 61,
      title: () => '游戏工坊',
      description: () => '工作区里每个游戏的两渠道状态，一键试玩 / 预览 / 上传',
      icon: Icon
    }]
  }), 'game-forge: tab type');

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: ID,
    inject: (sessionId) => ({
      forgeSessionId: typeof sessionId === 'string' ? sessionId : '',
      runCommand
    })
  }, Panel)), 'game-forge: tab body');
}
