/* 服务端：扫工作区、读台账、跑引擎任务。
 *
 * 命令：/game-console <scan|state|tasks|set-stage|run|job> [json]
 *   scan                        返回 { root, games: [...], tasks: [...], job }
 *   state {"project":"games/x"} 返回单款完整 state
 *   set-stage {"project":"...","channel":"wechat","stage":"review","status":"done"}
 *                               改一个阶段的状态并落盘
 *   run {"project":"games/x","target":"wechat|web"}  后台跑引擎，立即返回 jobId
 *   job                         返回当前任务进度（面板轮询这个）
 *
 * 设计约束（沿用旧插件踩过的坑）：
 *   - 面板只渲染，不做事。扫描、聚合、起任务全在这里。
 *   - 进度写工作区文件 .forge/job.json，面板读文件，不用命令轮询（命令会污染会话）。
 *   - 任务串行：多个模拟器窗口同时开会串截图。
 *   - 只读 Game Studio 的产物，不 import 它。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { precheckAll } from '../engine/scripts/precheck-lib.mjs';
import { scoreBrief, verdictSummary, reconcileGates } from '../engine/scripts/viral-dna-lib.mjs';

export const name = '@guihai24/dsh-game-console';
export const inject = ['workingDirectory', 'sessions'];

/* ---------- 文件读取 ---------- */
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'targets', '.pipeline', '.forge',
  'export', 'assets', '.studio', 'console', 'engine', '.github', '_archive'
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

function fillBuilt(dir, chain) {
  if (chain.built) return chain;
  const reportFile = path.join(dir, '.pipeline', 'report.json');
  const report = readJson(reportFile);
  const web = readJson(path.join(dir, 'targets', 'web', 'web-manifest.json'));
  const wx = readJson(path.join(dir, 'targets', 'wechat', 'g2wx-report.json'));
  let at = null;
  try { at = fs.statSync(reportFile).mtime.toISOString(); } catch (e) { /* 没跑过 */ }
  chain.built = {
    wechat: wx ? { bytes: wx.packageBytes } : null,
    web: web ? { bytes: web.bytes } : null,
    lastRun: report ? { ok: report.ok === true, target: report.target, at } : null
  };
  return chain;
}

function statePath(dir) {
  return path.join(dir, '.forge', 'state.json');
}

