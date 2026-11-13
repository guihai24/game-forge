#!/usr/bin/env node
/* taptap.mjs —— TapTap H5 渠道：打包、上传、提审、查状态。
 *
 * 这是唯一一条能全链路脚本化的渠道：建游戏、传包、备案、提审、定时上线都有 CLI。
 * 微信的提审没有开放接口（87006 小游戏不能提交），所以这里是平台的主处理器。
 *
 * 用法：
 *   node taptap.mjs build  --game <目录> [--name <slug>]
 *   node taptap.mjs upload --game <目录> --dev-id <id> --app-id <id> [--dry-run] [--yes]
 *   node taptap.mjs status --dev-id <id> --app-id <id>
 *   node taptap.mjs review --game <目录> --dev-id <id> --app-id <id> [--dry-run] [--yes]
 *
 * 凭据：taptap-cli 自己管（~/.taptap-cli/taptap.json 或 TAPTAP_CLI_TOKEN）。
 * 首次需要人点一次 device-code 授权；之后可无人值守。
 *
 * 退出码：0 成功 ｜ 1 参数/环境 ｜ 2 打包失败 ｜ 3 CLI 调用失败 ｜ 4 渠道拒绝
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { dryRun: false, yes: false };
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--game') o.game = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--dev-id') o.devId = argv[++i];
    else if (a === '--app-id') o.appId = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return o;
}

/** 找 taptap-cli：PATH → 常见安装位置 → 项目内。 */
function findCli() {
  const candidates = [
    process.env.TAPTAP_CLI,
    'taptap-cli',
    path.join(process.env.HOME || '', '.local', 'bin', 'taptap-cli'),
    '/tmp/claude-verify/auto5/tapcli/node_modules/.bin/taptap-cli'
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['version'], { encoding: 'utf8', timeout: 8000 });
      if (r.status === 0 && /taptap\/cli/i.test(r.stdout || '')) return c;
    } catch (e) { /* 下一个 */ }
  }
  return null;
}

/** 跑 taptap-cli，统一解析 JSON envelope。 */
function run(cli, args, opts = {}) {
  const r = spawnSync(cli, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeout || 180000
  });
  const out = (r.stdout || '') + (r.stderr || '');
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch (e) {
    const start = out.indexOf('{');
    if (start >= 0) { try { json = JSON.parse(out.slice(start)); } catch (e2) { /* 忽略 */ } }
  }
  return { code: r.status, out, json };
}

const USAGE = `taptap H5 渠道

  node taptap.mjs build  --game <目录> [--name <slug>]
  node taptap.mjs upload --game <目录> --dev-id <id> --app-id <id> [--dry-run] [--yes]
  node taptap.mjs status --dev-id <id> --app-id <id>
  node taptap.mjs review --game <目录> --dev-id <id> --app-id <id> [--dry-run] [--yes]`;

