#!/usr/bin/env node
/* g2wx.mjs — 把 DSH Game Studio 产出的游戏目录转换成微信小游戏工程。
 *
 * 设计约束（重要）：
 *   1. 绝不修改游戏代码。game.js 原样复制成 game-code.js，
 *      这样 Game Studio 重新构建后再跑一次转换就是幂等的。
 *   2. 一切浏览器差异都吸收进 wx-shim.js。
 *   3. 素材来自 dist/index.html 里的 window.GAME.assets（data URL），
 *      这才是"应用了 AI 美术之后"的真实产物。
 *
 * 用法：
 *   node g2wx.mjs --src games/moonlit-fox --out games/moonlit-fox/targets/wechat \
 *                  --appid wxf4a1dc7203f5262d
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const out = { scale: 2, appid: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--src') out.src = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--appid') out.appid = argv[++i];
    else if (a === '--scale') out.scale = Number(argv[++i]) || 2;
    else if (a === '--debug') out.debug = true;
    else if (a === '--force') out.force = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

/* ---------- 兼容性扫描 ---------- */
const RISKY = [
  [/document\s*\.\s*querySelector/g, 'document.querySelector —— 小游戏没有 DOM 查询'],
  [/getBoundingClientRect/g, 'getBoundingClientRect —— 小游戏没有布局系统'],
  [/localStorage/g, 'localStorage —— 请改用 wx.setStorageSync'],
  [/XMLHttpRequest|\bfetch\s*\(/g, '网络请求 —— 请改用 wx.request（且小游戏不允许任意外链）'],
  [/new\s+Worker\s*\(/g, 'new Worker —— 小游戏需用 wx.createWorker'],
  [/getContext\s*\(\s*['"]webgl/g, "getContext('webgl') —— 小游戏需改用 wx.createCanvas 的 WebGL 上下文"],
  [/document\s*\.\s*body\s*\.\s*appendChild/g, 'document.body.appendChild —— 小游戏无 DOM（当前代码路径应不会走到）'],
  [/window\s*\.\s*crypto/g, 'window.crypto —— 小游戏无此对象']
];

function scanCompat(code) {
  const lines = code.split('\n');
  const hits = [];
  for (const [re, msg] of RISKY) {
    const found = [];
    for (let i = 0; i < lines.length; i += 1) {
      re.lastIndex = 0;
      if (re.test(lines[i])) found.push(i + 1);
    }
    if (found.length) hits.push({ note: msg, count: found.length, lines: found.slice(0, 5) });
  }
  return hits;
}

/* ---------- 从 dist/index.html 取出 window.GAME ---------- */
function readGameConfig(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const marker = 'window.GAME=';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('dist/index.html 里找不到 window.GAME，请先跑一次 game_studio_build');
  const start = at + marker.length;
  const end = html.indexOf('</script>', start);
  if (end < 0) throw new Error('window.GAME 之后找不到 </script>');
  let text = html.slice(start, end).trim();
  if (text.endsWith(';')) text = text.slice(0, -1);
  return JSON.parse(text);
}

/* ---------- data URL ---------- */
function decodeDataUrl(slot, dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) throw new Error(`槽位 ${slot} 的素材不是 data URL`);
  const mime = m[1].toLowerCase();
  const isBase64 = !!m[2];
  const payload = m[3];
  const buf = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mime, buf };
}

/* ---------- SVG 尺寸 ---------- */
function svgSize(svgText, fallback) {
  const w = /\bwidth="([\d.]+)(?:px)?"/.exec(svgText);
  const h = /\bheight="([\d.]+)(?:px)?"/.exec(svgText);
  if (w && h) return [Math.round(Number(w[1])), Math.round(Number(h[1]))];
  const vb = /viewBox="([\d.\-\s]+)"/.exec(svgText);
  if (vb) {
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length === 4) return [Math.round(p[2]), Math.round(p[3])];
  }
  return fallback;
}

/* ---------- 用无头 Chrome 把 SVG 栅格化成 PNG ---------- */
function rasterizeSvg(svgText, outPng, w, h, scale) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g2wx-'));
  try {
    const page = path.join(tmp, 'page.html');
    fs.writeFileSync(
      page,
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
        'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
        `svg{display:block;width:${w}px;height:${h}px}` +
        '</style></head><body>' + svgText + '</body></html>'
    );
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    try { fs.unlinkSync(outPng); } catch (e) { /* 不存在就算了 */ }
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      `--force-device-scale-factor=${scale}`,
      '--default-background-color=00000000',
      `--window-size=${w},${h}`,
      `--screenshot=${outPng}`,
      `file://${page}`
    ];
    execFileSync(CHROME, args, { stdio: 'pipe', timeout: 90000 });
    if (!fs.existsSync(outPng)) throw new Error('Chrome 没有产出 PNG（栅格化失败）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------- 主流程 ---------- */
function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.src || !args.out) {
    console.log(
      '用法: node g2wx.mjs --src <游戏目录> --out <输出目录> [--appid <appid>] [--scale 2]'
    );
    process.exit(args.help ? 0 : 1);
  }

  const src = path.resolve(args.src);
  const out = path.resolve(args.out);
  const distHtml = path.join(src, 'dist', 'index.html');
  const srcGameJs = path.join(src, 'game.js');

  if (!fs.existsSync(distHtml)) throw new Error(`找不到 ${distHtml}，请先让 Game Studio 构建一次`);
  if (!fs.existsSync(srcGameJs)) throw new Error(`找不到 ${srcGameJs}`);

  const game = readGameConfig(distHtml);
  const code = fs.readFileSync(srcGameJs, 'utf8');
  const warnings = [];

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true });

  /* 1. 素材 */
  const assetMap = {};
  const assetReport = [];
  const slots = game.slots || {};
  for (const [slot, dataUrl] of Object.entries(game.assets || {})) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      warnings.push(`槽位 ${slot} 不是 data URL，已跳过`);
      continue;
    }
    const { mime, buf } = decodeDataUrl(slot, dataUrl);
    const fileName = `${slot}.png`;
    const target = path.join(out, 'assets', fileName);

    if (mime.includes('svg')) {
      const svgText = buf.toString('utf8');
      const isTile = !!(slots[slot] && slots[slot].tile);
      const scale = isTile ? 1 : args.scale;
      const [w, h] = svgSize(svgText, [256, 256]);
      rasterizeSvg(svgText, target, w, h, scale);
      assetReport.push({ slot, from: 'svg', size: `${w}x${h}`, scale, bytes: fs.statSync(target).size });
    } else {
      fs.writeFileSync(target, buf);
      assetReport.push({ slot, from: mime, size: '-', scale: 1, bytes: buf.length });
    }
    assetMap[slot] = `assets/${fileName}`;
  }

  /* 2. 游戏代码：原样复制，零改写 */
  fs.writeFileSync(path.join(out, 'game-code.js'), code, 'utf8');

  /* 3. 适配层 */
  const shimSrc = path.join(HERE, 'wx-shim.js');
  if (!fs.existsSync(shimSrc)) throw new Error(`缺少 ${shimSrc}`);
  fs.copyFileSync(shimSrc, path.join(out, 'wx-shim.js'));

  /* 4. 游戏配置 */
  const cfg = {
    title: game.title || 'Game',
    rules: game.rules || {},
    slots: game.slots || {},
    assets: assetMap
  };
  fs.writeFileSync(
    path.join(out, 'game-config.js'),
    'module.exports = ' + JSON.stringify(cfg, null, 2) + ';\n',
    'utf8'
  );

  /* 5. 小游戏入口 */
  fs.writeFileSync(
    path.join(out, 'game.js'),
    [
      '// 微信小游戏入口 —— 由 g2wx.mjs 生成，请勿手改。',
      args.debug ? 'globalThis.__G2WX_DEBUG__ = true;' : '',
      "require('./wx-shim.js');",
      '// 浏览器里由页面注入 window.GAME，这里补上',
      "window.GAME = require('./game-config.js');",
      '// 游戏本体，与 Game Studio 产出的 game.js 完全一致',
      "require('./game-code.js');",
      args.debug
        ? [
            '// --debug：每秒把游戏状态打到 console，供管线做断言',
            'if (typeof window.__gameState === \'function\') {',
            '  setInterval(function () {',
            '    try { console.log(\'[g2wx:state]\', JSON.stringify(window.__gameState())); } catch (e) {}',
            '  }, 1000);',
            '}',
            ''
          ].join('\n')
        : '',
      ''
    ].filter(function (x) { return x !== ''; }).join('\n'),
    'utf8'
  );

  /* 6. 小游戏配置 */
  const landscape = String(game.orientation || 'landscape') !== 'portrait';
  fs.writeFileSync(
    path.join(out, 'game.json'),
    JSON.stringify(
      {
        deviceOrientation: landscape ? 'landscape' : 'portrait',
        showStatusBar: false,
        networkTimeout: { request: 10000, connectSocket: 10000, uploadFile: 10000, downloadFile: 10000 }
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  /* 7. 工程配置 */
  fs.writeFileSync(
    path.join(out, 'project.config.json'),
    JSON.stringify(
      {
        description: `${cfg.title} —— 由 DSH Game Studio + g2wx 生成`,
        compileType: 'game',
        appid: args.appid || 'touristappid',
        projectname: cfg.title,
        libVersion: 'latest',
        setting: {
          urlCheck: false,
          es6: false,
          enhance: false,
          postcss: false,
          minified: false,
          autoAudits: false,
          uploadWithSourceMap: false
        }
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  /* 8. 兼容性扫描 */
  const compat = scanCompat(code);
  if (compat.length && !args.force) {
    console.error('\n✗ 检测到小游戏不支持的 API，已停止转换：\n');
    for (const c of compat) {
      console.error(`  · ${c.note}`);
      console.error(`    命中 ${c.count} 次，行号 ${c.lines.join(', ')}${c.count > c.lines.length ? ' …' : ''}`);
    }
    console.error('\n  这些写法在小游戏里会失败或静默不生效。');
    console.error('  确认过风险后加 --force 强制转换（产物很可能跑不起来）：\n');
    console.error(`    node g2wx.mjs --src <游戏目录> --out <输出目录> --force\n`);
    process.exit(3);
  }
  for (const c of compat) warnings.push(`兼容性风险（已 --force 放行）：${c.note} ×${c.count}`);

  /* 9. 体积 */
  let totalBytes = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else totalBytes += fs.statSync(p).size;
    }
  })(out);
  const LIMIT = 4 * 1024 * 1024;
  if (totalBytes > LIMIT) {
    warnings.push(`包体积 ${(totalBytes / 1048576).toFixed(2)}MB 超过小游戏主包 4MB 限制`);
  }

  const report = {
    src,
    out,
    title: cfg.title,
    appid: args.appid || '(touristappid)',
    orientation: landscape ? 'landscape' : 'portrait',
    assets: assetReport,
    packageBytes: totalBytes,
    compat,
    forced: !!args.force,
    warnings
  };
  fs.writeFileSync(path.join(out, 'g2wx-report.json'), JSON.stringify(report, null, 2));

  /* 输出 */
  console.log(`✓ 已生成小游戏工程: ${out}`);
  console.log(`  游戏: ${cfg.title}  方向: ${report.orientation}  包体积: ${(totalBytes / 1024).toFixed(1)} KB`);
  console.log('  素材:');
  for (const a of assetReport) {
    console.log(`    ${a.slot.padEnd(12)} ${a.from.padEnd(16)} ${a.size.padEnd(10)} x${a.scale}  ${(a.bytes / 1024).toFixed(0)} KB`);
  }
  if (warnings.length) {
    console.log('  ⚠ 警告:');
    for (const w of warnings) console.log('    - ' + w);
  } else {
    console.log('  兼容性扫描: 未发现风险调用');
  }
}

main();
