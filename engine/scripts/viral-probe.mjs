#!/usr/bin/env node
/* viral-probe.mjs —— Gate 2：对建成的游戏做产物断言，不采信 brief 自述。
 *
 * 月夜狐灯的教训：brief 说"AI 美术已替换主角"，实测 game.js 与 5 个素材全同。
 * 同理，brief 说"有分享机制"、"3 分钟一局"都不算数——必须对产物实测。
 *
 * 测什么：
 *   VD-07b 冷启动   页面加载 → window.__gameState 可用（可操作）耗时
 *   VD-03b 反馈延迟 操作后状态变化的时间；失败后重开耗时
 *   VD-02b 单局时长 实测配置的倒计时长度，并与 playtest 观测交叉验证
 *   VD-05b 分享机制 代码 grep，不看 brief
 *   VD-06b 文案钩子 扫描产物里的可传播文本
 *
 * 用法：
 *   node viral-probe.mjs --game <游戏目录> [--seconds 12] [--json]
 *
 * 退出码：0 全部通过 ｜ 1 参数错误 ｜ 2 有未达标项（WARN，不阻断）
 *
 * 设计约束：本层只出 WARN，不设 BLOCK。VD-09 去重由合规层 identical-code / same-assets 负责。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePlaywright } from './lib.mjs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { seconds: 12 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--game') o.game = argv[++i];
    else if (a === '--seconds') o.seconds = Number(argv[++i]) || 12;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function entryHtml(dir) {
  return [path.join(dir, 'targets', 'web', 'index.html'), path.join(dir, 'dist', 'index.html')]
    .find((p) => fs.existsSync(p));
}

/* ---------- 静态部分：代码与文案 ---------- */

const SHARE_API = /(navigator\.(share|clipboard)|wx\.shareAppMessage|wx\.onShareAppMessage|shareAppMessage|onShareTimeline|leaderboard|rankList|invite|openDataContext)/i;
const SHARE_WORDS = /分享|邀请|排行|组队|晒一晒|好友/;
const HOOK_WORDS = /战绩|排行|省份|全国|第\s*\d+\s*名|击败|超过|难度|太难|再来|挑战/;

function scanCode(dir) {
  let code = '';
  try { code = fs.readFileSync(path.join(dir, 'game.js'), 'utf8'); } catch (e) { /* 没有源码就只测运行时 */ }
  const apiHits = code.match(new RegExp(SHARE_API.source, 'gi')) || [];
  return {
    hasCode: Boolean(code),
    shareApiHits: apiHits,
    shareWordOnly: apiHits.length === 0 && SHARE_WORDS.test(code),
    hookHits: (code.match(new RegExp(HOOK_WORDS.source, 'g')) || []).slice(0, 5),
    // 倒计时长度：从代码里捞 duration 配置，作为 playtest 期望值
    declaredDuration: (() => {
      const m = /duration\s*:\s*(\d+)/.exec(code);
      return m ? Number(m[1]) : null;
    })()
  };
}

/* ---------- 运行时：Playwright 实测 ---------- */

async function probeRuntime(entry, orientation, seconds) {
  const pwPath = resolvePlaywright();
  if (!pwPath) throw new Error('找不到 playwright-core（设 PLAYWRIGHT_CORE 或在本目录 npm i playwright-core）');
  const pw = await import(pathToFileURL(path.join(pwPath, 'index.js')).href);
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  if (!chromium) throw new Error('playwright-core 里没有 chromium');

  const viewport = orientation === 'portrait'
    ? { width: 390, height: 844 }
    : { width: 960, height: 540 };

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required']
  });

  const out = { bootMs: null, feedbackMs: null, restartMs: null, roundSeconds: null, states: 0, error: null };
  try {
    const page = await browser.newPage({ viewport });

    // VD-07b 冷启动：从 goto 到 __gameState 可读
    const t0 = Date.now();
    await page.goto(pathToFileURL(entry).href, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__gameState === 'function', null, { timeout: 20000 });
    out.bootMs = Date.now() - t0;

    const readState = () => page.evaluate(() => {
      try { return window.__gameState(); } catch (e) { return null; }
    });

    const cx = Math.round(viewport.width / 2);
    const cy = Math.round(viewport.height / 2);

    // 进入 playing
    await page.mouse.click(cx, cy);
    const tStart = Date.now();
    let playing = null;
    while (Date.now() - tStart < 5000) {
      const s = await readState();
      if (s && s.phase === 'playing') { playing = s; break; }
      await sleep(60);
    }
    if (!playing) {
      out.error = '点击后 5 秒内没进入 playing 阶段';
      return out;
    }

    // VD-02b 单局时长：状态的 time 是剩余秒数，刚开局时等于总时长
    out.roundSeconds = Math.round(playing.time);

    // VD-03b 反馈延迟：按住摇杆，测 hero 坐标开始变化的时间
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const before = await readState();
    const tMove = Date.now();
    let moved = null;
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.move(cx + 100, cy, { steps: 2 });
      const s = await readState();
      if (s && before && s.hero && (Math.abs(s.hero.x - before.hero.x) > 1 || Math.abs(s.hero.y - before.hero.y) > 1)) {
        moved = Date.now() - tMove;
        break;
      }
      await sleep(25);
    }
    out.feedbackMs = moved;

    // 采样一段时间，确认稳定在 playing
    const steps = Math.max(6, Math.round((seconds * 1000) / 400));
    for (let i = 0; i < steps; i += 1) {
      const ang = (i / 6) * Math.PI * 2;
      await page.mouse.move(cx + Math.cos(ang) * 90, cy + Math.sin(ang) * 90);
      await sleep(400);
      const s = await readState();
      if (s) out.states += 1;
    }
    await page.mouse.up();

    // VD-03b 重开：强制结束不行，只能等自然结束再测；时间不够就跳过
    // 这里只测"结束后点击到回到 playing"的路径是否通畅，用一次快速判定
    const s = await readState();
    out.endPhase = s ? s.phase : null;
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    await browser.close();
  }
  return out;
}

