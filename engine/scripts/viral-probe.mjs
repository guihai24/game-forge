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
import { judgeRoundSeconds } from './viral-dna-lib.mjs';

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

/* ---------- 通用状态判定：不绑定某个品类 ---------- */

/** 从游戏状态里推断单局总时长（秒）。认不出来返回 null。 */
export function pickRoundSeconds(state) {
  const s = state || {};
  // 优先用"显式声明总时长"的字段
  for (const k of ['duration', 'roundSeconds', 'totalTime', 'timeLimit', 'maxTime']) {
    const v = Number(s[k]);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  // 其次用倒计时字段：刚开局时的读数就是总时长
  for (const k of ['time', 'timeLeft', 'remaining', 'countdown']) {
    const v = Number(s[k]);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return null;
}

/** 两个状态之间有没有发生可观测的变化。递归比较，忽略纯渲染字段。 */
export function stateChanged(a, b, depth = 0) {
  if (depth > 3) return false;
  if (a === b) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > 0.01;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a !== b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    // fps / 时间戳这类每帧都变的字段不算"反馈"
    if (/^(fps|dt|delta|now|timestamp|frame)$/i.test(k)) continue;
    if (stateChanged(a[k], b[k], depth + 1)) return true;
  }
  return false;
}

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

    // VD-02b 单局时长：不同游戏暴露的字段不同（time 剩余秒 / duration / totalTime）。
    // 认不出来就报"未测"，不要拿别的字段硬套。
    out.roundSeconds = pickRoundSeconds(playing);

    // VD-03b 反馈延迟：不依赖 hero 字段——任何可观测状态的变化都算反馈。
    // 三消没有 hero，但 score / board / matched 会变；点击类 score 会变。
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const before = await readState();
    const tMove = Date.now();
    let moved = null;
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.move(cx + 100, cy, { steps: 2 });
      const s = await readState();
      if (s && before && stateChanged(before, s)) {
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

    // VD-03c 重开耗时：等自然进入结束态，再点一次测回 playing 的耗时。
    // 单局太长就放弃（最多等 20 秒），报"未测"而不是瞎给一个数。
    out.endPhase = (await readState() || {}).phase || null;
    const waitDeadline = Date.now() + 20000;
    while (Date.now() < waitDeadline) {
      const s = await readState();
      if (!s) break;
      if (s.phase !== 'playing') { out.endPhase = s.phase; break; }
      await sleep(300);
    }
    if (out.endPhase && out.endPhase !== 'playing') {
      const tRestart = Date.now();
      await page.mouse.click(cx, cy);
      for (let i = 0; i < 60; i += 1) {
        const s = await readState();
        if (s && s.phase === 'playing') { out.restartMs = Date.now() - tRestart; break; }
        await sleep(50);
      }
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    await browser.close();
  }
  return out;
}

/* ---------- 判定辅助 ---------- */

/** 生成一条判定。ok 为 null 表示"没测到"——不是未达，也不该被算成通过。
 *
 * 三态：
 *   true   达标
 *   false  未达（测到了，不达标）
 *   null   未测（没能力测 / 品类不支持），单独统计，不混进"未达"里吓人
 */
function verdict(id, level, label, ok, detail, hint, measured) {
  return [{
    id,
    level,
    ok,
    measured: measured !== false,
    unmeasured: ok === null,
    label,
    detail,
    hint
  }];
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
  items.push(...verdict('VD-07b', 'WARN', '冷启动（实测）',
    rt && Number.isFinite(rt.bootMs) ? rt.bootMs <= 3000 : null,
    rt && Number.isFinite(rt.bootMs) ? `${(rt.bootMs / 1000).toFixed(1)}s 到可操作` : '没测到启动耗时',
    '点开到可玩 ≤3 秒；超过就会被划走',
    Boolean(rt && Number.isFinite(rt.bootMs))));

  // VD-03b 反馈延迟（重开 <2s 见下方单独一项）
  items.push(...verdict('VD-03b', 'WARN', '反馈延迟（实测）',
    rt && Number.isFinite(rt.feedbackMs) ? rt.feedbackMs <= 1000 : null,
    rt && Number.isFinite(rt.feedbackMs) ? `操作→状态变化 ${rt.feedbackMs}ms` : '没测到反馈延迟（状态里没有任何可观测字段变化）',
    '每次操作 1 秒内必须有可感知的反馈',
    Boolean(rt && Number.isFinite(rt.feedbackMs))));

  // VD-03c 重开耗时：单独一项，不再混进 VD-03b 里假装测过
  items.push(...verdict('VD-03c', 'WARN', '重开耗时（实测）',
    rt && Number.isFinite(rt.restartMs) ? rt.restartMs <= 2000 : null,
    rt && Number.isFinite(rt.restartMs) ? `${(rt.restartMs / 1000).toFixed(1)}s` : '没测到（单局没跑完就无法测重开）',
    '失败后 2 秒内能重开，否则"再来一次"的冲动会断',
    Boolean(rt && Number.isFinite(rt.restartMs))));

  // VD-02b 单局时长：按品类分段，认不出品类就报"未判"
  const measured = rt && Number.isFinite(rt.roundSeconds) ? rt.roundSeconds : null;
  const declared = code.declaredDuration;
  const round = judgeRoundSeconds(measured, brief);
  items.push(...verdict('VD-02b', 'WARN', '单局时长（实测）',
    measured === null ? null : round.ok,
    Number.isFinite(measured)
      ? `${round.note}${Number.isFinite(declared) && declared !== measured ? `（代码声明 ${declared}s，不一致）` : ''}`
      : (Number.isFinite(declared) ? `只读到代码声明 ${declared}s，没测到运行时` : '没测到单局时长'),
    '按品类判区间：短局品类（Flappy/跳一跳）秒级到 90 秒也算合格',
    Number.isFinite(measured)));

  // VD-06b 文案钩子
  items.push({
    id: 'VD-06b',
    level: 'INFO',
    ok: code.hookHits.length > 0,
    label: '文案钩子',
    detail: code.hookHits.length ? `发现：${code.hookHits.join('、')}` : '产物里没找到可传播的战绩/排行/难度文案',
    hint: '玩完后玩家要有一句话可跟朋友说'
  });

  const judged = items.filter((i) => i.level !== 'INFO');
  const failed = judged.filter((i) => i.ok === false);
  const unmeasured = judged.filter((i) => i.ok === null);
  return {
    game: brief.title || path.basename(dir),
    probed: Boolean(rt),
    runtimeError: rt && rt.error ? rt.error : null,
    items,
    ok: failed.length === 0,
    failed: failed.length,
    unmeasured: unmeasured.length,
    // 值不值得上架摘要
    summary: [
      failed.length === 0
        ? `产物实测通过${unmeasured.length ? `（${unmeasured.length} 项未测到）` : ''}`
        : `产物实测 ${failed.length} 项未达`,
      failed.length ? `：${failed.map((i) => i.label).join('、')}` : '',
      unmeasured.length ? `；另有 ${unmeasured.length} 项未测到：${unmeasured.map((i) => i.label).join('、')}` : ''
    ].join('')
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
      const mark = i.ok === true ? '✓' : (i.level === 'INFO' ? '·' : (i.ok === null ? '?' : '⚠'));
      console.log(`${mark} [${i.id}] ${i.label}　${i.detail}`);
      if (i.ok === false && i.hint) console.log(`    → ${i.hint}`);
    }
    if (result.runtimeError) console.log(`\n  运行时没走完：${result.runtimeError}`);
    console.log(`\n${result.summary}`);
  }
  process.exit(result.ok ? 0 : 2);
}
