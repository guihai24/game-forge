/* 重建游戏产物：把 game.json + game.js + assets 拼成自包含 HTML。
 *
 * 为什么不调 game_studio_build：那个工具只通过 agent 工具接口暴露，
 * 没有导出成可调用的函数。这里按它的实现原样复刻（renderHtml），
 * 保证产物格式与插件自己构建的一致——CSP、注入顺序、转义都一样。
 *
 * 用法: node rebuild.mjs <游戏目录>
 */
import fs from 'node:fs';
import path from 'node:path';

const CSP = [
  "default-src 'none'", "img-src data: blob:", "media-src data: blob:",
  "font-src data:", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'",
  "connect-src 'none'", "form-action 'none'"
].join('; ');
const STYLE = 'html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block;width:100vw;height:100vh;touch-action:none;outline:none}';
const MAX_BYTES = 24 * 1024 * 1024;

const inlineSafe = (t) => t.replace(/<\/(script)/giu, '<\\/$1').replace(/<!--/gu, '<\\!--');
const escapeHtml = (t) => t.replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mimeOf = (f) => {
  const e = path.extname(f).toLowerCase();
  return e === '.svg' ? 'image/svg+xml' : e === '.png' ? 'image/png'
    : e === '.jpg' || e === '.jpeg' ? 'image/jpeg' : e === '.webp' ? 'image/webp'
      : 'application/octet-stream';
};

const dir = path.resolve(process.argv[2] || '.');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8'));
const code = fs.readFileSync(path.join(dir, 'game.js'), 'utf8');

const assets = {};
for (const [slot, spec] of Object.entries(manifest.slots || {})) {
  const f = path.join(dir, spec.file);
  if (!fs.existsSync(f)) { console.error(`✗ 槽位 ${slot} 缺文件: ${spec.file}`); process.exit(1); }
  assets[slot] = `data:${mimeOf(spec.file)};base64,${fs.readFileSync(f).toString('base64')}`;
}

let ledger = null;
try { ledger = JSON.parse(fs.readFileSync(path.join(dir, 'assets', 'ASSETS.json'), 'utf8')); } catch (e) { /* 没有台账 */ }

const game = {
  title: manifest.title,
  rules: manifest.rules,
  slots: Object.fromEntries(Object.entries(manifest.slots || {}).map(([slot, spec]) => [slot, {
    tile: spec.tile === true,
    custom: ledger?.assets?.[slot] !== undefined && ledger.assets[slot].source !== 'template'
  }])),
  assets
};

// runtime（voxel 模板才有 three.js）——collector 不需要
const runtimes = [];
for (const id of manifest.runtime || []) {
  if (id !== 'three') { console.error(`✗ 未知 runtime: ${id}`); process.exit(1); }
  const p = new URL('../lib/vendor/three.js', import.meta.url);
  runtimes.push(fs.readFileSync(p, 'utf8'));
}

const html = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
  `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
  `<title>${escapeHtml(manifest.title)}</title>`,
  `<style>${STYLE}</style></head><body><canvas id="game" tabindex="0"></canvas>`,
  ...runtimes.map((s) => `<script>${inlineSafe(s)}</script>`),
  `<script>window.GAME=${inlineSafe(JSON.stringify(game))};</script>`,
  `<script>${inlineSafe(code)}</script>`,
  '</body></html>',
  ''
].join('\n');

const bytes = Buffer.byteLength(html);
if (bytes > MAX_BYTES) { console.error(`✗ 产物 ${(bytes / 1048576).toFixed(1)} MB 超限`); process.exit(1); }

fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
fs.writeFileSync(path.join(dir, 'dist', 'index.html'), html);
console.log(`✓ ${path.relative(process.cwd(), dir)}/dist/index.html  ${(bytes / 1024).toFixed(0)} KB`);
