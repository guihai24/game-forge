#!/usr/bin/env node
/* publish.mjs — 一条命令：游戏目录 → 目标渠道产物 → 试玩 → 断言 → 截图 → 预览
 *
 * 目前实现 target=wechat；target=web 见 references/web.md。
 *
 * 它把 g2wx.mjs（转换）和 wechatide CLI（开发者工具）串成一条可失败、可断言的流水线。
 *
 * 用法：
 *   node publish.mjs --target wechat --game games/moonlit-fox --preview
 *
 * 退出码：
 *   0  全部断言通过
 *   1  参数/环境错误
 *   2  转换失败
 *   3  开发者工具调用失败
 *   4  断言失败（游戏没起来 / 没进入 playing / fps 过低 / strict 模式下有报错）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, runCli, parseJson, makeWt, isOk, errorText, parseConsoleLines } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G2WX = path.join(HERE, 'targets', 'wechat', 'g2wx.mjs');
const CLIENT = process.env.WECHATIDE_CLIENT || 'DeepSeekHarness';

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const o = {
    appid: '',
    preview: false,
    upload: false,
    strict: false,
    minFps: null,
    bootWaitMs: 8000,
    keepOpen: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--game') o.game = argv[++i];
    else if (a === '--all') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { o.all = argv[++i]; }
      else o.all = '.';
    }
    else if (a === '--targets') o.targets = argv[++i];
    else if (a === '--target') o.target = argv[++i];
    else if (a === '--brief') o.brief = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--appid') o.appid = argv[++i];
    else if (a === '--preview') o.preview = true;
    else if (a === '--upload') o.upload = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--require-fps') o.requireFps = true;
    else if (a === '--min-fps') o.minFps = Number(argv[++i]) || 45;
    else if (a === '--boot-wait') o.bootWaitMs = Number(argv[++i]) || 8000;
    else if (a === '--keep-open') o.keepOpen = true;
    else if (a === '--no-check') o.noCheck = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return o;
}

/* ---------- 工具 ---------- */


const wt = makeWt(CLIENT);

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

function fail(code, msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}

function requireOk(res, what) {
  if (!isOk(res)) fail(3, `${what} 失败：${errorText(res)}`);
  return (res && res.result) || {};
}

function readConsole(project, grep) {
  const res = wt('get_simulator_console', ['--project', project, '--command', grep]);
  const result = res && res.result;
  return typeof result === 'string' ? result : '';
}

/* ---------- 网页渠道 ---------- */
async function runWeb(args) {
  const game = path.resolve(args.game);
  const out = path.resolve(args.out || path.join(game, 'targets', 'web'));
  const artifactDir = path.join(game, '.pipeline');
  fs.mkdirSync(artifactDir, { recursive: true });
  const briefPath = args.brief ? path.resolve(args.brief) : path.join(game, 'game.brief.json');

  log('1/3', '打包网页产物');
  const b = runCli('node', [path.join(HERE, 'targets', 'web', 'build.mjs'), '--game', game, '--out', out]);
  if (b.code !== 0) fail(2, `打包失败:\n${b.out.slice(0, 800)}`);
  console.log(b.out.trim().split('\n').map((l) => '    ' + l).join('\n'));

  log('2/3', '浏览器自动试玩与断言');
  const vArgs = [path.join(HERE, 'targets', 'web', 'verify.mjs'), '--dir', out, '--shots', artifactDir];
  if (fs.existsSync(briefPath)) vArgs.push('--brief', briefPath);
  if (args.requireFps) vArgs.push('--require-fps');
  const v = runCli('node', vArgs);
  console.log(v.out.trim());

  log('3/3', '记账');
  const report = {
    target: 'web',
    game,
    out,
    artifacts: artifactDir,
    brief: fs.existsSync(briefPath) ? briefPath : null,
    ok: v.code === 0
  };
  fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));

  if (v.code === 4) fail(4, '网页渠道断言失败');
  if (v.code !== 0) fail(3, '网页渠道验证失败');
  console.log(`\n✓ 网页渠道通过（${path.relative(process.cwd(), out)}）`);
  process.exit(0);
}

/* ---------- 批量模式 ---------- */
function findGames(root) {
  const found = [];
  const skip = new Set([
    'node_modules', '.git', 'targets', '.pipeline', 'dist',
    'export', 'assets', '.studio', '.github'
  ]);
  (function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    if (entries.some((e) => e.isFile() && e.name === 'game.brief.json')) {
      found.push(dir);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  })(root, 0);
  return found.sort();
}

