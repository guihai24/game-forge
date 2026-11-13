#!/usr/bin/env node
/* build-h5-zip.mjs —— 把自包含 HTML 打成 TapTap H5 包。
 *
 * TapTap H5 包的硬要求（对着官方「包体解析错误」排障页核实，2026-11-12）：
 *   - 只能是一级目录，且只含英文/数字
 *   - index.html 必须在该目录下，不能直接放 zip 根
 *   - 不能有第二层嵌套目录
 *   - 不能带 __MACOSX（Mac 打包常见）
 *   - 同时有 game.json 和 index.html 会被判成小游戏包
 *
 * 用法：
 *   node build-h5-zip.mjs --game <游戏目录> [--name <slug>] [--out <输出目录>]
 *
 * 输出：<游戏目录>/targets/taptap/<slug>.zip
 * 退出码：0 成功 ｜ 1 参数/输入错误 ｜ 2 打包失败
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--game') o.game = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return o;
}

const USAGE = '用法: node build-h5-zip.mjs --game <游戏目录> [--name <slug>] [--out <输出目录>]';

/** slug 只能用英文/数字/连字符：TapTap 要求一级目录只含英文和数字。 */
function toSlug(input) {
  const s = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'game';
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (!args.game) { console.error(`✗ 缺少 --game\n${USAGE}`); return 1; }

  const gameDir = path.resolve(args.game);
  if (!fs.existsSync(gameDir)) { console.error(`✗ 游戏目录不存在: ${gameDir}`); return 1; }

  // 入口：优先 targets/web/index.html（engine 的网页产物），其次 dist/index.html
  const candidates = [
    path.join(gameDir, 'targets', 'web', 'index.html'),
    path.join(gameDir, 'dist', 'index.html')
  ];
  const entry = candidates.find((p) => fs.existsSync(p));
  if (!entry) {
    console.error('✗ 找不到 index.html。先跑：game-forge build --target web --game <目录>');
    return 1;
  }

  const brief = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(gameDir, 'game.brief.json'), 'utf8')); } catch (e) { return {}; }
  })();
  const slug = toSlug(args.name || brief.id || path.basename(gameDir));

  const outDir = path.resolve(args.out || path.join(gameDir, 'targets', 'taptap'));
  fs.mkdirSync(outDir, { recursive: true });

  // 暂存目录：<tmp>/<slug>/index.html —— 满足「一级目录 + index.html」
  const stage = fs.mkdtempSync(path.join(outDir, '.stage-'));
  const inner = path.join(stage, slug);
  fs.mkdirSync(inner, { recursive: true });
  fs.copyFileSync(entry, path.join(inner, 'index.html'));

  // 自包含体检：外链会让 TapTap 侧白屏
  const html = fs.readFileSync(entry, 'utf8');
  const external = [];
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    external.push(m[1]);
  }
  if (/<script[^>]+src\s*=\s*["'](?!data:)/i.test(html)) external.push('外部 script');
  if (external.length) {
    console.error(`✗ index.html 不是自包含的，发现 ${external.length} 个外链：`);
    for (const e of external.slice(0, 5)) console.error(`  · ${e}`);
    fs.rmSync(stage, { recursive: true, force: true });
    return 2;
  }

  // 有 game.json 就会被判成小游戏包，必须排除
  if (fs.existsSync(path.join(gameDir, 'game.json'))) {
    console.log('[zip] 注意：游戏目录有 game.json，但只打 index.html，不会带进 zip');
  }

  const zipPath = path.join(outDir, `${slug}.zip`);
  fs.rmSync(zipPath, { force: true });

  // 用 zip -r，从 stage 目录进：确保 zip 内是 <slug>/index.html
  // -X 去掉额外属性，避免 __MACOSX
  try {
    execFileSync('zip', ['-r', '-X', '-q', zipPath, slug], { cwd: stage, stdio: 'pipe' });
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    console.error(`✗ 打包失败: ${e && e.message ? e.message : e}`);
    return 2;
  }
  fs.rmSync(stage, { recursive: true, force: true });

  // 自检：解开看结构对不对
  const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  const entries = listing
    .split('\n')
    .filter((l) => /^\s*\d+\s+\d{2}-\d{2}-\d{4}/.test(l))
    .map((l) => l.trim().split(/\s+/).slice(3).join(' '))
    .filter(Boolean);

  const files = entries.filter((n) => !n.endsWith('/'));
  const bad = files.filter((name) => {
    const parts = name.split('/').filter(Boolean);
    if (parts[0] !== slug) return true;          // 根必须是唯一一级目录
    if (parts.length > 2) return true;            // 不能有第二层
    if (parts.includes('__MACOSX')) return true;
    if (parts[parts.length - 1] === 'game.json') return true;
    return false;
  });
  // 唯一一级目录检查：所有条目必须属于同一个顶层目录
  const roots = new Set(entries.map((n) => n.split('/')[0]));
  if (roots.size !== 1 || !roots.has(slug)) {
    console.error(`✗ zip 的顶层必须是唯一的 ${slug}/，实际：${[...roots].join(', ')}`);
    return 2;
  }
  if (!files.includes(`${slug}/index.html`)) {
    console.error(`✗ zip 里没有 ${slug}/index.html，实际内容：\n  ${entries.join('\n  ')}`);
    return 2;
  }
  if (bad.length) {
    console.error(`✗ zip 结构不合规：${bad.join(', ')}`);
    return 2;
  }

  const size = fs.statSync(zipPath).size;
  console.log(`✓ ${path.relative(process.cwd(), zipPath)}（${(size / 1024).toFixed(1)} KB）`);
  console.log(`  结构：${slug}/index.html`);
  console.log(`  下一步：taptap-cli upload-h5-package ${path.basename(zipPath)} --dev-id <id> --app-id <id> --yes`);
  return 0;
}

process.exit(main());
