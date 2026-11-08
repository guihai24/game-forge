/* lib.mjs —— pipeline.mjs / doctor.mjs 共用的 CLI 小工具 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑一个命令，返回 { code, out }，out 合并了 stdout 与 stderr */
export function runCli(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...opts
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * 从可能夹带横幅/日志的文本里抠出第一段完整 JSON。
 * 用括号配对而不是正则，避免被嵌套结构和字符串里的括号骗到。
 */
export function parseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/**
 * 调一个 wechatide 工具。
 * 有些工具（如 create_preview_qrcode）会回传巨大的二进制 buffer，
 * 整段 JSON 解析可能失败，此时退化为文本判定，再由调用方校验产物文件。
 */
export function makeWt(client) {
  return function wt(tool, args) {
    const r = runCli('wechatide', ['-c', client, tool, ...args]);
    const json = parseJson(r.out);
    if (json) return json;
    if (/"success"\s*:\s*true/.test(r.out)) {
      return { ok: true, result: { success: true, recovered: true } };
    }
    return { ok: false, raw: r.out.slice(0, 300), code: r.code };
  };
}

/** 工具返回是否算成功 */
export function isOk(res) {
  if (!res || !res.ok) return false;
  const result = res.result;
  if (result && result.success === false) return false;
  return true;
}

/** 给失败信息取一句人话 */
export function errorText(res) {
  const result = res && res.result;
  return (
    (result && (result.message || result.errorType)) ||
    (res && (res.message || res.raw)) ||
    JSON.stringify(res).slice(0, 300)
  );
}

/** 把 get_simulator_console 的多行文本还原成 [{level, text}] */
export function parseConsoleLines(text) {
  const lines = [];
  for (const raw of String(text || '').split('\n')) {
    const m = /^\s*\d+:\s*(.*)$/.exec(raw);
    if (!m) continue;
    let payload;
    try { payload = JSON.parse(m[1]); } catch (e) { continue; }
    if (!Array.isArray(payload)) continue;
    const [level, ...rest] = payload;
    lines.push({
      level,
      text: rest.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
    });
  }
  return lines;
}

/**
 * 找 playwright-core。它可能来自 DSH profile 的插件依赖，也可能装在别处。
 * 返回目录路径（交给调用方动态 import），找不到返回 null。
 */
export function resolvePlaywright() {
  const home = os.homedir();
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'playwright-core'),
    path.join(home, '.dsh', 'profiles', 'web', 'node_modules', 'playwright-core'),
    path.join(process.cwd(), 'node_modules', 'playwright-core')
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'package.json'))) return c;
    } catch (e) { /* 下一个 */ }
  }
  return null;
}