function loadState(dir) {
  const saved = readJson(statePath(dir));
  if (saved) return fillBuilt(dir, saved);
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
    // 自审阻断排最前：这类问题不改，后面每一步都是白做。
    for (const i of (g.state.audit && g.state.audit.items) || []) {
      if (i.level !== 'BLOCK') continue;
      out.unshift({
        id: `${g.project}:audit:${i.id}`,
        kind: 'audit-block',
        title: `${g.state.title} · 自审未过：${i.msg}`,
        detail: i.hint || '规则见 engine/references/rules/channel-rules.md',
        project: g.project,
        title_game: g.state.title,
        createdAt: new Date().toISOString()
      });
    }

    // 基因层结论：每个游戏一条决策待办，不是每项一条。
    // 砍线是"这个项目还要不要做"的一次判断，拆成 8 条只会淹没真正要做的事。
    const v = g.state.viral;
    if (v && v.verdict === 'suggest-drop') {
      const missing = v.failed.filter((i) => !i.needsHuman).map((i) => i.label);
      out.push({
        id: `${g.project}:viral:drop`,
        kind: 'viral-drop',
        title: `${g.state.title} · 基因 ${v.score}/${v.total}，建议砍掉`,
        // 负向趋势依据优先级最高：它说明的不是"缺基因"，而是"这个品类现在不该做"
        detail: v.negativeTrend
          ? `trend_evidence 的结论是负向：当前没有窗口期。这条比缺基因更硬——依据充分说明不该做。`
          : `未过：${missing.join('、') || '—'}。砍线只算能机器判的项，人工项另需确认。规则见 viral-dna-rules.md`,
        project: g.project,
        title_game: g.state.title,
        createdAt: new Date().toISOString()
      });
    }

    // 写了 trend_evidence 却没标方向：这是"没判断过"，跟"判断了但结论是负向"
    // 是两件事，不能混进 viral-drop 里。单独一条待办，动作很明确——补个字段。
    if (v && v.needsDirection) {
      out.push({
        id: `${g.project}:viral:direction`,
        kind: 'viral-direction',
        title: `${g.state.title} · trend_evidence 没标方向`,
        detail: 'brief 里写了趋势依据但没写 trend_direction（positive / negative）。机器不猜方向，所以 VD-08 判不出该不该砍。补上这个字段即可。规则见 viral-dna-rules.md',
        project: g.project,
        title_game: g.state.title,
        createdAt: new Date().toISOString()
      });
    }

    // Gate 2 实测未达：同样每个游戏一条，列出未达项。
    const p = g.state.probe;
    if (p && p.ok === false && p.items) {
      const bad = p.items.filter((i) => i.ok === false);
      if (bad.length) {
        out.push({
          id: `${g.project}:probe:fail`,
          kind: 'probe-fail',
          title: `${g.state.title} · 产物实测 ${bad.length} 项未达`,
          detail: `${bad.map((i) => `${i.label}：${i.detail}`).join('；')}。针对产物，不看 brief 怎么说`,
          project: g.project,
          title_game: g.state.title,
          createdAt: new Date().toISOString()
        });
      }
    }
  }
  // 自审阻断 > 基因砍线 > 产物实测 > 有截止时间 > 其余
  // 自审阻断 > 基因砍线 > 方向缺失 > 产物实测 > 有截止时间 > 其余
  // 方向缺失排在实测前面：它决定"该不该做"，实测只在已经决定要做之后才有意义。
  const rank = (k) => ({ 'audit-block': 0, 'viral-drop': 1, 'viral-direction': 2, 'probe-fail': 3 }[k] ?? 4);
  return out.sort((a, b) => {
    const pa = rank(a.kind);
    const pb = rank(b.kind);
    if (pa !== pb) return pa - pb;
    if (a.deadline && b.deadline) return String(a.deadline).localeCompare(String(b.deadline));
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

/* ---------- 归档 ---------- *
 *
 * "跑不起来就砍掉"是产品定位的一部分，但砍掉不等于删掉——素材、brief、
 * 踩过的坑都还有价值。所以归档 = 移到 <root>/_archive/ 下，扫描不再看它。
 * 可逆，不产生不可恢复的操作。
 */
const ARCHIVE_DIR = '_archive';

function archiveGame(root, payload) {
  const project = String(payload.project || '');
  if (!project) throw new Error('archive 需要 project');
  const src = path.resolve(root, project);
  const rootAbs = path.resolve(root);
  if (!src.startsWith(rootAbs)) throw new Error('项目路径越界');
  if (!fs.existsSync(path.join(src, 'game.brief.json'))) throw new Error(`${project} 不是游戏目录`);
  if (path.basename(path.dirname(src)) === ARCHIVE_DIR) throw new Error('已经在归档区里');

  const dest = path.join(rootAbs, ARCHIVE_DIR, path.basename(src));
  if (fs.existsSync(dest)) throw new Error(`${ARCHIVE_DIR}/${path.basename(src)} 已存在，先处理冲突`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);

  // 记一笔归档原因，将来回看时知道为什么砍的
  const st = loadState(dest);
  st.archivedAt = new Date().toISOString();
  st.archiveReason = String(payload.reason || '');
  writeJson(statePath(dest), st);

  return { project, archivedTo: path.join(ARCHIVE_DIR, path.basename(src)), reason: st.archiveReason };
}

function restoreGame(root, payload) {
  const project = String(payload.project || '');
  const src = path.resolve(root, ARCHIVE_DIR, project);
  const rootAbs = path.resolve(root);
  if (!src.startsWith(rootAbs)) throw new Error('项目路径越界');
  if (!fs.existsSync(path.join(src, 'game.brief.json'))) throw new Error(`${ARCHIVE_DIR}/${project} 不是游戏目录`);
  const dest = path.join(rootAbs, path.basename(src));
  if (fs.existsSync(dest)) throw new Error(`${path.basename(src)} 已存在，不能恢复`);

  const st = loadState(src);
  delete st.archivedAt;
  delete st.archiveReason;
  writeJson(statePath(src), st);
  fs.renameSync(src, dest);
  return { restored: path.basename(src) };
}

/* ---------- 封面 ---------- *
 *
 * 画廊式看板需要游戏的真实美术，否则就是一堆色块。
 * 从 assets/ASSETS.json 的 hero 槽取主形象；没有就用 background。
 * 只返回相对路径 + 哈希，客户端拼 dsh-resource:// 自己加载。
 */
function coverOf(dir) {
  const assets = readJson(path.join(dir, 'assets', 'ASSETS.json'));
  if (!assets || !assets.assets) return null;
  for (const slot of ['hero', 'pickup', 'enemy', 'background']) {
    const a = assets.assets[slot];
    if (a && a.file) {
      const abs = path.join(dir, a.file);
      if (!fs.existsSync(abs)) continue;
      return { slot, file: a.file, abs, bytes: fs.statSync(abs).size };
    }
  }
  return null;
}

/* ---------- 需求自审 ---------- *
 *
 * 合规（能不能上架）和基因（值不值得上架）两层一起跑，结果同一份形状，
 * create 和 update 共用——两边各写一遍就会慢慢走偏。
 */
async function auditBrief(brief) {
  let audit = null;
  let viral = null;
  try {
    const { makeReport, checkBrief } = await import('../engine/scripts/precheck-lib.mjs');
    const { scoreBrief } = await import('../engine/scripts/viral-dna-lib.mjs');
    const report = makeReport();
    checkBrief(brief, brief.target === 'wechat' ? 'wechat' : 'taptap', report);
    audit = {
      ok: !report.blocked.length,
      blocked: report.blocked.length,
      warned: report.warned.length,
      items: report.items
    };
    const g1 = scoreBrief(brief, { offline: brief.offline, iap: brief.iap });
    viral = {
      score: g1.score,
      total: g1.total,
      verdict: g1.verdict,
      negativeTrend: Boolean(g1.negativeTrend),
      needsDirection: Boolean(g1.needsDirection),
      note: g1.note,
      failed: g1.failed.map((i) => ({
        id: i.id, label: i.label, detail: i.detail,
        needsHuman: Boolean(i.needsHuman), unmeasured: Boolean(i.unmeasured)
      }))
    };
  } catch (e) {
    // 自审跑挂了不该让写 brief 失败——brief 已经落盘了
    viral = { error: String(e && e.message ? e.message : e) };
  }
  return { audit, viral };
}

/* ---------- 新建游戏 ---------- *
 *
 * 只做到"落 brief + 跑 Gate 1"。游戏本身由 Game Studio 生成，那一步不在这里做——
 * 假装能一键生成，只会让人以为平台能替掉生成器。
 *
 * 但新建这一刻是 Gate 1 最有价值的时刻：在写代码之前就知道值不值得做。
 * 所以 create 一定会顺手把 viral-dna 分数算出来。
 */
async function createGame(root, payload) {
  const title = String(payload.title || '').trim();
  const slug = String(payload.slug || '').trim() || slugify(title);
  if (!title) throw new Error('游戏名不能为空');
  if (!slug) throw new Error('目录名不能为空（会用游戏名自动生成，也可以自己填）');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`目录名只能用小写字母、数字和连字符，当前是 "${slug}"`);

  const rootAbs = path.resolve(root);
  const dir = path.join(rootAbs, 'games', slug);
  if (!dir.startsWith(rootAbs)) throw new Error('路径越界');
  if (fs.existsSync(path.join(dir, 'game.brief.json'))) {
    throw new Error(`games/${slug}/game.brief.json 已存在，换个目录名`);
  }

  const brief = {
    version: 1,
    title,
    genre: String(payload.genre || '').trim(),
    target: ['wechat', 'web'].includes(payload.target) ? payload.target : 'wechat',
    offline: payload.offline !== false,
    iap: payload.iap === true,
    share: payload.share ? { kind: String(payload.share) } : null,
    pace: String(payload.pace || '').trim(),
    emotion_theme: String(payload.emotion_theme || '').trim(),
    trend_evidence: String(payload.trend_evidence || '').trim(),
    trend_direction: ['positive', 'negative'].includes(payload.trend_direction) ? payload.trend_direction : '',
    rules: {
      duration: Number(payload.duration) || 60,
      hearts: Number(payload.hearts) || 3
    },
    acceptance: {
      mustReachPhase: ['playing'],
      minFps: 45,
      mustScore: 0
    },
    channel: {
      appid: String(payload.appid || '').trim(),
      orientation: payload.orientation === 'portrait' ? 'portrait' : 'landscape'
    },
    notes: String(payload.notes || '').trim()
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.brief.json'), `${JSON.stringify(brief, null, 2)}\n`, 'utf8');

  const { audit, viral } = await auditBrief(brief);
  return { project: `games/${slug}`, dir, brief, audit, viral };
}

/* ---------- 改已有游戏的 brief ---------- *
 *
 * 只覆盖面板能编辑的那几个字段，其余（acceptance、channel.appid、rules 里
 * 没暴露的键）原样保留——一次编辑不该顺手把别人手写的字段冲掉。
 *
 * 改完必须重跑两层自审：分数是 brief 的函数，改完不重算，
 * 看板上就会挂着旧结论，那比不显示更糟。
 */
async function updateBrief(root, payload) {
  const project = String(payload.project || '');
  if (!project) throw new Error('update 需要 project');
  const rootAbs = path.resolve(root);
  const dir = path.resolve(root, project);
  if (!dir.startsWith(rootAbs)) throw new Error('项目路径越界');
  const file = path.join(dir, 'game.brief.json');
  if (!fs.existsSync(file)) throw new Error(`${project} 里没有 game.brief.json`);

  const prev = readJson(file) || {};
  const next = {
    ...prev,
    version: prev.version || 1,
    title: String(payload.title !== undefined ? payload.title : prev.title || '').trim(),
    genre: String(payload.genre !== undefined ? payload.genre : prev.genre || '').trim(),
    notes: String(payload.notes !== undefined ? payload.notes : prev.notes || '').trim(),
    offline: payload.offline !== undefined ? payload.offline !== false : prev.offline !== false,
    iap: payload.iap !== undefined ? payload.iap === true : prev.iap === true,
    share: payload.share !== undefined
      ? (String(payload.share).trim() ? { kind: String(payload.share).trim() } : null)
      : (prev.share || null),
    pace: String(payload.pace !== undefined ? payload.pace : prev.pace || '').trim(),
    emotion_theme: String(payload.emotion_theme !== undefined ? payload.emotion_theme : prev.emotion_theme || '').trim(),
    trend_evidence: String(payload.trend_evidence !== undefined ? payload.trend_evidence : prev.trend_evidence || '').trim(),
    trend_direction: payload.trend_direction !== undefined
      ? (['positive', 'negative'].includes(payload.trend_direction) ? payload.trend_direction : '')
      : (prev.trend_direction || ''),
    rules: {
      ...(prev.rules || {}),
      duration: Number(payload.duration !== undefined ? payload.duration : (prev.rules && prev.rules.duration)) || 60,
      hearts: Number(payload.hearts !== undefined ? payload.hearts : (prev.rules && prev.rules.hearts)) || 3
    },
    channel: {
      ...(prev.channel || {}),
      orientation: payload.orientation !== undefined
        ? (payload.orientation === 'portrait' ? 'portrait' : 'landscape')
        : ((prev.channel && prev.channel.orientation) || 'landscape')
    }
  };
  if (!next.title) throw new Error('游戏名不能为空');

  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  // 台账里缓存了 title/genre/offline，不同步的话看板会一直显示旧名字。
  // 只补这几个能从 brief 推出来的字段，别的不碰。
  const chain = readJson(statePath(dir));
  if (chain) {
    chain.title = next.title;
    chain.genre = next.genre;
    chain.offline = next.offline;
    chain.orientation = next.channel.orientation;
    writeJson(statePath(dir), chain);
  }

  const { audit, viral } = await auditBrief(next);
  return { project, dir, brief: next, audit, viral };
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function scanAll(root) {
  const dirs = findGames(root);
  // 自审要跨游戏比对同质化，所以整批一起算，不是逐款算。
  let audits = {};
  try { audits = precheckAll(dirs, 'taptap'); } catch (e) { audits = {}; }

  const games = dirs.map((dir) => {
    const state = loadState(dir);
    // TapTap 产物：targets/taptap/<slug>.zip。有就说明打好了包。
    const taptapDir = path.join(dir, 'targets', 'taptap');
    let taptapZip = null;
    try {
      const zips = fs.readdirSync(taptapDir).filter((f) => f.endsWith('.zip'));
      if (zips.length) {
        const f = path.join(taptapDir, zips[0]);
        taptapZip = { file: zips[0], bytes: fs.statSync(f).size, at: fs.statSync(f).mtime.toISOString() };
      }
    } catch (e) { /* 没打过 */ }
    const audit = audits[dir] || null;

    // 基因打分：Gate 1 是纯静态（读 brief + 台账已知事实），每次扫描都算，代价可忽略。
    // Gate 2 要起浏览器实测，不能放进 2 秒一次的扫描——结果由 probe 动作写进
    // <游戏目录>/.forge/viral.json，这里只读缓存。
    let gate1 = null;
    try {
      gate1 = scoreBrief(readJson(path.join(dir, 'game.brief.json')) || {}, {
        offline: state.offline === true,
        iap: state.iap === true
      });
      // 有实测缓存时，用实测结论修正静态判定（实测优先）。
      const cached = readJson(path.join(dir, '.forge', 'viral.json'));
      if (cached && cached.items) gate1 = reconcileGates(gate1, cached.items);
    } catch (e) { gate1 = null; }
    const probe = readJson(path.join(dir, '.forge', 'viral.json'));

    // 实测过期判定：构建产物比实测结果新，说明代码改过而没重测。
    // 实测基于旧产物，结论不可信——必须显式标出来，不能装作还是对的。
    let stale = false;
    if (probe && probe.at) {
      const builtAt = (state.built && state.built.at) || null;
      if (builtAt && String(builtAt) > String(probe.at)) stale = true;
    }

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
        taptapZip,
        // 封面：画廊式界面靠它让用户一眼认出是哪款游戏。
        // 直接给可用的 URL——客户端拼 dsh-resource:// 在浏览器里加载不了，
        // 宿主的 /api/file 路由接受绝对路径且自带鉴权，是唯一可靠的读法。
        cover: (() => {
          const c = coverOf(dir);
          if (!c) return null;
          return {
            slot: c.slot,
            file: c.file,
            bytes: c.bytes,
            url: `/api/file?path=${encodeURIComponent(c.abs)}`
          };
        })(),
        audit,
        // brief 里能被面板编辑的字段。整份 brief 不传——acceptance、channel.appid
        // 这些编辑器不碰，传过去只会诱导界面去改。
        brief: (() => {
          const b = readJson(path.join(dir, 'game.brief.json')) || {};
          return {
            title: b.title || '',
            genre: b.genre || '',
            notes: b.notes || '',
            offline: b.offline !== false,
            iap: b.iap === true,
            share: b.share && b.share.kind ? String(b.share.kind) : '',
            pace: b.pace || '',
            emotion_theme: b.emotion_theme || '',
            trend_evidence: b.trend_evidence || '',
            trend_direction: b.trend_direction || '',
            duration: (b.rules && b.rules.duration) || 60,
            hearts: (b.rules && b.rules.hearts) || 3,
            orientation: (b.channel && b.channel.orientation) || 'landscape'
          };
        })(),
        viral: gate1 ? {
          score: gate1.score,
          total: gate1.total,
          verdict: gate1.verdict,
          note: gate1.note,
          // 有实测修正时，分数和"从 brief 静态推测"不是一回事，界面要说清楚
          reconciled: Boolean(gate1.reconciled),
          negativeTrend: Boolean(gate1.negativeTrend),
          // 写了 trend_evidence 但没标 trend_direction：机器不猜方向，
          // 这条要显式暴露给界面，否则看板上"干干净净"，实际却没判断过方向。
          needsDirection: Boolean(gate1.needsDirection),
          overridden: (gate1.overridden || []).map((i) => ({ id: i.id, label: i.label, by: i.overriddenBy, detail: i.detail })),
          failed: gate1.failed.map((i) => ({
            id: i.id,
            label: i.label,
            detail: i.detail,
            needsHuman: Boolean(i.needsHuman),
            unmeasured: Boolean(i.unmeasured)
          })),
          summary: verdictSummary(gate1, probe && probe.items)
        } : null,
        probe: probe ? {
          at: probe.at || null,
          ok: probe.ok,
          summary: probe.summary,
          failed: probe.failed,
          unmeasured: probe.unmeasured || 0,
          stale
        } : null,
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

/* ---------- 引擎任务 ---------- */
// 一次只跑一个：多个模拟器窗口同时开会串截图（实测踩过的坑）。
let running = null;

function engineCli() {
  const candidates = [
    process.env.GAME_FORGE_CLI,
    path.join(os.homedir(), 'src', 'game-forge', 'engine', 'bin', 'game-forge.mjs')
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 下一个 */ }
  }
  return null;
}

function jobFile(root) {
  return path.join(root, '.game-console', 'job.json');
}

function jobState(root) {
  return readJson(jobFile(root)) || { running: null, last: null };
}

function writeJob(root, value) {
  writeJson(jobFile(root), value);
}

function startRun(root, payload) {
  if (running) {
    throw new Error(`已有任务在跑（${running.id}）：${running.project}。模拟器串行，等它结束。`);
  }
  const cli = engineCli();
  if (!cli) throw new Error('找不到引擎：设置 GAME_FORGE_CLI，或把仓库放在 ~/src/game-forge');

  const project = String(payload.project || '');
  const target = String(payload.target || 'wechat');
  const action = String(payload.action || 'build');
  if (!['wechat', 'web'].includes(target)) throw new Error(`未知目标 "${target}"`);
  if (!['build', 'package-taptap', 'upload-taptap', 'probe'].includes(action)) throw new Error(`未知动作 "${action}"`);
  const dir = path.resolve(root, project);
  if (!dir.startsWith(path.resolve(root))) throw new Error('项目路径越界');
  if (!fs.existsSync(path.join(dir, 'game.brief.json'))) throw new Error(`${project} 不是游戏目录`);

  // taptap 上传需要开发者 ID：优先 brief 里的 channel.taptap，其次 state 的 ids
  const brief = readJson(path.join(dir, 'game.brief.json')) || {};
  const st = loadState(dir);
  const tt = (st.channels && st.channels.taptap) || {};
  const devId = (brief.channel && brief.channel.taptapDevId) || (tt.ids && tt.ids.devId) || '';
  const appId = (brief.channel && brief.channel.taptapAppId) || (tt.ids && tt.ids.appId) || '';
  if (action === 'upload-taptap' && (!devId || !appId)) {
    throw new Error('TapTap 上传需要 dev-id 和 app-id：写进 game.brief.json 的 channel.taptapDevId / taptapAppId，或 .forge/state.json 的 channels.taptap.ids');
  }

  // 自审拦截：打包/上传前先看这款能不能过审。有 BLOCK 就别浪费一次提交。
  if (action === 'package-taptap' || action === 'upload-taptap') {
    const audit = precheckAll(findGames(root), 'taptap')[dir];
    const blocks = (audit && audit.items || []).filter((i) => i.level === 'BLOCK');
    if (blocks.length) {
      throw new Error(`自审未通过，不能打包：${blocks.map((b) => b.msg).join('；')}。规则见 engine/references/rules/channel-rules.md`);
    }
  }

  const id = `job_${Date.now().toString(36)}`;
  const before = jobState(root);
  const job = {
    id, project, target, action, status: 'running',
    phase: 0, total: 0, line: '启动…',
    startedAt: new Date().toISOString(), endedAt: null, code: null,
    log: []
  };
  running = job;
  writeJob(root, { running: job, last: before.last });

  const ENGINE_DIR = path.dirname(path.dirname(cli));
  let args;
  if (action === 'package-taptap') {
    args = [path.join(ENGINE_DIR, 'scripts', 'targets', 'taptap', 'taptap.mjs'), 'build', '--game', dir];
  } else if (action === 'probe') {
    // Gate 2：走 precheck --game 而不是直接调 viral-probe，
    // 这样 VD-09 的去重结果能和合规层合并，面板拿到的是一份完整的两层结论。
    args = [path.join(ENGINE_DIR, 'scripts', 'precheck.mjs'), '--game', dir, '--json'];
  } else if (action === 'upload-taptap') {
    args = [path.join(ENGINE_DIR, 'scripts', 'targets', 'taptap', 'taptap.mjs'), 'upload',
      '--game', dir, '--dev-id', String(devId), '--app-id', String(appId), '--yes'];
  } else {
    args = [cli, 'build', '--target', target, '--game', dir];
  }
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let dirty = false;
  let stdoutBuf = '';
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    writeJob(root, { running: job, last: before.last });
  };
  let timer = setInterval(flush, 400);

  const onData = (buf) => {
    stdoutBuf += String(buf);
    for (const raw of String(buf).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      // probe 的输出是 JSON，逐行读进 job.line 会让面板最终停在 "}" 上
      // （实测出现过：任务卡片里只剩一个花括号）。进展改用固定文案。
      if (action === 'probe') {
        if (/^\s*[{}\[\]",]+\s*$/.test(line)) continue;   // 跳过纯结构行
        job.line = '正在实测产物…';
        dirty = true;
        continue;
      }
      job.line = line;
      job.log.push(line);
      if (job.log.length > 300) job.log.shift();
      const m = /^\[(\d+)\/(\d+)\]/.exec(line);
      if (m) { job.phase = Number(m[1]); job.total = Number(m[2]); }
      dirty = true;
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const finish = (code, extraError) => {
    clearInterval(timer);
    // probe 的退出码 2 是"有未达标项"，不是失败——结果照存，让看板显示。
    if (action === 'probe') {
      try {
        const start = stdoutBuf.indexOf('{');
        const parsed = JSON.parse(stdoutBuf.slice(start));
        // precheck --game --json 的结构是 { compliance, viralDna, probe }
        const g2 = parsed.probe || null;
        writeJson(path.join(dir, '.forge', 'viral.json'), {
          ...(g2 || { items: [], ok: true, failed: 0 }),
          at: new Date().toISOString()
        });
        job.probeOk = g2 ? g2.ok : true;
        job.probeSummary = g2 ? g2.summary : '';
        // 结果已经解析出来了，把这行"正在实测产物…"换成结论
        job.line = g2 && g2.summary ? g2.summary : '实测完成';
        if (code === 2) code = 0;
      } catch (e) { /* JSON 没解析出来就照原样判失败 */ }
    }
    job.code = code;
    job.status = code === 0 ? 'passed' : (code === null ? 'error' : 'failed');
    job.endedAt = new Date().toISOString();
    const err = extraError || job.log.slice().reverse().find((l) => l.startsWith('✗'));
    if (code !== 0 && err) job.error = err.slice(0, 240);
    running = null;
    writeJob(root, { running: null, last: job });
  };
  child.on('close', (code) => finish(code));
  child.on('error', (e) => finish(null, String(e && e.message ? e.message : e)));

  job.cancel = () => { try { child.kill('SIGTERM'); } catch (e) { /* 忽略 */ } };
  return job;
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id, project: job.project, target: job.target, action: job.action || 'build',
    status: job.status, phase: job.phase, total: job.total,
    line: job.line, error: job.error || null,
    startedAt: job.startedAt, endedAt: job.endedAt, code: job.code,
    tail: (job.log || []).slice(-3)
  };
}

/* ---------- 注册 ---------- */
export function apply(ctx, config = {}) {
  /* 面板走工作区文件，不走命令通道。
   *
   * 原因（2026-11-13 实测）：ctx.remote.commands.execute 会往会话写记录；
   * 桌面应用已经持有写句柄时会报
   *   session "..." is already owned by an active write handle
   * 界面就整个空掉。而面板只需读台账、写一份快照，用文件最稳：
   *   - 服务端把扫描结果写到 <root>/.game-console/state.json
   *   - 面板用 remote.workspaceFiles.readBytes 读它（只读、不激活 agent、不写会话）
   *
   * 命令仍然保留，供 agent 在对话里用（scan/run/set-stage 等）。
   */
  let cachedRoot = null;

  /* 快照格式版本。读端只采信 schema 最高的那份。
   *
   * 桌面应用和 web 实例共用全局快照目录。旧进程写的是旧格式，靠这个字段
   * 判断该采信谁。**每次给快照加字段都要 +1**，否则旧进程写的数据会盖掉
   * 新字段（实测发生过：desktop 是旧代码，它写的 cover:null 覆盖了
   * web 写好的 cover.url，卡片退回首字占位）。
   *
   * v2: audit / viral / probe
   * v3: cover
   * v4: brief（面板内改需求要用）
   */
  const SCHEMA = 4;

  /* 多实例共存：桌面应用和 `dsh --profile web` 会同时跑，共用同一个工作区。
   * 早期两份进程都往 <root>/.game-console/state.json 和 ~/.dsh/game-console/state.json
   * 写快照，后写的覆盖先写的——实测表现为面板数据在两份进程之间来回跳变，
   * 而且旧版本的进程会把新版本才有的字段（audit / viral）直接抹掉。
   *
   * 做法：每个进程用稳定的实例 ID 写自己的文件，另写一份带时间戳的指针。
   * 面板按实例读自己的，互不覆盖。旧格式的 state.json 继续写，兼容老客户端。
   */
  function instanceId() {
    // 同一进程内稳定即可，关键是要**把两个进程区分开**。
    //
    // 曾经只读 process.env.DSH_PROFILE。实测 `dsh --profile web` 并不会把
    // profile 名写进这个环境变量——web 实例读到空值，退回 'desktop'，
    // 于是桌面应用和 web 实例一直往同一个 state.desktop.json 里写，
    // 互相覆盖。表现是面板时而显示新字段、时而显示旧结论（桌面进程跑的是
    // 旧代码，它写 schema:3 的数据盖住了 web 写的 schema:4）。
    //
    // 现在按优先级取：显式环境变量 → 启动参数里的 --profile → 端口 → desktop。
    const profile = process.env.DSH_PROFILE
      || (() => {
        const i = process.argv.findIndex((a) => a === '--profile' || a.startsWith('--profile='));
        if (i < 0) return '';
        const a = process.argv[i];
        if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
        return process.argv[i + 1] || '';
      })()
      || '';
    const base = profile || 'desktop';
    // 端口也带上：同 profile 起两个实例（比如两个 web 探针）时不至于撞车。
    const port = process.env.PORT || '';
    return port ? `${base}-${port}` : base;
  }

  /** 把当前扫描结果落到工作区，供面板读取。 */
  function publishSnapshot(root) {
    try {
      const { games, tasks } = scanAll(root);
      const job = jobState(root);
      const id = instanceId();
      // 同时写一份到全局位置：面板从侧栏打开时没有会话，
      // 读不到会话相对路径下的文件；全局快照与会话无关。
      const payload = {
        root,
        instance: id,
        schema: SCHEMA,
        at: new Date().toISOString(),
        snapshotPath: path.join(os.homedir(), '.dsh', 'game-console', 'state.json'),
        games,
        tasks,
        job: publicJob(job.running || job.last),
        jobRunning: Boolean(job.running)
      };
      // 每实例一份，避免两个进程互相覆盖。
      try {
        writeJson(path.join(root, '.game-console', `state.${id}.json`), payload);
        writeJson(path.join(root, '.game-console', 'instances.json'), {
          ...readJson(path.join(root, '.game-console', 'instances.json')),
          [id]: { at: payload.at, file: `state.${id}.json`, schema: SCHEMA }
        });
      } catch (e) { /* 工作区不可写时只写全局 */ }
      const globalDir = path.join(os.homedir(), '.dsh', 'game-console');
      try {
        writeJson(path.join(globalDir, `state.${id}.json`), payload);
        writeJson(path.join(globalDir, 'instances.json'), {
          ...readJson(path.join(globalDir, 'instances.json')),
          [id]: { at: payload.at, file: `state.${id}.json`, schema: SCHEMA }
        });
      } catch (e) { /* 忽略 */ }
      // 兼容路径：只有 schema 最高的实例写这份，避免旧实例把它抹成旧格式。
      try {
        const prev = readJson(path.join(globalDir, 'state.json'));
        if (!prev || (prev.schema || 0) <= SCHEMA) {
          writeJson(path.join(globalDir, 'state.json'), payload);
        }
      } catch (e) { /* 忽略 */ }
      cachedRoot = root;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 尽力找到工作区根：会话 → 缓存 → 默认工作区。 */
  async function resolveRoot(agent) {
    if (agent) {
      try {
        const root = await ctx.workingDirectory.ensure(agent);
        if (root) { cachedRoot = root; return root; }
      } catch (e) { /* 试下一个 */ }
    }
    if (cachedRoot) return cachedRoot;
    for (const session of liveSessions()) {
      try {
        const root = await ctx.workingDirectory.ensure(session);
        if (root) { cachedRoot = root; return root; }
      } catch (e) { /* 下一个 */ }
    }
    // 没有会话时退到默认工作区：面板从侧栏打开时可能一个会话都没开过。
    const fallback = config && config.workspaceRoot
      ? config.workspaceRoot
      : path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace');
    if (fs.existsSync(fallback)) { cachedRoot = fallback; return fallback; }
    return null;
  }

  /** 已注册的会话句柄（新→旧）。不同版本的 Session 服务形态不一样，逐层试。 */
  function liveSessions() {
    const out = [];
    try {
      const svc = ctx.sessions;
      const list = svc && svc.list;
      const snap = list && list.getSnapshot ? list.getSnapshot() : null;
      const byId = snap && snap.byId ? snap.byId : null;
      if (byId) {
        for (const row of Object.values(byId)) {
          if (row && row.handle) out.push(row.handle);
          else if (row && row.id && svc.scope) {
            try { const h = svc.scope(row.id); if (h) out.push(h); } catch (e) { /* 忽略 */ }
          }
        }
      }
    } catch (e) { /* 忽略 */ }
    return out;
  }

  // 每 2 秒刷一次快照：面板只需读文件，不产生任何会话写入。
  ctx.effect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      const root = await resolveRoot(null);
      if (root) publishSnapshot(root);
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, 'game-console: snapshot loop');

  // 面板动作走一条独立的 HTTP 路由，不经过命令通道。
  //
  // 为什么：commands.execute 必须落在一个"归当前实例所有"的会话上。
  // 桌面应用和 web 实例共享 ~/.dsh，侧栏里能看见对方的会话；
  // 一旦面板绑到的会话被另一侧持有写句柄，任何写操作都会报
  //   session "..." is already owned by an active write handle
  // 新建、归档、起构建这些根本不需要会话——它们只读工作区、写工作区文件。
  // 走 connection.fetch 注册的这条路同样在宿主的鉴权栅栏内。
  ctx.inject(['connection'], (child) => {
    const respond = (status, body) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });

    child.effect(() => child.connection.fetch.register({
      path: '/api/game-console',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null;
        try { body = await request.json(); } catch (e) { return respond(400, { ok: false, error: '请求体不是合法 JSON' }); }
        const action = String((body && body.action) || '');
        const payload = (body && body.payload) || {};
        try {
          const root = await resolveRoot(null);
          if (!root) return respond(500, { ok: false, error: '找不到工作区' });
          let out;
          if (action === 'create') out = await createGame(root, payload);
          else if (action === 'update') out = await updateBrief(root, payload);
          else if (action === 'archive') out = archiveGame(root, payload);
          else if (action === 'restore') out = restoreGame(root, payload);
          else if (action === 'set-stage') out = setStage(root, payload);
          else if (action === 'run') out = startRun(root, payload);
          else if (action === 'scan') out = scanAll(root);
          else if (action === 'cancel') {
            if (!running) return respond(400, { ok: false, error: '没有在跑的任务' });
            out = { cancelled: running.id };
            running.cancel();
          } else return respond(400, { ok: false, error: `未知动作 "${action}"` });
          publishSnapshot(root);
          return respond(200, { ok: true, result: out });
        } catch (error) {
          // 业务错误（目录重名、路径越界、参数不全）回 200 + ok:false，
          // 前端只读 ok 字段，不必区分 HTTP 码。
          return respond(200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }), 'game-console: action route');
  });

  ctx.inject(['commands'], (child) => {
    child.commands.register({
      name: 'game-console',
      description: 'Game console: scan workspace, read ledger, list pending human tasks, run the build pipeline',
      input: { hint: '<scan|state|set-stage|tasks|run|job> [json]' },
      async handler({ agent, rawInput }) {
        try {
          const input = String(rawInput || '').trim();
          const space = input.search(/\s/u);
          const action = space < 0 ? input || 'scan' : input.slice(0, space);
          const payload = space < 0 ? {} : JSON.parse(input.slice(space + 1));
          const root = await ctx.workingDirectory.ensure(agent);

          if (action === 'scan') {
            const { games, tasks } = scanAll(root);
            const job = jobState(root);
            publishSnapshot(root);
            return { kind: 'success', text: JSON.stringify({ root, games, tasks, job: publicJob(job.running || job.last), jobRunning: Boolean(job.running) }) };
          }
          if (action === 'job') {
            const job = jobState(root);
            publishSnapshot(root);
            return { kind: 'success', text: JSON.stringify({ job: publicJob(job.running || job.last), running: Boolean(job.running) }) };
          }
          if (action === 'run') {
            const job = startRun(root, payload);
            publishSnapshot(root);
            return { kind: 'success', text: JSON.stringify({ jobId: job.id, job: publicJob(job) }) };
          }
          if (action === 'cancel') {
            if (!running) return { kind: 'error', text: '没有在跑的任务' };
            running.cancel();
            return { kind: 'success', text: JSON.stringify({ cancelled: running.id }) };
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
            const out = setStage(root, payload);
            publishSnapshot(root);
            return { kind: 'success', text: JSON.stringify(out) };
          }
          if (action === 'create') {
            const out = await createGame(root, payload);
            publishSnapshot(root);
            return { kind: 'success', text: JSON.stringify(out) };
          }
          if (action === 'update') {
            const out = await updateBrief(root, payload);
            publishSnapshot(root);
            return { kind: 'success', text: JSON.stringify(out) };
          }
          if (action === 'archive') {
            const out = archiveGame(root, payload);
            publishSnapshot(root);
            return { kind: 'success', text: JSON.stringify(out) };
          }
          if (action === 'restore') {
            const out = restoreGame(root, payload);
            publishSnapshot(root);
            return { kind: 'success', text: JSON.stringify(out) };
          }
          return { kind: 'error', text: `Unknown action "${action}"` };
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
  });
}
