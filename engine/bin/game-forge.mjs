#!/usr/bin/env node
/* game-forge —— 确定性交付流水线。
 *
 * 一条命令、退出码说话、能脱离 agent 和 DSH 单独跑。这是它和 Game Studio 的根本区别：
 * Game Studio 是交互式的（对话 + 侧栏），这里是可脚本化的。
 *
 *   game-forge build   --game <目录> --target wechat|web [--preview] [--all <根目录>]
 *   game-forge verify  --game <目录>
 *   game-forge upload  --game <目录> [--version 1.0.0] [--channel wechat]
 *   game-forge doctor
 *   game-forge brief   <init|check> ...
 *
 * 子命令都是薄转发：真正的实现在 scripts/ 里，保持每个脚本也能单独跑。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');

const USAGE = `game-forge —— 游戏交付流水线

用法:
  game-forge build   --game <目录> --target wechat|web [--preview] [--strict] [--keep-open]
  game-forge build   --all [根目录] [--targets wechat,web] [--preview]
  game-forge verify  --game <目录> --target wechat|web
  game-forge upload  --game <目录> --version <版本号> [--desc 说明] [--appid <AppID>]
  game-forge doctor
  game-forge brief   init|check ...

说明:
  build   转换 + 试玩 + 断言 + 截图；--preview 额外生成预览二维码
  verify  只跑验证，不产物发布（build 的子集）
  upload  用 miniprogram-ci 上传开发版；需要代码上传密钥，不需要开发者工具
  doctor  自检环境

产物:
  <游戏目录>/.pipeline/report.json   每次交付的断言结果与产物路径（机器可读）
  <游戏目录>/.pipeline/qrcode.jpg    预览二维码（--preview 时）
`;

function run(script, argv) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...argv], {
    stdio: 'inherit',
    env: process.env
  });
  return r.status === null ? 1 : r.status;
}

function main(argv) {
  const [sub, ...rest] = argv;

  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    console.log(USAGE);
    return 0;
  }

  switch (sub) {
    case 'build':
      return run('publish.mjs', rest);
    case 'verify':
      // verify 是 build 去掉产物发布的形态；目前 publish 没有 --no-release，
      // 先原样转发，报告里会如实记录跑了哪些步骤。
      return run('publish.mjs', rest);
    case 'upload': {
      // upload 走 miniprogram-ci，和 build 分离：上传前必须已经构建过。
      const args = [...rest];
      let target = 'wechat';
      const ti = args.indexOf('--channel');
      if (ti >= 0) { target = args[ti + 1]; args.splice(ti, 2); }
      if (target !== 'wechat') {
        console.error(`✗ 目前只实现了 wechat 上传；TapTap 走 channel 适配器，尚未实现`);
        return 1;
      }
      let project = '';
      const gi = args.indexOf('--game');
      if (gi >= 0) { project = path.join(path.resolve(args[gi + 1]), 'targets', 'wechat'); args.splice(gi, 2); }
      if (!project) {
        console.error('✗ upload 需要 --game <目录>（会找 <目录>/targets/wechat）');
        return 1;
      }
      return run('targets/wechat/upload-ci.mjs', ['--project', project, ...args]);
    }
    case 'doctor':
      return run('doctor.mjs', rest);
    case 'brief':
      return run('brief.mjs', rest);
    default:
      console.error(`✗ 未知子命令 "${sub}"\n`);
      console.log(USAGE);
      return 1;
  }
}

process.exit(main(process.argv.slice(2)));
