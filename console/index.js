/* 服务端：扫工作区、读台账、把待办算出来。
 *
 * 命令：/game-console <scan|state|tasks|set-stage> [json]
 *   scan                        返回 { root, games: [...], tasks: [...] }
 *   state {"project":"games/x"} 返回单款完整 state
 *   set-stage {"project":"...","channel":"wechat","stage":"review","status":"done"}
 *                               改一个阶段的状态并落盘
 *
 * 设计约束（沿用旧插件踩过的坑）：
 *   - 面板只渲染，不做事。扫描、聚合全在这里。
 *   - 任务进度写工作区文件，不靠命令轮询（命令会污染会话）。
 *   - 只读 Game Studio 的产物，不 import 它。
 */

import fs from 'node:fs';
import path from 'node:path';

export const name = '@guihai24/dsh-game-console';
export const inject = ['workingDirectory'];

/* ---------- 文件读取 ---------- */
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'targets', '.pipeline', '.forge',
  'export', 'assets', '.studio', 'console', 'engine', '.github'
]);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** 找所有含 game.brief.json 或 .forge/state.json 的目录 */
function findGames(root) {
  const found = [];
  (function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    const hasBrief = entries.some((e) => e.isFile() && e.name === 'game.brief.json');
    const hasState = entries.some((e) => e.isDirectory() && e.name === '.forge')
      && fs.existsSync(path.join(dir, '.forge', 'state.json'));
    if (hasBrief || hasState) { found.push(dir); return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  })(root, 0);
  return found.sort();
}

/* ---------- 台账 ---------- */
const DEFAULT_STAGES = {
  wechat: [
    { id: 'uploaded', label: '上传开发版' },
    { id: 'filing', label: '小游戏备案' },
    { id: 'review', label: '提交审核' },
    { id: 'published', label: '发布' }
  ],
  taptap: [
    { id: 'created', label: '创建草稿' },
    { id: 'uploaded', label: '上传 H5' },
    { id: 'filing', label: 'H5 备案' },
    { id: 'review', label: '提审' },
    { id: 'published', label: '已上线' }
  ],
  crazygames: [
    { id: 'uploaded', label: '上传' },
    { id: 'trial', label: '测试期' },
    { id: 'monetizing', label: '变现中' }
  ],
  y8: [{ id: 'uploaded', label: '上传' }, { id: 'review', label: '审核' }, { id: 'published', label: '上线' }],
  playgama: [{ id: 'uploaded', label: '上传' }, { id: 'review', label: '审核' }, { id: 'published', label: '上线' }],
  gamedistribution: [{ id: 'uploaded', label: '上传' }, { id: 'review', label: '审核' }, { id: 'published', label: '上线' }],
  '4399': [{ id: 'uploaded', label: '投稿' }, { id: 'review', label: '审核' }, { id: 'published', label: '上线' }]
};

/** 没有 state 时从 brief + .pipeline 推一个最小状态，不落盘 */
function inferState(dir, brief) {
  const report = readJson(path.join(dir, '.pipeline', 'report.json'));
  const web = readJson(path.join(dir, 'targets', 'web', 'web-manifest.json'));
  const wx = readJson(path.join(dir, 'targets', 'wechat', 'g2wx-report.json'));
  return {
    version: 1,
    id: path.basename(dir),
    title: (brief && brief.title) || path.basename(dir),
    inferred: true,
    offline: (brief && brief.offline) === true,
    orientation: (brief && brief.channel && brief.channel.orientation) || 'landscape',
    genre: (brief && brief.genre) || '',
    channels: {},
    tasks: [],
    revenue: {},
    built: {
      wechat: wx ? { bytes: wx.packageBytes } : null,
      web: web ? { bytes: web.bytes } : null,
      lastRun: report ? { ok: report.ok === true, target: report.target } : null
    }
  };
}

function statePath(dir) {
  return path.join(dir, '.forge', 'state.json');
}

function loadState(dir) {
  const saved = readJson(statePath(dir));
  if (saved) return saved;
  const brief = readJson(path.join(dir, 'game.brief.json'));
  return inferState(dir, brief);
}

