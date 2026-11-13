#!/usr/bin/env node
/* precheck.mjs —— 上架前自审（CLI 外壳）。
 *
 * 两层：
 *   第一层 合规自审（channel-rules.md）—— 答"能不能上架"
 *   第二层 爆款基因（viral-dna-rules.md）—— 答"值不值得上架"
 *
 * 判定逻辑在 precheck-lib.mjs / viral-dna-lib.mjs / viral-probe.mjs，
 * 和 DSH 面板共用同一份，避免规则漂移。
 *
 * 用法：
 *   node precheck.mjs --brief <game.brief.json> [--channel taptap|wechat] [--json]
 *   node precheck.mjs --game <游戏目录> [--channel taptap|wechat] [--json] [--no-probe]
 *
 * 退出码：
 *   0  没有 BLOCK（基因项的 WARN 不影响退出码）
 *   1  参数/文件错误
 *   2  有 BLOCK —— 不要继续
 *
 * 规则来源：references/rules/channel-rules.md + references/rules/viral-dna-rules.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeReport, checkBrief, checkSubmit, readJson } from './precheck-lib.mjs';
import { scoreBrief } from './viral-dna-lib.mjs';
import { runProbe } from './viral-probe.mjs';

function parseArgs(argv) {
  const o = { channel: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--brief') o.brief = argv[++i];
    else if (a === '--game') o.game = argv[++i];
    else if (a === '--channel') o.channel = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--no-probe') o.noProbe = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return o;
}

const COLOR = { BLOCK: '\x1b[31m', WARN: '\x1b[33m', INFO: '\x1b[90m', OK: '\x1b[32m' };
const RESET = '\x1b[0m';

function printCompliance(report) {
  const icon = { BLOCK: '✗', WARN: '⚠', INFO: '·' };
  console.log('合规（能不能上架）　规则见 references/rules/channel-rules.md\n');
  if (!report.items.length) {
    console.log('  ✓ 没有发现问题');
    return;
  }
  for (const i of report.items) {
    const c = COLOR[i.level] || '';
    console.log(`  ${c}${icon[i.level]} [${i.level}] ${i.msg}${RESET}`);
    if (i.hint) console.log(`      → ${i.hint}`);
  }
  const b = report.blocked.length;
  const w = report.warned.length;
  console.log(`\n  ${b ? `✗ ${b} 项阻断` : '✓ 无阻断'}${w ? `，${w} 项警告` : ''}`);
  if (b) console.log('  这些问题不解决，提交后大概率被拒或封号。先改，不要继续。');
}

function printGate1(g1) {
  console.log(`\n基因（值不值得上架）　规则见 references/rules/viral-dna-rules.md\n`);
  console.log(`  viral-dna score: ${g1.score}/${g1.total}\n`);
  for (const i of g1.items) {
    const mark = i.ok ? `${COLOR.OK}✓${RESET}` : (i.needsHuman ? `${COLOR.INFO}?${RESET}` : `${COLOR.WARN}⚠${RESET}`);
    console.log(`  ${mark} [${i.id}] ${i.label}　${i.detail}`);
  }
  const human = g1.failed.filter((i) => i.needsHuman);
  if (human.length) {
    console.log(`\n  需人工确认 ${human.length} 项：${human.map((i) => i.id).join('、')}`);
  }
  if (g1.verdict === 'suggest-drop') {
    console.log(`\n  ${COLOR.WARN}⚠ ${g1.note}${RESET}`);
    console.log('    这是建议，不是阻断——批量试错的意义在于允许失败。');
  } else {
    console.log(`\n  ✓ ${g1.note}`);
  }
}

function printGate2(g2, probed) {
  console.log('\n产物实测（不采信 brief 自述）\n');
  if (!probed) {
    console.log('  · 没有构建产物，跳过实测。先 build 一次再跑。');
    return;
  }
  for (const i of g2.items) {
    const mark = i.ok ? `${COLOR.OK}✓${RESET}` : (i.level === 'INFO' ? `${COLOR.INFO}·${RESET}` : `${COLOR.WARN}⚠${RESET}`);
    console.log(`  ${mark} [${i.id}] ${i.label}　${i.detail}`);
    if (!i.ok && i.hint) console.log(`      → ${i.hint}`);
  }
  console.log(`\n  ${g2.summary}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法:\n  node precheck.mjs --brief <game.brief.json> [--channel taptap|wechat] [--json]\n  node precheck.mjs --game <游戏目录> [--channel taptap|wechat] [--json] [--no-probe]');
    return 0;
  }

  const report = makeReport();

  /* ---------- 需求阶段：合规 + Gate 1 ---------- */
  if (args.brief) {
    const brief = readJson(args.brief);
    if (!brief) { console.error(`✗ 读不到 ${args.brief}`); return 1; }
    checkBrief(brief, args.channel, report);
    const gate1 = scoreBrief(brief);

    if (args.json) {
      console.log(JSON.stringify({
        stage: 'brief',
        compliance: { ok: !report.blocked.length, items: report.items },
        viralDna: gate1
      }, null, 2));
    } else {
      console.log(`\n自审：需求 ${path.basename(args.brief)}${args.channel ? ` · ${args.channel}` : ''}`);
      console.log('='.repeat(56));
      printCompliance(report);
      printGate1(gate1);
      console.log('');
    }
    // 基因项不参与退出码
    return report.blocked.length ? 2 : 0;
  }

  /* ---------- 提交前：合规 + Gate 1 + Gate 2 ---------- */
  if (args.game) {
    const dir = path.resolve(args.game);
    const briefPath = path.join(dir, 'game.brief.json');
    if (!fs.existsSync(briefPath)) {
      console.error(`✗ ${args.game} 里没有 game.brief.json`);
      return 1;
    }
    const brief = readJson(briefPath) || {};
    const self = checkSubmit(dir, args.channel, report);
    const gate1 = scoreBrief(brief);

    let gate2 = null;
    let probed = false;
    if (!args.noProbe) {
      try {
        gate2 = await runProbe(dir, { seconds: 12 });
        probed = gate2.probed;
      } catch (e) {
        gate2 = { items: [], probed: false, ok: false, failed: 0, summary: `实测没跑起来：${e.message}` };
      }
    }

    if (args.json) {
      console.log(JSON.stringify({
        stage: 'submit',
        game: self.title,
        codeHash: self.codeHash,
        compliance: { ok: !report.blocked.length, items: report.items },
        viralDna: gate1,
        probe: gate2
      }, null, 2));
    } else {
      console.log(`\n自审：提交前 ${self.title}${args.channel ? ` · ${args.channel}` : ''}`);
      console.log('='.repeat(56));
      printCompliance(report);
      printGate1(gate1);
      if (gate2) printGate2(gate2, probed);
      console.log('');
    }
    return report.blocked.length ? 2 : 0;
  }

  console.error('✗ 需要 --brief 或 --game');
  return 1;
}

process.exit(await main());