function main() {
  const sub = process.argv[2];
  const args = parseArgs(process.argv);
  if (args.help || !sub) { console.log(USAGE); return args.help ? 0 : 1; }

  const cli = findCli();
  if (!cli && sub !== 'build') {
    console.error('✗ 找不到 taptap-cli。安装：npm i -g @taptap/cli');
    return 1;
  }

  if (sub === 'build') {
    const r = spawnSync(process.execPath, [path.join(HERE, 'build-h5-zip.mjs'), ...process.argv.slice(3)], { stdio: 'inherit' });
    return r.status === null ? 1 : r.status;
  }

  if (!args.game) { console.error(`✗ 缺少 --game\n${USAGE}`); return 1; }
  if (!args.devId || !args.appId) { console.error(`✗ 缺少 --dev-id / --app-id\n${USAGE}`); return 1; }

  const gameDir = path.resolve(args.game);
  const brief = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(gameDir, 'game.brief.json'), 'utf8')); } catch (e) { return {}; }
  })();
  const slug = (args.name || brief.id || path.basename(gameDir)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const zipPath = path.join(gameDir, 'targets', 'taptap', `${slug}.zip`);

  if (sub === 'upload') {
    if (!fs.existsSync(zipPath)) {
      console.error(`✗ 没有 ${path.relative(process.cwd(), zipPath)}，先跑 build`);
      return 2;
    }
    // CLI 要求文件在当前工作目录内：切到 zip 所在目录再调用
    const cwd = path.dirname(zipPath);
    const cliArgs = [
      'upload-h5-package', path.basename(zipPath),
      '--dev-id', String(args.devId), '--app-id', String(args.appId),
      '--json'
    ];
    if (args.dryRun) cliArgs.push('--dry-run');
    if (args.yes && !args.dryRun) cliArgs.push('--yes');

    console.log(`[upload] ${slug}.zip → dev ${args.devId} / app ${args.appId}${args.dryRun ? '（dry-run）' : ''}`);
    const r = spawnSync(cli, cliArgs, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    console.log(out.trim().slice(0, 2000));
    if (r.status !== 0) {
      console.error(`✗ 上传失败（退出码 ${r.status}）`);
      return r.status === 10 ? 4 : 3;
    }
    console.log('✓ 已上传 H5 包');
    console.log('  下一步：taptap-cli app prepare-review-snapshot → precheck-app-review → submit-app-review');
    return 0;
  }

  if (sub === 'status') {
    const r = run(cli, ['app', 'analyze-app-status', '--dev-id', String(args.devId), '--app-id', String(args.appId), '--json']);
    console.log(r.out.trim().slice(0, 3000));
    return r.code === 0 ? 0 : 3;
  }

  if (sub === 'review') {
    // 三步提审：快照 → 预检 → 提交。前三步的 JSON 必须一致。
    console.log('[review] 1/3 准备审核快照');
    const snap = run(cli, ['app', 'prepare-review-snapshot', '--dev-id', String(args.devId), '--app-id', String(args.appId), '--json']);
    if (snap.code !== 0) { console.error(`✗ 快照失败：\n${snap.out.slice(0, 800)}`); return 3; }
    let snapshot = snap.json;
    if (!snapshot || !snapshot.data || !snapshot.data.result) {
      console.error(`✗ 快照返回格式不认识：\n${snap.out.slice(0, 800)}`);
      return 3;
    }
    const result = snapshot.data.result;
    const versionId = result.version_id;
    const revision = result.revision;
    if (!versionId) { console.error('✗ 快照里没有 version_id'); return 3; }

    const schedule = JSON.stringify({ kind: 'immediate' });

    console.log('[review] 2/3 预检');
    const precheck = run(cli, [
      'app', 'precheck-app-review',
      '--dev-id', String(args.devId), '--app-id', String(args.appId),
      '--data', JSON.stringify({ version_id: versionId, revision, release_schedule: JSON.parse(schedule) }),
      '--json'
    ]);
    console.log(precheck.out.trim().slice(0, 1200));
    if (precheck.code !== 0) { console.error('✗ 预检失败'); return 3; }

    if (args.dryRun) {
      console.log('✓ 预检通过（dry-run，未提交）');
      return 0;
    }
    if (!args.yes) {
      console.error('✗ 提交审核是不可逆写操作，需要显式加 --yes');
      return 1;
    }

    console.log('[review] 3/3 提交审核');
    const submit = run(cli, [
      'app', 'submit-app-review',
      '--dev-id', String(args.devId), '--app-id', String(args.appId),
      '--data', JSON.stringify({ version_id: versionId, revision, release_schedule: JSON.parse(schedule) }),
      '--idempotency-key', `submit-${args.appId}-${versionId}`,
      '--yes', '--json'
    ]);
    console.log(submit.out.trim().slice(0, 1200));
    if (submit.code !== 0) { console.error('✗ 提审失败'); return 4; }
    console.log('✓ 已提交审核（首审官方预计 1–3 日）');
    return 0;
  }

  console.error(`✗ 未知子命令 "${sub}"\n${USAGE}`);
  return 1;
}

process.exit(main());