/** 汇总所有待办：state 里存的 + 从阶段推出来的（阶段 automated=false 且 active） */
function collectTasks(games) {
  const out = [];
  for (const g of games) {
    for (const t of g.state.tasks || []) {
      if (t.status && t.status !== 'open') continue;
      out.push({ ...t, project: g.project, title_game: g.state.title });
    }
    for (const [chan, ch] of Object.entries(g.state.channels || {})) {
      for (const st of ch.stages || []) {
        if (st.status !== 'active' || st.automated !== false) continue;
        // 已经在 tasks 里描述过的，不重复
        if ((g.state.tasks || []).some((t) => t.channel === chan && t.kind && t.status === 'open')) continue;
        out.push({
          id: `${g.project}:${chan}:${st.id}`,
          kind: 'manual-check',
          title: `${g.state.title} · ${ch.ids && Object.keys(ch.ids).length ? '' : ''}${st.label}`,
          detail: st.note || '这一步平台替代不了，需要本人操作',
          channel: chan,
          project: g.project,
          title_game: g.state.title,
          createdAt: ch.updatedAt
        });
      }
    }
  }
  // 有截止时间的排前面，其余按创建时间倒序
  return out.sort((a, b) => {
    if (a.deadline && b.deadline) return String(a.deadline).localeCompare(String(b.deadline));
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

function scanAll(root) {
  const games = findGames(root).map((dir) => {
    const state = loadState(dir);
    return {
      project: path.relative(root, dir) || '.',
      state: {
        id: state.id,
        title: state.title,
        inferred: state.inferred === true,
        offline: state.offline === true,
        orientation: state.orientation || 'landscape',
        genre: state.genre || '',
        channels: state.channels || {},
        tasks: state.tasks || [],
        revenue: state.revenue || {},
        built: state.built || null,
        updatedAt: state.updatedAt || null
      }
    };
  });
  return { games, tasks: collectTasks(games) };
}

/* ---------- 阶段写入 ---------- */
function setStage(root, payload) {
  const project = String(payload.project || '');
  const channel = String(payload.channel || '');
  const stageId = String(payload.stage || '');
  const status = String(payload.status || 'active');
  if (!['pending', 'active', 'done', 'failed', 'skipped', 'blocked'].includes(status)) {
    throw new Error(`未知状态 "${status}"`);
  }
  const dir = path.resolve(root, project);
  if (!dir.startsWith(path.resolve(root))) throw new Error('项目路径越界');

  const state = loadState(dir);
  if (state.inferred) {
    // 第一次写：把推断结果固化成正式台账
    state.inferred = false;
    state.createdAt = new Date().toISOString();
  }
  const template = DEFAULT_STAGES[channel] || [];
  const ch = state.channels[channel] || { stage: stageId, stages: [], updatedAt: null };
  if (!ch.stages || ch.stages.length === 0) {
    ch.stages = template.map((s) => ({ id: s.id, label: s.label, status: 'pending' }));
  }
  const target = ch.stages.find((s) => s.id === stageId);
  if (!target) throw new Error(`${channel} 没有阶段 "${stageId}"（可选 ${ch.stages.map((s) => s.id).join(', ')}）`);
  target.status = status;
  target.at = new Date().toISOString();
  if (payload.note !== undefined) target.note = String(payload.note);
  if (payload.automated !== undefined) target.automated = payload.automated === true;
  ch.stage = stageId;
  ch.updatedAt = target.at;
  if (status === 'failed') ch.lastResult = 'rejected';
  else if (status === 'done') ch.lastResult = 'ok';
  state.channels[channel] = ch;
  state.updatedAt = target.at;

  writeJson(statePath(dir), state);
  return { project, channel, stage: stageId, status };
}

/* ---------- 注册 ---------- */
export function apply(ctx, config = {}) {
  ctx.inject(['commands'], (child) => {
    child.commands.register({
      name: 'game-console',
      description: 'Game console: scan workspace, read ledger, list pending human tasks',
      input: { hint: '<scan|state|set-stage|tasks> [json]' },
      async handler({ agent, rawInput }) {
        try {
          const input = String(rawInput || '').trim();
          const space = input.search(/\s/u);
          const action = space < 0 ? input || 'scan' : input.slice(0, space);
          const payload = space < 0 ? {} : JSON.parse(input.slice(space + 1));
          const root = await ctx.workingDirectory.ensure(agent);

          if (action === 'scan') {
            const { games, tasks } = scanAll(root);
            return { kind: 'success', text: JSON.stringify({ root, games, tasks }) };
          }
          if (action === 'tasks') {
            const { tasks } = scanAll(root);
            return { kind: 'success', text: JSON.stringify({ tasks }) };
          }
          if (action === 'state') {
            const dir = path.resolve(root, String(payload.project || ''));
            if (!dir.startsWith(path.resolve(root))) throw new Error('项目路径越界');
            return { kind: 'success', text: JSON.stringify(loadState(dir)) };
          }
          if (action === 'set-stage') {
            return { kind: 'success', text: JSON.stringify(setStage(root, payload)) };
          }
          return { kind: 'error', text: `Unknown action "${action}"` };
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
  });
}
