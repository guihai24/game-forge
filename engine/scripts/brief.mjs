#!/usr/bin/env node
/* brief.mjs —— 需求落盘与校验。
 *
 * 需求梳理的结论写进 brief.json，后面 publish 拿它当断言来源，
 * 而不是靠 agent 记住"用户说要 60 秒 3 条命"。
 *
 * 用法：
 *   node brief.mjs init  --out <游戏目录>/game.brief.json --title 月夜狐灯 --target wechat
 *   node brief.mjs check --file <游戏目录>/game.brief.json
 *
 * 退出码：0 通过 ｜ 1 校验失败 ｜ 2 参数/IO 错误
 */

import fs from 'node:fs';
import path from 'node:path';

const TEMPLATE = {
  version: 1,
  title: '',
  genre: '',
  target: 'wechat',
  // 「势」的输入层：情绪主题会过期，所以不硬编码进规则，只作为每次立项的输入。
  // 见 references/rules/viral-dna-rules.md §四。
  emotion_theme: '',
  trend_evidence: '',
  rules: {},
  acceptance: {
    mustReachPhase: ['playing'],
    minFps: 45,
    mustScore: 0
  },
  channel: {
    appid: '',
    orientation: 'landscape'
  },
  notes: ''
};

function parseArgs(argv) {
  const o = { target: 'wechat', orientation: 'landscape' };
  o.cmd = argv[2];
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--title') o.title = argv[++i];
    else if (a === '--genre') o.genre = argv[++i];
    else if (a === '--target') o.target = argv[++i];
    else if (a === '--appid') o.appid = argv[++i];
    else if (a === '--orientation') o.orientation = argv[++i];
    else if (a === '--emotion-theme') o.emotionTheme = argv[++i];
    else if (a === '--trend-evidence') o.trendEvidence = argv[++i];
    else if (a === '--notes') o.notes = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

function usage() {
  console.log(`用法:
  node brief.mjs init  --out <路径> [--title T] [--genre G] [--target wechat|web] [--appid ID] [--orientation landscape|portrait]
                       [--emotion-theme <情绪主题>] [--trend-evidence <势的依据>]
  node brief.mjs check --file <路径>`);
}

function init(args) {
  if (!args.out) {
    usage();
    process.exit(2);
  }
  const out = path.resolve(args.out);
  if (fs.existsSync(out)) {
    console.error(`✗ ${out} 已存在，不覆盖。要重建先删掉它。`);
    process.exit(2);
  }
  const brief = structuredClone(TEMPLATE);
  if (args.title) brief.title = args.title;
  if (args.genre) brief.genre = args.genre;
  if (args.target) brief.target = args.target;
  if (args.orientation) brief.channel.orientation = args.orientation;
  if (args.appid) brief.channel.appid = args.appid;
  if (args.emotionTheme) brief.emotion_theme = args.emotionTheme;
  if (args.trendEvidence) brief.trend_evidence = args.trendEvidence;
  if (args.notes) brief.notes = args.notes;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(brief, null, 2) + '\n', 'utf8');
  console.log(`✓ 已生成 ${out}`);
  console.log('  下一步把 title / genre / rules / acceptance 补全，再跑 brief.mjs check');
}

function validate(brief) {
  const errors = [];
  const warnings = [];

  if (!brief || typeof brief !== 'object') {
    return { errors: ['brief 不是合法 JSON 对象'], warnings };
  }
  if (brief.version !== 1) errors.push(`version 必须是 1，当前 ${brief.version}`);
  if (!brief.title || !String(brief.title).trim()) errors.push('title 不能为空');
  if (!brief.genre || !String(brief.genre).trim()) errors.push('genre 不能为空（是什么类型的游戏）');
  if (!['wechat', 'web'].includes(brief.target)) errors.push(`target 必须是 wechat 或 web，当前 ${brief.target}`);

  const acc = brief.acceptance || {};
  if (!Array.isArray(acc.mustReachPhase) || acc.mustReachPhase.length === 0) {
    errors.push('acceptance.mustReachPhase 至少要有一个阶段（通常是 playing）');
  }
  if (typeof acc.minFps !== 'number' || acc.minFps <= 0) errors.push('acceptance.minFps 必须是正数');

  const ch = brief.channel || {};
  if (brief.target === 'wechat') {
    if (!ch.appid) warnings.push('channel.appid 为空 —— 只能跑模拟器，不能预览/上传');
    if (!['landscape', 'portrait'].includes(ch.orientation)) {
      errors.push('channel.orientation 必须是 landscape 或 portrait');
    }
  }

  return { errors, warnings };
}

function check(args) {
  if (!args.file) {
    usage();
    process.exit(2);
  }
  const file = path.resolve(args.file);
  let brief;
  try {
    brief = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`✗ 读不了 ${file}: ${e.message}`);
    process.exit(2);
  }
  const { errors, warnings } = validate(brief);
  console.log(`\n需求简报 ${path.basename(file)}\n`);
  console.log(`  游戏    ${brief.title || '(未填)'}  ·  ${brief.genre || '(未填)'}`);
  console.log(`  渠道    ${brief.target}`);
  console.log(`  方向    ${(brief.channel && brief.channel.orientation) || '-'}`);
  console.log(`  验收    ${(brief.acceptance && brief.acceptance.mustReachPhase || []).join(' → ')}`
    + `  ·  fps ≥ ${(brief.acceptance && brief.acceptance.minFps) || '-'}`
    + `  ·  分数 ≥ ${(brief.acceptance && brief.acceptance.mustScore) || 0}`);
  for (const w of warnings) console.log(`\n  ⚠ ${w}`);
  if (errors.length) {
    console.log('');
    for (const e of errors) console.log(`  ✗ ${e}`);
    console.log('');
    process.exit(1);
  }
  console.log('\n  ✓ 校验通过\n');
}

const args = parseArgs(process.argv);
if (args.help || !args.cmd) {
  usage();
  process.exit(args.help ? 0 : 2);
}
if (args.cmd === 'init') init(args);
else if (args.cmd === 'check') check(args);
else {
  usage();
  process.exit(2);
}
