#!/usr/bin/env node
/* doctor.mjs —— game-forge 环境自检。
 *
 * 在跑 pipeline 之前先跑这个：它把这次会话里踩过的所有环境问题前置成一次检查。
 *
 * 用法：
 *   node doctor.mjs [--client DeepSeekHarness] [--json]
 *
 * 退出码：0 可用（可能有警告）｜ 1 有阻塞项
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, makeWt, isOk, errorText, resolvePlaywright } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILL = '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/wechatide-skill';
const INSTALLED_SKILL = path.join(os.homedir(), '.agents', 'skills', 'wechatide-skill');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const o = { client: process.env.WECHATIDE_CLIENT || 'DeepSeekHarness', json: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--client') o.client = argv[++i];
    else if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '-h' || argv[i] === '--help') o.help = true;
  }
  return o;
}

function skillVersion(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const m = /^version:\s*(.+)$/m.exec(text);
    return m ? m[1].trim() : null;
  } catch (e) {
    return null;
  }
}

function cmpVersion(a, b) {
  if (!a || !b) return null;
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node doctor.mjs [--client DeepSeekHarness] [--json]');
    process.exit(0);
  }

  const checks = [];
  const add = (name, ok, level, detail, hint) => checks.push({ name, ok, level, detail, hint });

  /* 1. Node */
  const major = Number(process.versions.node.split('.')[0]);
  add('Node 版本', major >= 20, major >= 20 ? 'ok' : 'block', `v${process.versions.node}`, '需要 Node 20 以上');

  /* 2. 本 skill 的脚本齐全 */
  const required = [
    ['doctor.mjs', ''],
    ['publish.mjs', ''],
    ['brief.mjs', ''],
    ['lib.mjs', ''],
    ['g2wx.mjs', 'targets/wechat'],
    ['wx-shim.js', 'targets/wechat'],
    ['build.mjs', 'targets/web'],
    ['verify.mjs', 'targets/web']
  ];
  const missing = required
    .filter(([f, rel]) => !fs.existsSync(path.join(HERE, rel, f)))
    .map(([f, rel]) => (rel ? `${rel}/${f}` : f));
  add('skill 脚本完整', missing.length === 0, missing.length ? 'block' : 'ok',
    missing.length ? `缺 ${missing.join(', ')}` : 'doctor / publish / brief / lib / 两个 target 均就位');

  /* 3. 无头 Chrome（栅格化 SVG 用） */
  const hasChrome = fs.existsSync(CHROME);
  add('无头 Chrome', hasChrome, hasChrome ? 'ok' : 'block',
    hasChrome ? CHROME : `找不到 ${CHROME}`,
    'SVG 素材必须栅格化；装了 Chrome 或设置 CHROME_PATH');

  /* 3b. playwright-core（网页渠道验证用） */
  const pw = resolvePlaywright();
  add('playwright-core', !!pw, pw ? 'ok' : 'warn',
    pw || '找不到 —— 网页渠道的自动验证不可用',
    pw ? undefined : '设置 PLAYWRIGHT_CORE=<目录>，或在任意 node_modules 里装 playwright-core');

  /* 4. wechatide CLI */
  const which = runCli('which', ['wechatide']);
  const hasCli = which.code === 0 && which.out.trim().length > 0;
  add('wechatide 命令', hasCli, hasCli ? 'ok' : 'block',
    hasCli ? which.out.trim() : '不在 PATH 里，先安装微信开发者工具');

  /* 5. 开发者工具 skill 版本是否同步 */
  const builtinV = skillVersion(BUILTIN_SKILL);
  const installedV = skillVersion(INSTALLED_SKILL);
  const sameVer = builtinV && installedV && builtinV === installedV;
  add('wechatide-skill 版本', !!sameVer, sameVer ? 'ok' : 'warn',
    `内置 ${builtinV || '?'} / 本地 ${installedV || '?'}`,
    sameVer ? undefined : `同步：rsync -a --delete "${BUILTIN_SKILL}/" "${INSTALLED_SKILL}/"`);

  /* 6. 登录态 / 版本关系 */
  if (hasCli) {
    const wt = makeWt(args.client);
    const st = wt('check_wechatide_status', ['--skill-version', installedV || builtinV || '0.0.0']);
    if (!isOk(st)) {
      add('开发者工具连接', false, 'block', errorText(st).slice(0, 160), '打开微信开发者工具后重试');
    } else {
      const r = st.result || {};
      add('开发者工具连接', true, 'ok', `client=${args.client}`);
      add('登录态', r.loginExpired === false, r.loginExpired === false ? 'ok' : 'block',
        r.loginExpired === false ? `已登录（${(r.loginUser && r.loginUser.nickName) || '?'}）` : '登录已过期',
        '用 wechatide login 扫码');
      const rel = r.versionRelation;
      add('skill 版本关系', rel === 'equal' || rel === 'agent_ahead', rel === 'equal' || rel === 'agent_ahead' ? 'ok' : 'warn',
        String(rel),
        rel === 'equal' ? undefined : '本地 skill 落后于内置版本，按上一条同步');
    }

    /* 7. 小游戏 AppID */
    const ids = wt('get_user_appids', ['--type', 'minigame']);
    if (!isOk(ids)) {
      add('小游戏 AppID', false, 'warn', errorText(ids).slice(0, 160), '可能需要重新登录');
    } else {
      const list = (ids.result && ids.result.appIds) || [];
      const testOnly = list.length > 0 && list.every((a) => /测试号|test/i.test(a.appName || ''));
      add('小游戏 AppID', list.length > 0, list.length ? (testOnly ? 'warn' : 'ok') : 'warn',
        list.length ? list.map((a) => `${a.appID}（${a.appName}）`).join('；') : '没有可用的小游戏 AppID',
        testOnly ? '测试号只能预览、不能上传体验版；要上传需正式小游戏 AppID' : undefined);
    }
  }

  /* 输出 */
  if (args.json) {
    console.log(JSON.stringify({ checks }, null, 2));
  } else {
    console.log('\ngame-forge 环境自检\n');
    const mark = { ok: '✓', warn: '⚠', block: '✗' };
    for (const c of checks) {
      console.log(`  ${mark[c.level] || '?'} ${c.name.padEnd(18)} ${c.detail}`);
      if (c.level !== 'ok' && c.hint) console.log(`      → ${c.hint}`);
    }
    const blocks = checks.filter((c) => c.level === 'block' && !c.ok);
    const warns = checks.filter((c) => c.level === 'warn');
    console.log('');
    if (blocks.length) console.log(`  阻塞项 ${blocks.length} 个，pipeline 无法运行。\n`);
    else if (warns.length) console.log(`  可用，但有 ${warns.length} 个警告。\n`);
    else console.log('  全部通过，可以跑 pipeline。\n');
  }

  process.exit(checks.some((c) => c.level === 'block' && !c.ok) ? 1 : 0);
}

main().catch((e) => {
  console.error('✗ doctor 异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
