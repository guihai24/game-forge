#!/usr/bin/env node
/* targets/web/verify.mjs —— 网页渠道的自动试玩与断言。
 *
 * 与微信渠道共用同一套验收标准（读 brief.acceptance），只是执行器不同：
 * 微信那边读 console 状态日志，网页这边直接 page.evaluate(window.__gameState)。
 *
 * 用法：
 *   node verify.mjs --dir <targets/web> [--brief <game.brief.json>] [--shots <目录>]
 *
 * 退出码：0 通过 ｜ 3 环境/运行失败 ｜ 4 断言失败
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePlaywright } from '../../lib.mjs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { seconds: 10 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i];
    else if (a === '--brief') o.brief = argv[++i];
    else if (a === '--shots') o.shots = argv[++i];
    else if (a === '--seconds') o.seconds = Number(argv[++i]) || 10;
    else if (a === '--require-fps') o.requireFps = true;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.dir) {
    console.log('用法: node verify.mjs --dir <targets/web> [--brief <路径>] [--shots <目录>]');
    process.exit(args.help ? 0 : 3);
  }

  const dir = path.resolve(args.dir);
  const entry = path.join(dir, 'index.html');
  if (!fs.existsSync(entry)) {
    console.error(`✗ 找不到 ${entry}，先跑 build.mjs`);
    process.exit(3);
  }

  /* 验收标准 */
  let brief = null;
  if (args.brief && fs.existsSync(path.resolve(args.brief))) {
    brief = JSON.parse(fs.readFileSync(path.resolve(args.brief), 'utf8'));
  }
  const acceptance = {
    mustReachPhase: (brief && brief.acceptance && brief.acceptance.mustReachPhase) || ['playing'],
    minFps: (brief && brief.acceptance && brief.acceptance.minFps) || 45,
    mustScore: (brief && brief.acceptance && brief.acceptance.mustScore) || 0
  };
  const orientation = (brief && brief.channel && brief.channel.orientation) || 'landscape';

  /* playwright */
  const pwPath = resolvePlaywright();
  if (!pwPath) {
    console.error('✗ 找不到 playwright-core。');
    console.error('  可以设 PLAYWRIGHT_CORE=<目录>，或在本目录 npm i playwright-core');
    process.exit(3);
  }
  let pw;
  try {
    pw = await import(pathToFileURL(path.join(pwPath, 'index.js')).href);
  } catch (e) {
    console.error(`✗ 加载 playwright-core 失败: ${e.message}`);
    process.exit(3);
  }
  // CJS 包经 ESM 动态 import 时，具名导出可能只挂在 default 上
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  if (!chromium) {
    console.error('✗ playwright-core 里没有 chromium（导出的键: ' + Object.keys(pw).join(',') + '）');
    process.exit(3);
  }

  const viewport = orientation === 'portrait'
    ? { width: 390, height: 844 }
    : { width: 960, height: 540 };

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required']
  });

  const states = [];
  let errors = [];
  let ok = false;
  try {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text().slice(0, 200));
    });

    await page.goto(pathToFileURL(entry).href, { waitUntil: 'load' });

    /* 等游戏把 __gameState 挂上 */
    await page.waitForFunction(() => typeof window.__gameState === 'function', null, { timeout: 15000 })
      .catch(() => { throw new Error('页面里没有 window.__gameState —— 游戏没启动'); });

    /* 点击开始（canvas 上 pointerdown 触发） */
    const cx = Math.round(viewport.width / 2);
    const cy = Math.round(viewport.height / 2);
    await page.mouse.click(cx, cy);
    await sleep(600);

    /* 按住并绕小圈 → 驱动虚拟摇杆，边跑边采样 */
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const steps = Math.max(8, Math.round((args.seconds * 1000) / 400));
    for (let i = 0; i < steps; i += 1) {
      const ang = (i / 6) * Math.PI * 2;
      await page.mouse.move(cx + Math.cos(ang) * 90, cy + Math.sin(ang) * 90);
      await sleep(400);
      const s = await page.evaluate(() => {
        try { return window.__gameState(); } catch (e) { return null; }
      });
      if (s) states.push(s);
    }
    await page.mouse.up();

    /* 截图 */
    if (args.shots) {
      fs.mkdirSync(args.shots, { recursive: true });
      const shot = path.join(args.shots, `web-${Date.now()}.jpg`);
      await page.screenshot({ path: shot, type: 'jpeg', quality: 80 });
      console.log(`  截图 ${shot}`);
    }
    ok = true;
  } catch (e) {
    console.error('✗ 运行失败:', e.message);
  } finally {
    await browser.close();
  }

  if (!ok) process.exit(3);
  if (!states.length) {
    console.error('✗ 一条状态都没采到');
    process.exit(4);
  }

  /* 断言（与微信渠道同构） */
  const phases = [...new Set(states.map((s) => s.phase))];
  const maxScore = Math.max(...states.map((s) => s.score || 0));
  const fpsList = states.map((s) => s.fps || 0).filter((n) => n > 0);
  const steadyFps = median(fpsList.slice(3).length ? fpsList.slice(3) : fpsList);
  const reachedAll = acceptance.mustReachPhase.every((p) => phases.includes(p));

  const assertions = [
    { name: '游戏启动', ok: true, detail: `${viewport.width}×${viewport.height}` },
    { name: '经过 ' + acceptance.mustReachPhase.join('/'), ok: reachedAll, detail: `phases=${phases.join(',')}` },
    { name: 'fps ≥ ' + acceptance.minFps, ok: steadyFps >= acceptance.minFps, soft: !args.requireFps, detail: `稳态中位数=${steadyFps}` },
    { name: 'fps 未塌方（≥10）', ok: steadyFps >= 10, detail: `稳态中位数=${steadyFps}` }
  ];
  if (acceptance.mustScore > 0) {
    assertions.push({ name: '分数 ≥ ' + acceptance.mustScore, ok: maxScore >= acceptance.mustScore, detail: `max=${maxScore}` });
  }

  console.log('');
  for (const a of assertions) {
    const mark = a.ok ? '✓' : (a.soft ? '⚠' : '✗');
    console.log(`  ${mark} ${a.name}（${a.detail}）`);
  }
  if (errors.length) {
    console.log(`\n  ⚠ 页面报错 ${errors.length} 条：`);
    for (const e of errors.slice(0, 3)) console.log(`    · ${e}`);
  }

  const result = {
    target: 'web',
    viewport,
    entry,
    phases,
    maxScore,
    steadyFps,
    assertions,
    errors: errors.slice(0, 10),
    ok: false
  };

  const hardFail = assertions.filter((a) => !a.ok && !a.soft);
  const softFail = assertions.filter((a) => !a.ok && a.soft);
  result.softWarnings = softFail.map((a) => `${a.name}（${a.detail}）`);
  result.ok = hardFail.length === 0;

  if (args.shots) {
    fs.mkdirSync(args.shots, { recursive: true });
    fs.writeFileSync(path.join(args.shots, 'web-verify.json'), JSON.stringify(result, null, 2));
  }

  for (const a of softFail) console.log(`\n  ⚠ ${a.name} 未达标 —— 视为警告`);
  if (hardFail.length) {
    console.error(`\n✗ 断言失败：${hardFail.map((a) => a.name).join('、')}`);
    process.exit(4);
  }
  console.log('\n✓ 网页渠道验证通过');
}

main().catch((e) => {
  console.error('✗ verify 异常:', e && e.stack ? e.stack : e);
  process.exit(3);
});