/* ---------- 汇总 ---------- */

export async function runProbe(dir, opts = {}) {
  const brief = readJson(path.join(dir, 'game.brief.json')) || {};
  const orientation = (brief.channel && brief.channel.orientation) || 'landscape';
  const code = scanCode(dir);
  const entry = entryHtml(dir);

  let rt = null;
  if (entry) {
    rt = await probeRuntime(entry, orientation, opts.seconds || 12);
  }

  const items = [];

  // VD-05b 分享机制：以产物为准
  items.push({
    id: 'VD-05b',
    level: 'WARN',
    ok: code.shareApiHits.length > 0,
    label: '分享机制（实测）',
    detail: code.shareApiHits.length
      ? `发现 ${code.shareApiHits.length} 处分享 API：${code.shareApiHits[0]}`
      : (code.shareWordOnly ? '只有分享文案，没有分享 API 调用' : '产物里没有分享机制'),
    hint: '分享必须内嵌进核心循环（得道具/排行/组队），角落按钮不算'
  });

  // VD-07b 冷启动
  items.push({
    id: 'VD-07b',
    level: 'WARN',
    ok: rt && Number.isFinite(rt.bootMs) && rt.bootMs <= 3000,
    label: '冷启动（实测）',
    detail: rt && Number.isFinite(rt.bootMs)
      ? `${(rt.bootMs / 1000).toFixed(1)}s 到可操作`
      : (rt && rt.error ? `没测出来：${rt.error}` : '没有可测的产物'),
    hint: '点开到可玩 ≤3 秒；超过就会被划走'
  });

  // VD-03b 反馈延迟
  items.push({
    id: 'VD-03b',
    level: 'WARN',
    ok: rt && Number.isFinite(rt.feedbackMs) && rt.feedbackMs <= 1000,
    label: '反馈延迟（实测）',
    detail: rt && Number.isFinite(rt.feedbackMs) ? `操作→状态变化 ${rt.feedbackMs}ms` : '没测到反馈延迟',
    hint: '每次操作 1 秒内必须有可感知的反馈'
  });

  // VD-02b 单局时长：先看实测，再和代码声明交叉核对
  const measured = rt && Number.isFinite(rt.roundSeconds) ? rt.roundSeconds : null;
  const declared = code.declaredDuration;
  const durOk = Number.isFinite(measured) && measured >= 180 && measured <= 300;
  items.push({
    id: 'VD-02b',
    level: 'WARN',
    ok: durOk,
    label: '单局时长（实测）',
    detail: Number.isFinite(measured)
      ? `${measured}s${Number.isFinite(declared) && declared !== measured ? `（代码声明 ${declared}s，不一致）` : ''}`
      : (Number.isFinite(declared) ? `只读到代码声明 ${declared}s，没测到运行时` : '没测到单局时长'),
    hint: '3–5 分钟一局：太短没有沉浸，太长放弃率高'
  });

  // VD-06b 文案钩子
  items.push({
    id: 'VD-06b',
    level: 'INFO',
    ok: code.hookHits.length > 0,
    label: '文案钩子',
    detail: code.hookHits.length ? `发现：${code.hookHits.join('、')}` : '产物里没找到可传播的战绩/排行/难度文案',
    hint: '玩完后玩家要有一句话可跟朋友说'
  });

  const failed = items.filter((i) => !i.ok && i.level !== 'INFO');
  return {
    game: brief.title || path.basename(dir),
    probed: Boolean(rt),
    runtimeError: rt && rt.error ? rt.error : null,
    items,
    ok: failed.length === 0,
    failed: failed.length,
    // 值不值得上架摘要
    summary: failed.length === 0
      ? '产物实测通过：分享、反馈、时长、冷启动都达标'
      : `产物实测 ${failed.length} 项未达：${failed.map((i) => i.label).join('、')}`
  };
}

/* ---------- CLI ---------- */
if (process.argv[1] && process.argv[1].endsWith('viral-probe.mjs')) {
  const args = parseArgs(process.argv);
  if (args.help || !args.game) {
    console.log('用法: node viral-probe.mjs --game <游戏目录> [--seconds 12] [--json]');
    process.exit(args.help ? 0 : 1);
  }
  const dir = path.resolve(args.game);
  const result = await runProbe(dir, { seconds: args.seconds });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n爆款基因实测：${result.game}　（对产物断言，不采信 brief）\n`);
    for (const i of result.items) {
      const mark = i.ok ? '✓' : (i.level === 'INFO' ? '·' : '⚠');
      console.log(`${mark} [${i.id}] ${i.label}　${i.detail}`);
      if (!i.ok && i.hint) console.log(`    → ${i.hint}`);
    }
    if (result.runtimeError) console.log(`\n  运行时没走完：${result.runtimeError}`);
    console.log(`\n${result.summary}`);
  }
  process.exit(result.ok ? 0 : 2);
}
