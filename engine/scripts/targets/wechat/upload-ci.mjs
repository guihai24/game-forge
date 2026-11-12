#!/usr/bin/env node
/* upload-ci.mjs —— 用 miniprogram-ci 上传小游戏开发版（不需要开发者工具窗口）
 *
 * 为什么不用 `wechatide upload`：那条路依赖开发者工具的登录态，登录过期要扫码；
 * 这条路只要一把「代码上传密钥」，适合无人值守和批量。
 *
 * 用法：
 *   node upload-ci.mjs --project <g2wx 产物目录> --appid <AppID> --version <1.0.0> [--desc "说明"]
 *
 * 密钥查找顺序：
 *   1. --key <path>
 *   2. 环境变量 WECHAT_UPLOAD_KEY
 *   3. <project>/.forge/private.key
 *   4. ~/.config/game-forge/<appid>.key
 *
 * 退出码：
 *   0  上传成功
 *   1  参数/环境错误（缺密钥、目录不对、没装 miniprogram-ci）
 *   2  密钥无效或鉴权失败（20002 / 41001 / 40xxx）
 *   3  上传失败（含包体超限）
 *
 * 密钥只在进程内使用，不打印、不写日志。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const o = { version: '', desc: '', appid: '', project: '', key: '', robot: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') o.project = argv[++i];
    else if (a === '--appid') o.appid = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--desc') o.desc = argv[++i];
    else if (a === '--key') o.key = argv[++i];
    else if (a === '--robot') o.robot = Number(argv[++i]) || null;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return o;
}

/** 按顺序找一个可读的密钥文件；找不到返回 null */
function findKey(args) {
  const candidates = [
    args.key,
    process.env.WECHAT_UPLOAD_KEY,
    args.project && path.join(args.project, '.forge', 'private.key'),
    args.appid && path.join(os.homedir(), '.config', 'game-forge', `${args.appid}.key`)
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (e) { /* 下一个 */ }
  }
  return null;
}

/** 把 miniprogram-ci 的错误码翻译成能行动的提示 */
function explain(err) {
  const msg = String((err && err.message) || err);
  if (/20002|local signature/i.test(msg)) {
    return '密钥文件不是微信下发的格式。请到 MP「管理 → 开发管理 → 开发设置 → 小程序代码上传」重新下载，不要用 openssl 自己生成。';
  }
  if (/41001|access_token/i.test(msg)) {
    return '服务端没认这把密钥。确认密钥属于这个 AppID，且没有在后台被重置。';
  }
  if (/80051|超过|size/i.test(msg)) {
    return '包体超限。小游戏主包 ≤4MB、总包 ≤30MB，先看 g2wx 报告里的体积。';
  }
  if (/IP|ip/i.test(msg)) {
    return '这台机器的出口 IP 不在该 AppID 的白名单里。要么加白名单，要么关掉 IP 限制。';
  }
  return msg;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log('用法: node upload-ci.mjs --project <目录> --appid <AppID> --version <版本号> [--desc 说明] [--key 密钥路径] [--robot 1-30]');
    return 0;
  }

  const missing = ['project', 'appid', 'version'].filter((k) => !args[k]);
  if (missing.length) {
    console.error(`✗ 缺少参数: ${missing.map((k) => `--${k}`).join(' ')}`);
    return 1;
  }
  if (!fs.existsSync(args.project)) {
    console.error(`✗ 项目目录不存在: ${args.project}`);
    return 1;
  }
  const cfgPath = path.join(args.project, 'project.config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error(`✗ ${args.project} 里没有 project.config.json，不是 g2wx 产物目录`);
    return 1;
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (cfg.compileType !== 'game') {
    console.error(`✗ project.config.json 的 compileType 是 "${cfg.compileType}"，小游戏要求 "game"`);
    return 1;
  }

  const keyPath = findKey(args);
  if (!keyPath) {
    console.error('✗ 找不到代码上传密钥。用 --key 指定，或设 WECHAT_UPLOAD_KEY，');
    console.error('  或放到 <project>/.forge/private.key，或 ~/.config/game-forge/<appid>.key');
    console.error('  密钥在 MP「管理 → 开发管理 → 开发设置 → 小程序代码上传」生成');
    return 1;
  }

  let ci;
  try {
    ci = (await import('miniprogram-ci')).default;
  } catch (e) {
    console.error('✗ 没装 miniprogram-ci。在流水线目录执行: npm i miniprogram-ci');
    return 1;
  }

  const project = new ci.Project({
    appid: args.appid,
    type: 'miniGame',
    projectPath: path.resolve(args.project),
    privateKeyPath: path.resolve(keyPath),
    ignores: ['node_modules/**/*', '.forge/**/*', '.pipeline/**/*']
  });

  console.log(`[upload] ${args.appid} v${args.version} ← ${path.relative(process.cwd(), args.project)}`);
  let lastPct = -1;
  try {
    const result = await ci.upload({
      project,
      version: args.version,
      desc: args.desc || `game-forge ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      ...(args.robot ? { robot: args.robot } : {}),
      onProgressUpdate: (p) => {
        const pct = typeof p === 'object' && p ? Number(p.percentage ?? p.totalPercentage) : Number(p);
        const step = Number.isFinite(pct) ? Math.floor(pct) : null;
        if (step !== null && step !== lastPct && step % 20 === 0) {
          lastPct = step;
          console.log(`[upload] ${step}%`);
        }
      }
    });
    const full = (result.subPackageInfo || []).find((p) => p.name === '__FULL__');
    const size = full ? `，整包 ${Math.round(full.size / 1024)} KB` : '';
    console.log(`✓ 已上传开发版${size}`);
    console.log('  下一步是人工：MP 后台「版本管理」设为体验版 → 提交审核（提审没有开放接口）');
    return 0;
  } catch (e) {
    const msg = explain(e);
    const code = /20002|41001|access_token|signature/i.test(String(e && e.message)) ? 2 : 3;
    console.error(`\n✗ 上传失败：${msg}`);
    return code;
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`✗ ${e && e.message ? e.message : e}`);
  process.exit(1);
});
