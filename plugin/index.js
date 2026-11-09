/* 服务端：扫描游戏状态 + 跑流水线任务（异步、可观测）。
 *
 * 命令：/game-forge <scan|run|status|cancel> [json]
 *    scan                     返回 { games: [...] }
 *   run  {"project":"games/x","action":"wechat-preview"}
 *                            启动一个后台任务，立即返回 { jobId }
 *   status                   返回 { jobs: [...] }，面板轮询用
 *   cancel {"jobId":"..."}   终止任务
 *
 * 关键约束：任务串行。多个模拟器窗口同时开会串截图（真实踩过的坑）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const name = '@guihai24/dsh-game-forge';
export const inject = ['workingDirectory'];

/* ---------- 扫描 ---------- */
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'targets', '.pipeline',
  'export', 'assets', '.studio', 'plugin', '.github'
]);

function findGames(root) {
  const found = [];
  (function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    if (entries.some((e) => e.isFile() && e.name === 'game.brief.json')) {
      found.push(dir);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  })(root, 0);
  return found.sort();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function lastRun(gameDir) {
  const file = path.join(gameDir, '.pipeline', 'report.json');
  const report = readJson(file);
  if (!report) return null;
  let at = null;
  try { at = fs.statSync(file).mtime.toISOString(); } catch (e) { /* 忽略 */ }
  return {
    target: report.target || 'wechat',
    ok: report.ok === true,
    at,
    assertions: (report.assertions || []).map((a) => ({ name: a.name, ok: a.ok === true, soft: a.soft === true, detail: a.detail })),
    softWarnings: report.softWarnings || [],
    screenshot: report.screenshot || report.releaseScreenshot || null,
    qrcode: report.qrcode || null
  };
}

function scan(root) {
  return findGames(root).map((dir) => {
    const brief = readJson(path.join(dir, 'game.brief.json')) || {};
    const web = readJson(path.join(dir, 'targets', 'web', 'web-manifest.json'));
    const wechat = readJson(path.join(dir, 'targets', 'wechat', 'g2wx-report.json'));
    return {
      project: path.relative(root, dir) || '.',
      title: brief.title || path.basename(dir),
      genre: brief.genre || '',
      target: brief.target || 'wechat',
      orientation: (brief.channel && brief.channel.orientation) || 'landscape',
      appid: (brief.channel && brief.channel.appid) || '',
      lastRun: lastRun(dir),
      built: {
        wechat: wechat ? { bytes: wechat.packageBytes } : null,
        web: web ? { bytes: web.bytes } : null
      }
    };
  });
}

/* ---------- 任务 ---------- */
const JOBS = new Map();
let running = null;

function cliPath(config) {
  const candidates = [
    config && config.cliPath,
    process.env.GAME_FORGE_CLI,
    path.join(os.homedir(), 'src', 'game-forge', 'scripts', 'publish.mjs')
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 下一个 */ }
  }
  return null;
}

const ACTIONS = {
  'wechat-playtest': () => ['--target', 'wechat'],
  'wechat-preview': () => ['--target', 'wechat', '--preview'],
  web: () => ['--target', 'web'],
  upload: () => ['--target', 'wechat', '--upload']
};

function startJob(root, cli, payload) {
  const action = String(payload.action || '');
  const build = ACTIONS[action];
  if (!build) throw new Error(`未知动作 "${action}"（可选 ${Object.keys(ACTIONS).join(' / ')}）`);
  if (running) throw new Error(`已有任务在跑（${running.id}），模拟器同时开多个窗口会串截图，请等它结束`);

  const project = String(payload.project || '');
  const dir = path.resolve(root, project);
  if (!dir.startsWith(path.resolve(root))) throw new Error('项目路径越界');
  if (!fs.existsSync(path.join(dir, 'game.brief.json'))) throw new Error(`${project} 不是游戏目录`);

  const id = `job_${Date.now().toString(36)}`;
  const job = {
    id, action, project,
    status: 'running',
    phase: 0, total: 0,
    line: '启动…',
    startedAt: new Date().toISOString(),
    endedAt: null,
    code: null,
    log: []
  };
  JOBS.set(id, job);
  running = job;

  const child = spawn(process.execPath, [cli, ...build(), '--game', dir], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const onData = (buf) => {
    for (const raw of String(buf).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      job.line = line;
      job.log.push(line);
      if (job.log.length > 400) job.log.shift();
      const m = /^\[(\d+)\/(\d+)\]/.exec(line);
      if (m) { job.phase = Number(m[1]); job.total = Number(m[2]); }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('close', (code) => {
    job.code = code;
    job.status = code === 0 ? 'passed' : 'failed';
    job.endedAt = new Date().toISOString();
    if (code !== 0) {
      const err = job.log.slice().reverse().find((l) => l.startsWith('✗')) || job.log.slice(-1)[0] || '';
      job.error = err.slice(0, 200);
    }
    running = null;
  });
  child.on('error', (e) => {
    job.status = 'failed';
    job.error = String(e && e.message ? e.message : e);
    job.endedAt = new Date().toISOString();
    running = null;
  });

  job.cancel = () => { try { child.kill('SIGTERM'); } catch (e) { /* 忽略 */ } };
  return job;
}

function publicJob(job) {
  return {
    id: job.id, action: job.action, project: job.project,
    status: job.status, phase: job.phase, total: job.total,
    line: job.line, error: job.error || null,
    startedAt: job.startedAt, endedAt: job.endedAt, code: job.code,
    tail: job.log.slice(-3)
  };
}

/* ---------- 注册 ---------- */
export function apply(ctx, config = {}) {
  const cli = cliPath(config);

  ctx.inject(['commands'], (child) => {
    child.commands.register({
      name: 'game-forge',
      description: 'Game Forge workbench: scan games, run the pipeline in the background, poll progress',
      input: { hint: '<scan|run|status|cancel> [json]' },
      async handler({ agent, rawInput }) {
        try {
          const input = String(rawInput || '').trim();
          const space = input.search(/\s/u);
          const action = space < 0 ? input || 'scan' : input.slice(0, space);
          const payload = space < 0 ? {} : JSON.parse(input.slice(space + 1));
          const root = await ctx.workingDirectory.ensure(agent);

          if (action === 'scan') {
            return { kind: 'success', text: JSON.stringify({ root, cli, games: scan(root) }) };
          }
          if (action === 'run') {
            if (!cli) return { kind: 'error', text: '找不到 publish.mjs：设置 GAME_FORGE_CLI 或在插件 config 里给 cliPath' };
            const job = startJob(root, cli, payload);
            return { kind: 'success', text: JSON.stringify({ jobId: job.id, job: publicJob(job) }) };
          }
          if (action === 'status') {
            const list = [...JOBS.values()].slice(-8).map(publicJob);
            return { kind: 'success', text: JSON.stringify({ jobs: list, running: running ? running.id : null }) };
          }
          if (action === 'cancel') {
            const job = JOBS.get(String(payload.jobId || ''));
            if (!job) return { kind: 'error', text: '没找到这个任务' };
            job.cancel();
            return { kind: 'success', text: JSON.stringify({ cancelled: job.id }) };
          }
          return { kind: 'error', text: `Unknown action "${action}"` };
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
  });
}
