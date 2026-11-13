#!/usr/bin/env node
/* precheck.mjs —— 上架前自审（CLI 外壳）。
 *
 * 判定逻辑在 precheck-lib.mjs，和 DSH 面板共用同一份，避免规则漂移。
 *
 * 两个阶段：
 *   --brief   需求阶段。还没写代码时查，用来纠正需求、避免沉没成本。
 *   --game    提交前。全量查，包含跨游戏同质化比对。
 *
 * 用法：
 *   node precheck.mjs --brief <game.brief.json> [--channel taptap|wechat]
 *   node precheck.mjs --game <游戏目录> [--channel taptap|wechat] [--json]
 *
 * 退出码：
 *   0  没有 BLOCK
 *   1  参数/文件错误
 *   2  有 BLOCK —— 不要继续
 *
 * 规则来源：references/rules/channel-rules.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeReport, checkBrief, checkSubmit, readJson } from './precheck-lib.mjs';

function parseArgs(argv) {
  const o = { channel: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--brief') o.brief = argv[++i];
    else if (a === '--game') o.game = argv[++i];
    else if (a === '--channel') o.channel = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return o;
}

function printReport(report, ctx) {
  const icon = { BLOCK: '✗', WARN: '⚠', INFO: '·' };
  const color = { BLOCK: '\x1b[31m', WARN: '\x1b[33m', INFO: '\x1b[90m' };
  const reset = '\x1b[0m';

  console.log(`\n自审：${ctx}　规则见 references/rules/channel-rules.md\n`);
  if (!report.items.length) {
    console.log('✓ 没有发现问题');
    return;
  }
  for (const i of report.items) {
    const c = color[i.level] || '';
    console.log(`${c}${icon[i.level]} [${i.level}] ${i.msg}${reset}`);
    if (i.hint) console.log(`    → ${i.hint}`);
  }
  const b = report.blocked.length;
  const w = report.warned.length;
  console.log(`\n${b ? `✗ ${b} 项阻断` : '✓ 无阻断'}${w ? `，${w} 项警告` : ''}`);
  if (b) console.log('  这些问题不解决，提交后大概率被拒或封号。先改，不要继续。');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法:\n  node precheck.mjs --brief <game.brief.json> [--channel taptap|wechat]\n  node precheck.mjs --game <游戏目录> [--channel taptap|wechat] [--json]');
    return 0;
  }

  const report = makeReport();

  if (args.brief) {
    const brief = readJson(args.brief);
    if (!brief) { console.error(`✗ 读不到 ${args.brief}`); return 1; }
    checkBrief(brief, args.channel, report);
    if (args.json) console.log(JSON.stringify({ ok: !report.blocked.length, items: report.items }, null, 2));
    else printReport(report, `需求 ${path.basename(args.brief)}${args.channel ? ` · ${args.channel}` : ''}`);
    return report.blocked.length ? 2 : 0;
  }

  if (args.game) {
    const dir = path.resolve(args.game);
    if (!fs.existsSync(path.join(dir, 'game.brief.json'))) {
      console.error(`✗ ${args.game} 里没有 game.brief.json`);
      return 1;
    }
    const self = checkSubmit(dir, args.channel, report);
    if (args.json) {
      console.log(JSON.stringify({
        ok: !report.blocked.length,
        game: self.title,
        codeHash: self.codeHash,
        items: report.items
      }, null, 2));
    } else {
      printReport(report, `提交前 ${self.title}${args.channel ? ` · ${args.channel}` : ''}`);
    }
    return report.blocked.length ? 2 : 0;
  }

  console.error('✗ 需要 --brief 或 --game');
  return 1;
}

process.exit(main());