function readBriefOf(gameDir) {
  try { return JSON.parse(fs.readFileSync(path.join(gameDir, 'game.brief.json'), 'utf8')); }
  catch (e) { return null; }
}

async function runAll(args) {
  const root = path.resolve(args.all);
  const games = findGames(root);
  if (!games.length) fail(1, `${root} 下没有找到任何带 game.brief.json 的游戏目录`);

  const overrideTargets = args.targets
    ? args.targets.split(',').map((t) => t.trim()).filter(Boolean)
    : null;

  const rows = [];
  for (const gameDir of games) {
    const brief = readBriefOf(gameDir);
    const name = (brief && brief.title) || path.basename(gameDir);
    const targets = overrideTargets || [(brief && brief.target) || 'wechat'];

    for (const target of targets) {
      const started = Date.now();
      const cliArgs = [path.join(HERE, 'publish.mjs'), '--target', target, '--game', gameDir];
      if (args.preview && target === 'wechat') cliArgs.push('--preview');
      if (args.strict) cliArgs.push('--strict');
      if (args.requireFps) cliArgs.push('--require-fps');
      if (args.appid) cliArgs.push('--appid', args.appid);

      console.log(`\n━━━ ${name} · ${target} ━━━`);
      const r = runCli('node', cliArgs);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const tail = r.out.trim().split('\n').slice(-6).join('\n');
      console.log(tail);

      rows.push({
        name,
        target,
        code: r.code,
        seconds,
        ok: r.code === 0,
        detail: r.code === 0 ? '' : (r.out.match(/✗ ([^\n]+)/) || [, `退出码 ${r.code}`])[1]
      });
      // 串行执行：多个模拟器窗口同时开会串截图
      await sleep(1500);
    }
  }

  /* 汇总 */
  const width = Math.max(...rows.map((r) => [...r.name].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0)), 8);
  const pad = (str, w) => {
    const len = [...str].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
    return str + ' '.repeat(Math.max(0, w - len));
  };
  console.log('\n════════ 汇总 ════════');
  console.log(`${pad('游戏', width)}  ${pad('渠道', 8)} ${pad('结果', 8)} ${pad('耗时', 8)} 备注`);
  console.log('─'.repeat(width + 40));
  for (const r of rows) {
    console.log(`${pad(r.name, width)}  ${pad(r.target, 8)} ${pad(r.ok ? '✅ 通过' : '❌ 失败', 8)} ${pad(r.seconds + 's', 8)} ${r.detail}`);
  }
  const passed = rows.filter((r) => r.ok).length;

  const artifactDir = path.join(root, '.pipeline');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'all-report.json'),
    JSON.stringify({ root, ranAt: new Date().toISOString(), rows }, null, 2));

  console.log(`\n${passed}/${rows.length} 通过`);
  if (passed === rows.length) process.exit(0);
  process.exit(rows.some((r) => r.code === 4) ? 4 : 3);
}

/* ---------- 主流程 ---------- */
/* ---------- 构建前置自审 ---------- */

/** 有合规 BLOCK 就拒绝构建；基因项只打印提示。
 *
 * 为什么放在 build 里而不是靠人记得跑 precheck：需求阶段的自审容易被跳过，
 * 但"要构建了"是个绕不过去的动作。挂在这里，它就变成必经环节。
 * --no-check 可以显式跳过（用于调试流水线本身）。
 */
