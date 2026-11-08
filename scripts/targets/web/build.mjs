#!/usr/bin/env node
/* targets/web/build.mjs —— 网页渠道的打包。
 *
 * 网页渠道的"构建"其实 Game Studio 已经做完了：dist/index.html 就是自包含的单文件
 * （素材内联、CSP 禁网、零外链）。这里只做三件事：复制、体检、记账。
 *
 * 不做的事：不改游戏代码（与微信渠道同一条铁律）。
 *
 * 用法：
 *   node build.mjs --game <游戏目录> --out <游戏目录>/targets/web
 *
 * 退出码：0 成功 ｜ 2 构建失败
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--game') o.game = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.game) {
    console.log('用法: node build.mjs --game <游戏目录> [--out <输出目录>]');
    process.exit(args.help ? 0 : 2);
  }

  const game = path.resolve(args.game);
  const out = path.resolve(args.out || path.join(game, 'targets', 'web'));
  const src = path.join(game, 'dist', 'index.html');

  if (!fs.existsSync(src)) {
    console.error(`✗ 找不到 ${src} —— 请先用 Game Studio 构建一次`);
    process.exit(2);
  }

  fs.mkdirSync(out, { recursive: true });
  const html = fs.readFileSync(src, 'utf8');

  /* 体检：网页版必须是自包含的（不能有外链，否则离线/分享就废了） */
  const problems = [];
  const externals = html.match(/(?:src|href)="(?!data:|#)[^"]*"/g) || [];
  for (const e of externals) {
    if (/^https?:|^\/\//.test(e.replace(/^\w+="/, ''))) problems.push(`外链资源: ${e.slice(0, 80)}`);
  }
  const hasCsp = /Content-Security-Policy/i.test(html);
  const inlineAssets = (html.match(/data:image\//g) || []).length;

  if (problems.length) {
    console.error('✗ 产物不是自包含的：');
    for (const p of problems) console.error('  · ' + p);
    process.exit(2);
  }

  const dest = path.join(out, 'index.html');
  fs.writeFileSync(dest, html, 'utf8');

  const bytes = Buffer.byteLength(html, 'utf8');
  const manifest = {
    target: 'web',
    builtFrom: src,
    entry: dest,
    bytes,
    inlineAssets,
    hasCsp,
    builtAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(out, 'web-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`✓ 网页产物: ${dest}`);
  console.log(`  体积 ${(bytes / 1024).toFixed(1)} KB · 内联图片 ${inlineAssets} 个 · CSP ${hasCsp ? '有' : '无'} · 外链 0`);
}

main();
