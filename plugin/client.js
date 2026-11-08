/* 客户端：在右栏注册一个常驻 tab「游戏工坊」。
 *
 * 只渲染，不做事 —— 数据来自服务端命令 /game-forge scan。
 * 入口用 sidebarRightTabs 的 guide 字段（不需要资源地址，打开就能见）。
 */

import { createElement as h, useCallback, useEffect, useState } from 'react';

const ID = '@guihai24/dsh-game-forge/panel';

export const inject = [
  'slots',
  'locale',
  'remote',
  'remote.commands',
  'sidebarRight',
  'sidebarRightTabs'
];

/* ---------- 图标 ---------- */
function Icon() {
  return h(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M2 9.5 3.6 4.3A1.6 1.6 0 0 1 5.1 3.2h5.8a1.6 1.6 0 0 1 1.5 1.1L14 9.5v3.3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9.5Z',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinejoin: 'round'
    }),
    h('path', { d: 'M5.2 10.6h1.6M9.2 10.6h1.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })
  );
}

/* ---------- 样式 ---------- */
const S = {
  root: { height: '100%', overflow: 'auto', padding: '10px 12px', fontSize: 13, lineHeight: 1.5 },
  bar: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  title: { fontWeight: 600, fontSize: 13 },
  count: { opacity: 0.55, fontSize: 12 },
  refresh: {
    marginLeft: 'auto', font: 'inherit', fontSize: 12, padding: '3px 10px',
    borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', cursor: 'pointer'
  },
  card: {
    border: '1px solid rgba(128,128,128,.25)', borderRadius: 8,
    padding: '9px 11px', marginBottom: 8
  },
  cardTitle: { fontWeight: 600, fontSize: 13, marginBottom: 2 },
  meta: { fontSize: 12, opacity: 0.6, marginBottom: 6 },
  row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 3 },
  chip: {
    fontSize: 11, padding: '1px 7px', borderRadius: 999,
    border: '1px solid rgba(128,128,128,.3)'
  },
  ok: { color: '#1a9e55' },
  bad: { color: '#d0453b' },
  none: { opacity: 0.45 },
  hint: { fontSize: 12, opacity: 0.5, marginTop: 12, lineHeight: 1.6 },
  error: { color: '#d0453b', fontSize: 12 }
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

function statusLine(game) {
  const run = game.lastRun;
  const built = game.built || {};
  const wechatOk = run && run.target === 'wechat' ? run.ok : Boolean(built.wechat);
  const webOk = run && run.target === 'web' ? run.ok : Boolean(built.web);

  const mark = (ok, label) =>
    h('span', { style: { ...S.chip, ...(ok ? S.ok : S.none) } }, `${label} ${ok ? '✅' : '—'}`);

  return h(
    'div',
    { style: S.row },
    mark(wechatOk, '微信'),
    mark(webOk, '网页'),
    run && h('span', { style: { marginLeft: 'auto', opacity: 0.5 } }, fmtAgo(run.at))
  );
}

function Card({ game }) {
  const run = game.lastRun;
  const soft = (run && run.softWarnings) || [];
  return h(
    'div',
    { style: S.card },
    h('div', { style: S.cardTitle }, game.title),
    h(
      'div',
      { style: S.meta },
      [game.genre, `目标 ${game.target}`, game.orientation].filter(Boolean).join(' · ')
    ),
    statusLine(game),
    run && run.ok === false && h('div', { style: { ...S.error, marginTop: 4 } }, '上次跑断言失败'),
    soft.length > 0 &&
      h('div', { style: { ...S.row, opacity: 0.6 } }, `⚠ ${soft.length} 条软指标未达标`)
  );
}

/* ---------- 面板 ---------- */
function Panel(props) {
  const sessionId = props.forgeSessionId || props.sessionId || '';
  const runCommand = props.runCommand;
  const [state, setState] = useState({ loading: true, games: [], error: null });

  const load = useCallback(async () => {
    if (!runCommand || !sessionId) {
      setState({ loading: false, games: [], error: '命令通道不可用' });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));
    const res = await runCommand(sessionId, 'scan');
    if (!res.ok) {
      setState({ loading: false, games: [], error: res.text });
      return;
    }
    try {
      const data = JSON.parse(res.text);
      setState({ loading: false, games: data.games || [], error: null });
    } catch (e) {
      setState({ loading: false, games: [], error: '无法解析扫描结果' });
    }
  }, [runCommand, sessionId]);

  useEffect(() => { load(); }, [load]);

  return h(
    'div',
    { style: S.root, 'data-plugin': 'dsh-game-forge' },
    h(
      'div',
      { style: S.bar },
      h(Icon),
      h('span', { style: S.title }, '游戏工坊'),
      h('span', { style: S.count }, state.loading ? '扫描中…' : `${state.games.length} 个游戏`),
      h('button', { style: S.refresh, onClick: load, disabled: state.loading }, '刷新')
    ),
    state.error && h('div', { style: S.error }, state.error),
    !state.loading && state.games.length === 0 && !state.error &&
      h('div', { style: S.hint }, '工作区里还没有游戏。先让 agent 用 Game Studio 做一个。'),
    state.games.map((g) => h(Card, { key: g.project, game: g })),
    h(
      'div',
      { style: S.hint },
      '状态来自每个游戏的 .pipeline/report.json。',
      h('br'),
      '试玩 / 预览 / 上传在对话里让 agent 执行，或直接用 publish.mjs。'
    )
  );
}

/* ---------- 注册 ---------- */
export function apply(ctx) {
  const runCommand = async (sessionId, input) => {
    try {
      const result = await ctx.remote.commands.execute(sessionId, `/game-forge ${input}`, []);
      if (!result.ok) {
        return { ok: false, text: `${result.error && result.error.message ? result.error.message : '命令失败'}` };
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
      description: () => '工作区里每个游戏在微信/网页两个渠道的最新状态',
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