async function precheckGate(game) {
  const briefPath = path.join(game, 'game.brief.json');
  if (!fs.existsSync(briefPath)) return;   // 不是标准游戏目录，交给后面的流程报错

  let report = null;
  let gate1 = null;
  try {
    const { makeReport, checkBrief, checkSubmit } = await import('./precheck-lib.mjs');
    const { scoreBrief } = await import('./viral-dna-lib.mjs');
    const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
    const channel = brief.target === 'wechat' ? 'wechat' : 'taptap';
    report = makeReport();
    checkBrief(brief, channel, report);

    // 首次构建时 game.js 还没生成，跨游戏比对没有意义（也比不出东西）。
    // 一旦已有产物，就把 checkSubmit 也跑上：换皮 BLOCK 必须在构建时就拦，
    // 而不是拖到打包才报——那时已经白构建了一遍。
    const hasCode = fs.existsSync(path.join(game, 'game.js'));
    if (hasCode) {
      checkSubmit(game, channel, report);
    }

    const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(game, '.forge', 'state.json'), 'utf8')); } catch (e) { return {}; } })();
    gate1 = scoreBrief(brief, { offline: st.offline === true, iap: st.iap === true });
    report._submitChecked = hasCode;
  } catch (e) {
    // 自审自身出错不该挡构建——它是辅助，不是依赖
    console.log(`  ⚠ 构建前置自审没跑起来：${e.message}`);
    return;
  }

  const blocks = report.blocked;
  if (blocks.length) {
    console.error(`\n✗ 构建前置自审未通过（合规红线${report._submitChecked ? '，含跨游戏同质化比对' : ''}）：`);
    for (const b of blocks) console.error(`    ✗ ${b.msg}`);
    console.error('  这些问题不改，做出来也上不了架。用 --no-check 可强行跳过。\n');
    process.exit(4);
  }
  if (gate1) {
    console.log(`  · 基因 ${gate1.score}/${gate1.total}${gate1.verdict === 'suggest-drop' ? '（建议砍掉，但不阻断构建）' : ''}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.game && !args.all)) {
    console.log('用法:\n  node publish.mjs --target wechat|web --game <游戏目录> [--preview] [--strict] [--require-fps]\n  node publish.mjs --all [根目录] [--targets wechat,web] [--preview]');
    process.exit(args.help ? 0 : 1);
  }

  // 构建前置自审：合规有 BLOCK 就别浪费一次构建（改完还要重来）。
  // 基因层不拦——只有 WARN，只提示。
  if (!args.noCheck && args.game && !args.all) {
    await precheckGate(path.resolve(args.game));
  }

  if (args.all) {
    await runAll(args);
    return;
  }

  const target = args.target || 'wechat';
  if (target === 'web') {
    await runWeb(args);
    return;
  }
  if (target !== 'wechat') {
    console.error(`✗ 未知 target: ${target}（可选 wechat / web）`);
    process.exit(1);
  }

  const game = path.resolve(args.game);
  const out = path.resolve(args.out || path.join(game, 'targets', 'wechat'));
  const debugDir = out;

  /* 验收标准：优先命令行，其次 brief.json，最后用默认值 */
  const briefPath = path.resolve(args.brief || path.join(game, 'game.brief.json'));
  let brief = null;
  if (fs.existsSync(briefPath)) {
    try {
      brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
      log('0/6', `读取需求简报 ${path.basename(briefPath)}`);
    } catch (e) {
      fail(1, `brief 解析失败: ${briefPath} —— ${e.message}`);
    }
  } else if (args.brief) {
    fail(1, `指定的 brief 不存在: ${briefPath}`);
  }

  const acceptance = {
    mustReachPhase: (brief && brief.acceptance && brief.acceptance.mustReachPhase) || ['playing'],
    minFps: args.minFps || (brief && brief.acceptance && brief.acceptance.minFps) || 45,
    mustScore: (brief && brief.acceptance && brief.acceptance.mustScore) || 0
  };
  // AppID 优先级：命令行 > brief > touristappid
  const appid = args.appid || (brief && brief.channel && brief.channel.appid) || 'touristappid';
  if (appid === 'touristappid' && args.preview) {
    log('0/6', '⚠ 没有 AppID，预览会失败；请在 brief 里填 channel.appid 或传 --appid');
  }

  if (!fs.existsSync(path.join(game, 'dist', 'index.html'))) {
    fail(1, `${game} 里没有 dist/index.html —— 请先用 Game Studio 构建一次`);
  }

  const artifactDir = path.join(game, '.pipeline');
  fs.mkdirSync(artifactDir, { recursive: true });
  const report = { target, game, out, artifacts: artifactDir, brief: brief ? briefPath : null, acceptance, steps: [], assertions: [], ok: false };
  const t0 = Date.now();

  /* 1. 转换（带调试日志的验证包） */
  log('1/6', '转换（--debug 验证包）');
  const conv = runCli('node', [G2WX, '--src', game, '--out', debugDir, '--appid', appid, '--debug']);
  if (conv.code !== 0) fail(2, `转换失败:\n${conv.out.slice(0, 800)}`);
  report.steps.push({ step: 'convert', ok: true });
  log('1/6', '转换完成');

  /* 2. 导入 + 打开 */
  log('2/6', '导入并打开模拟器');
  requireOk(wt('project_import', ['--project', out]), 'project_import');
  wt('close_project_window', ['--project', out]);          // 可能本来没开，忽略结果
  await sleep(1200);
  requireOk(wt('open_project_window', ['--project', out]), 'open_project_window');
  await sleep(args.bootWaitMs);
  report.steps.push({ step: 'open', ok: true });

  /* 3. 读启动日志，拿视口尺寸 */
  log('3/6', '读取启动日志');
  let consoleText = '';
  let lines = [];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    consoleText = readConsole(out, 'grep -n g2wx');
    lines = parseConsoleLines(consoleText);
    if (lines.some((l) => /viewport/.test(l.text))) break;
    await sleep(3000);
  }
  if (lines.length === 0) {
    const errs = readConsole(out, 'grep -i -n error').slice(0, 600);
    fail(4, `模拟器里没有任何 [g2wx] 日志 —— 游戏没起来。console 片段:\n${errs || '(空)'}`);
  }

  const boot = lines.find((l) => /viewport/.test(l.text));
  const vp = boot ? /w=\s*(\d+)\s+h=\s*(\d+)/.exec(boot.text) : null;
  if (!vp) fail(4, '启动日志里没有视口信息，无法计算点击坐标');
  const bootOk = true;                     // 走到这里说明拿到了启动日志
  const vw = Number(vp[1]);
  const vh = Number(vp[2]);
  log('3/6', `视口 ${vw}×${vh}`);
  report.viewport = { w: vw, h: vh };

  /* 4. 点击开始 + 断言 */
  log('4/6', '自动试玩并断言');
  await wt('automation_game_action', ['--project', out, '--action', 'tap', '--x', String(Math.round(vw / 2)), '--y', String(Math.round(vh / 2))]);
  await sleep(3500);

  // 按住方向键走一段，验证摇杆与计分
  await wt('automation_game_action', ['--project', out, '--action', 'touchstart', '--x', String(Math.round(vw * 0.35)), '--y', String(Math.round(vh * 0.5))]);
  await wt('automation_game_action', ['--project', out, '--action', 'touchmove', '--x', String(Math.round(vw * 0.35 + 90)), '--y', String(Math.round(vh * 0.5 - 40))]);
  await sleep(2500);
  await wt('automation_game_action', ['--project', out, '--action', 'touchend', '--x', String(Math.round(vw * 0.35 + 90)), '--y', String(Math.round(vh * 0.5 - 40))]);

  consoleText = readConsole(out, 'grep -n "g2wx:state"');
  lines = parseConsoleLines(consoleText);
  const states = lines
    .map((l) => {
      const i = l.text.indexOf('{');
      if (i < 0) return null;
      try { return JSON.parse(l.text.slice(i)); } catch (e) { return null; }
    })
    .filter(Boolean);

  if (states.length === 0) fail(4, '没有拿到 [g2wx:state] 状态日志 —— 断言无法进行');

  const phases = [...new Set(states.map((s) => s.phase))];
  const maxScore = Math.max(...states.map((s) => s.score || 0));
  const last = states[states.length - 1];
  const fpsList = states.map((s) => s.fps || 0).filter((n) => n > 0);
  const minFps = fpsList.length ? Math.min(...fpsList) : 0;
  // 冷启动那几帧本来就慢（模拟器还在编译），断言看稳态：丢掉前 3 个采样后取中位数
  const warm = fpsList.slice(3);
  const sorted = (warm.length ? warm : fpsList).slice().sort((a, b) => a - b);
  const steadyFps = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  const reachedAll = acceptance.mustReachPhase.every((p) => phases.includes(p));
  const assertions = [
    { name: '游戏启动', ok: bootOk, detail: `${vw}×${vh}` },
    { name: '经过 ' + acceptance.mustReachPhase.join('/'), ok: reachedAll, detail: `phases=${phases.join(',')}` },
    {
      name: 'fps ≥ ' + acceptance.minFps,
      ok: steadyFps >= acceptance.minFps,
      soft: !args.requireFps,            // 默认只告警：后台窗口会被 Chromium 节流到 ~20fps
      detail: `稳态中位数=${steadyFps} 最低=${minFps} 采样=${fpsList.length}`
    },
    { name: 'fps 未塌方（≥10）', ok: steadyFps >= 10, detail: `稳态中位数=${steadyFps}` },
    { name: '状态可读', ok: !!last && typeof last.hearts === 'number', detail: JSON.stringify({ phase: last.phase, hearts: last.hearts, score: last.score }) }
  ];
  if (acceptance.mustScore > 0) {
    assertions.push({ name: '分数 ≥ ' + acceptance.mustScore, ok: maxScore >= acceptance.mustScore, detail: `max=${maxScore}` });
  }
  report.assertions = assertions;
  report.gameplay = { phases, maxScore, minFps, steadyFps, lastState: last };

  for (const a of assertions) log('4/6', `${a.ok ? '✓' : '✗'} ${a.name}（${a.detail}）`);

  const errText = readConsole(out, "grep -i -n error | grep -v 'HarmonyOS'");
  const errorLines = parseConsoleLines(errText);
  if (errorLines.length) {
    report.consoleErrors = errorLines.slice(0, 10);
    log('4/6', `⚠ console 有 ${errorLines.length} 条 error（可能是历史遗留，加 --strict 会判失败）`);
  }

  const hardFail = assertions.filter((a) => !a.ok && !a.soft);
  const softFail = assertions.filter((a) => !a.ok && a.soft);
  report.softWarnings = softFail.map((a) => `${a.name}（${a.detail}）`);
  for (const a of softFail) log('4/6', `⚠ ${a.name} 未达标（${a.detail}）—— 视为警告，不影响通过`);
  if (hardFail.length) {
    report.ok = false;
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
    fail(4, `断言失败：${hardFail.map((a) => a.name).join('、')}`);
  }
  if (args.strict && errorLines.length) {
    fail(4, `--strict 模式下 console 有 error（${errorLines.length} 条）`);
  }

  /* 5. 截图存档 */
  log('5/6', '截图存档');
  const shotDir = artifactDir;
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = wt('simulator_screenshot', ['--project', out]);
  const shotPath = shot && shot.result && shot.result.path;
  if (shotPath) {
    try {
      const dest = path.join(shotDir, `debug-${Date.now()}.jpg`);
      fs.copyFileSync(shotPath, dest);
      report.screenshot = dest;
      log('5/6', `已保存 ${path.relative(process.cwd(), dest)}`);
    } catch (e) {
      log('5/6', `⚠ 截图拷贝失败（${e.code || e.message}），跳过`);
    }
  } else {
    log('5/6', '⚠ 没有拿到截图');
  }

  /* 6. 重新构建生产包（无调试输出） */
  log('6/6', '重建生产包');
  const rel = runCli('node', [G2WX, '--src', game, '--out', out, '--appid', appid]);
  if (rel.code !== 0) fail(2, `生产包重建失败:\n${rel.out.slice(0, 600)}`);
  await wt('simulator_refresh', ['--project', out]);
  await sleep(7000);

  const shot2 = wt('simulator_screenshot', ['--project', out]);
  const shot2Path = shot2 && shot2.result && shot2.result.path;
  if (shot2Path) {
    try {
      const dest = path.join(shotDir, `release-${Date.now()}.jpg`);
      fs.copyFileSync(shot2Path, dest);
      report.releaseScreenshot = dest;
    } catch (e) {
      log('6/6', `⚠ 生产包截图拷贝失败（${e.code || e.message}），跳过`);
    }
  }

  /* 7. 预览 */
  if (args.preview) {
    log('6/6', '生成预览');
    const qrOut = path.join(shotDir, 'qrcode.jpg');
    const qr = wt('create_preview_qrcode', ['--project', out, '--qr-format', 'image', '--qr-output', qrOut]);
    requireOk(qr, 'create_preview_qrcode');
    if (!fs.existsSync(qrOut)) fail(3, `预览生成成功但二维码文件不存在: ${qrOut}`);
    report.qrcode = qrOut;
    log('6/6', `二维码 ${path.relative(process.cwd(), qrOut)}（${Math.round(fs.statSync(qrOut).size / 1024)} KB）`);
  }

  if (args.upload) {
    log('6/6', '上传体验版');
    const up = wt('upload', ['--project', out]);
    const r = up && up.result;
    if (r && r.status === 'pending') {
      log('6/6', `⚠ 上传需要你在开发者工具内确认（taskId=${r.taskId}）`);
      report.uploadPending = r.taskId;
    } else {
      requireOk(up, 'upload');
      report.uploaded = true;
    }
  }

  if (!args.keepOpen) {
    wt('close_project_window', ['--project', out]);
  }

  report.ok = true;
  report.elapsedMs = Date.now() - t0;
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));

  console.log(`\n✓ 流水线通过（${(report.elapsedMs / 1000).toFixed(1)}s）`);
  console.log(`  阶段: ${phases.join(' → ')}  fps 最低 ${minFps}  最高分 ${maxScore}`);
  if (report.qrcode) console.log(`  二维码: ${report.qrcode}`);
  console.log(`  报告: ${path.relative(process.cwd(), path.join(artifactDir, 'report.json'))}`);
}

main().catch((e) => {
  console.error('✗ 未捕获异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
