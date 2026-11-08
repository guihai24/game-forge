/* 服务端：扫描工作区里的游戏，读它们在各渠道的最新结果。
 *
 * 面板只渲染，不做事 —— 所有文件访问和判断都在这里。
 * 命令：/game-forge scan   返回 { games: [...] }
 */

import fs from 'node:fs';
import path from 'node:path';

export const name = '@guihai24/dsh-game-forge';
export const inject = ['workingDirectory'];

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
    assertions: (report.assertions || []).map((a) => ({
      name: a.name,
      ok: a.ok === true,
      soft: a.soft === true,
      detail: a.detail
    })),
    softWarnings: report.softWarnings || [],
    screenshot: report.screenshot || report.releaseScreenshot || null,
    qrcode: report.qrcode || null
  };
}

function channelState(gameDir) {
  const run = lastRun(gameDir);
  const web = readJson(path.join(gameDir, 'targets', 'web', 'web-manifest.json'));
  const wechat = readJson(path.join(gameDir, 'targets', 'wechat', 'g2wx-report.json'));
  return {
    lastRun: run,
    built: {
      wechat: wechat ? { bytes: wechat.packageBytes } : null,
      web: web ? { bytes: web.bytes } : null
    }
  };
}

function scan(root) {
  return findGames(root).map((dir) => {
    const brief = readJson(path.join(dir, 'game.brief.json')) || {};
    return {
      project: path.relative(root, dir) || '.',
      title: brief.title || path.basename(dir),
      genre: brief.genre || '',
      target: brief.target || 'wechat',
      orientation: (brief.channel && brief.channel.orientation) || 'landscape',
      appid: (brief.channel && brief.channel.appid) || '',
      acceptance: brief.acceptance || null,
      ...channelState(dir)
    };
  });
}

export function apply(ctx) {
  ctx.inject(['commands'], (child) => {
    child.commands.register({
      name: 'game-forge',
      description: 'Game Forge workbench: scan the workspace for games and their last channel results',
      input: { hint: '<scan>' },
      async handler({ agent, rawInput }) {
        try {
          const action = String(rawInput || '').trim().split(/\s+/u)[0] || 'scan';
          const root = await ctx.workingDirectory.ensure(agent);
          if (action !== 'scan') {
            return { kind: 'error', text: `Unknown action "${action}"` };
          }
          return { kind: 'success', text: JSON.stringify({ root, games: scan(root) }) };
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
        }
      }
    });
  });
}
