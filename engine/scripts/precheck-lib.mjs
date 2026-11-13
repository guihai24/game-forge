/* precheck-lib.mjs —— 渠道审核自查的判定逻辑。
 *
 * CLI（precheck.mjs）和 DSH 面板（console/index.js）共用这一份，避免两边规则漂移。
 * 规则来源：references/rules/channel-rules.md
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

function hashFile(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); } catch (e) { return null; }
}

/** 归一化代码后再哈希：去掉空白和注释，避免只改格式就躲过检查。 */
function hashCode(text) {
  const normalized = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** 两段文本的相似度（按行 Jaccard，无依赖）。 */
function similarity(a, b) {
  const lines = (t) => new Set(t.split('\n').map((l) => l.trim()).filter((l) => l.length > 20));
  const A = lines(a);
  const B = lines(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const l of A) if (B.has(l)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function makeReport() {
  const items = [];
  return {
    items,
    add(level, id, msg, hint) { items.push({ level, id, msg, hint: hint || '' }); },
    get blocked() { return items.filter((i) => i.level === 'BLOCK'); },
    get warned() { return items.filter((i) => i.level === 'WARN'); }
  };
}

/* ---------- 需求阶段 ---------- */
export function checkBrief(brief, channel, report) {
  const b = brief || {};
  const name = String(b.title || '');
  const genre = String(b.genre || '');
  const rules = JSON.stringify(b.rules || {});
  const notes = String(b.notes || '');
  const text = `${name} ${genre} ${notes} ${rules}`;

  if (/赌博|博彩|抽奖摇号|现金奖励|实物奖励/.test(text)) {
    report.add('BLOCK', 'gambling', '需求里出现赌博/博彩/现金或实物奖励', '所有渠道都明确不收录，必须改玩法');
  }
  if (/同人|二创|二次创作/.test(text)) {
    report.add('BLOCK', 'fanwork', '需求里出现同人/二次创作', 'TapTap 1.6.4 明确不收录；改用原创题材');
  }
  if (/破解|盗版|未授权|私服/.test(text)) {
    report.add('BLOCK', 'piracy', '需求涉及破解/盗版/未授权', '必被封号');
  }
  if (/血腥|色情|暴力|宗教|民族/.test(text)) {
    report.add('BLOCK', 'illegal', '需求里出现敏感题材词', '需人工确认内容实质，不要凭关键词下结论');
  }
  if (/原神|王者荣耀|马里奥|宝可梦|米老鼠|哆啦A梦|迪士尼|漫威/.test(text)) {
    report.add('BLOCK', 'brand-ip', '需求涉及知名 IP / 角色', '侵权，且各渠道都会拒；必须换原创题材');
  }

  if (b.iap === true || /内购|充值|付费解锁/.test(text)) {
    report.add('BLOCK', 'iap-without-isbn', '需求含内购', '无版号不得含内购内容（TapTap 1.2.6）；个人主体拿不到版号。改成纯广告变现');
  }
  if (channel === 'wechat' && /虚拟支付/.test(text)) {
    report.add('BLOCK', 'virtual-pay-individual', '微信个人主体不能开虚拟支付', '去掉虚拟支付或换企业主体');
  }

  if (channel === 'wechat') {
    if (/[A-Za-z]/.test(name)) {
      report.add('WARN', 'name-with-software', `名称含英文（${name}）`, '微信要求名称含英文时补软著或授权，建议改纯中文名');
    }
    if (/软件/.test(name)) {
      report.add('WARN', 'name-with-software', `名称含「软件」字样（${name}）`, '会触发额外资质要求，建议去掉');
    }
  }
  if (!name) report.add('WARN', 'no-title', 'brief 里没有游戏名', '名称在备案后冻结，早点定下来');

  if (b.offline === false) {
    report.add('WARN', 'networked', '标记为联网游戏', '微信、TapTap 都要额外 ICP（约 21 工作日）。能单机就单机');
  } else if (b.offline === undefined) {
    report.add('INFO', 'offline-unset', 'brief 没写 offline', '建议明确标注单机/联网，它直接决定备案周期');
  }

  if (!b.genre) report.add('WARN', 'no-genre', 'brief 里没有玩法类型', '同质化审查会看玩法是否有实质差异，先定清楚');
}

/* ---------- 提交前 ---------- */
export function collectGames(root) {
  const out = [];
  (function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    if (entries.some((e) => e.isFile() && e.name === 'game.brief.json')) { out.push(dir); return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || ['node_modules', 'targets', 'dist'].includes(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  })(root, 0);
  return out;
}

export function fingerprint(dir) {
  const brief = readJson(path.join(dir, 'game.brief.json')) || {};
  const gameJsPath = path.join(dir, 'game.js');
  const gameJs = fs.existsSync(gameJsPath) ? fs.readFileSync(gameJsPath, 'utf8') : '';
  const assets = [];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'assets'))) {
      const h = hashFile(path.join(dir, 'assets', f));
      if (h) assets.push(h);
    }
  } catch (e) { /* 没素材目录 */ }
  const htmlPath = entryHtml(dir);
  return {
    dir,
    id: path.basename(dir),
    title: brief.title || path.basename(dir),
    brief,
    codeHash: gameJs ? hashCode(gameJs) : null,
    codeSize: gameJs.length,
    code: gameJs,
    assets,
    htmlSize: htmlPath ? fs.statSync(htmlPath).size : 0
  };
}

export function entryHtml(dir) {
  return [path.join(dir, 'targets', 'web', 'index.html'), path.join(dir, 'dist', 'index.html')]
    .find((p) => fs.existsSync(p));
}

/** 拿别的游戏的指纹做对照。peers 是已算好的指纹数组。 */
export function checkSubmit(dir, channel, report, peers) {
  const brief = readJson(path.join(dir, 'game.brief.json')) || {};
  checkBrief(brief, channel, report);

  const self = fingerprint(dir);

  const limits = { wechat: 30 * 1024 * 1024, taptap: 300 * 1024 * 1024 };
  if (self.htmlSize && self.htmlSize > (limits[channel] || Infinity)) {
    report.add('BLOCK', 'oversize', `产物 ${(self.htmlSize / 1048576).toFixed(1)} MB 超过 ${channel} 上限`, '拆分资源或压缩');
  }

  const htmlPath = entryHtml(dir);
  if (htmlPath) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const external = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
    if (external.length) {
      report.add('BLOCK', 'external-links', `产物有 ${external.length} 个外链`, `例如 ${external[0]}；TapTap 1.4.4 / 微信都不允许`);
    }
    if (/\bfetch\s*\(|XMLHttpRequest|wx\.request|https?:\/\/api\./i.test(html)) {
      report.add('WARN', 'networked', '产物里有网络请求代码', '会被判为联网游戏，备案周期变长');
    }
  }

  // 跨游戏同质化 —— 单看一款看不出来
  const others = (peers || collectGames(path.dirname(dir)))
    .map((d) => (typeof d === 'string' ? readableDir(d) : d))
    .filter((o) => o && path.resolve(o.dir) !== path.resolve(dir));

  for (const other of others) {
    if (!self.code || !other.code) continue;

    if (self.codeHash === other.codeHash) {
      report.add('BLOCK', 'identical-code',
        `游戏代码与「${other.title}」完全相同（哈希 ${self.codeHash}）`,
        'TapTap 1.4.1「不得上传内容相似或相同的游戏」；必须改玩法或代码结构');
    } else {
      const sim = similarity(self.code, other.code);
      if (sim > 0.85) {
        report.add('BLOCK', 'template-app',
          `游戏代码与「${other.title}」相似度 ${(sim * 100).toFixed(0)}%`,
          'TapTap 1.4.3「不得套用模板」；需在玩法机制上有实质差异');
      } else if (sim > 0.6) {
        report.add('WARN', 'duplicate-content',
          `游戏代码与「${other.title}」相似度 ${(sim * 100).toFixed(0)}%`,
          '同质化风险，建议再拉开差距');
      }
    }

    if (self.assets.length && other.assets.length) {
      const shared = self.assets.filter((h) => other.assets.includes(h));
      if (shared.length >= Math.min(self.assets.length, other.assets.length) * 0.8) {
        report.add('WARN', 'same-assets',
          `与「${other.title}」共用 ${shared.length} 个素材`,
          '同一套美术素材会被认为换皮');
      }
    }
  }

  return self;
}

/** 把「目录或已算好的指纹」统一成一个指纹对象。 */
function readableDir(x) {
  if (typeof x !== 'string') return x;
  try { return fs.statSync(x).isDirectory() ? fingerprint(x) : null; } catch (e) { return null; }
}

/** 一次算完一批游戏的自审结果：dir -> report。图谱只算一次。 */
export function precheckAll(dirs, channel) {
  const prints = dirs.map((d) => fingerprint(d));
  const out = {};
  for (const d of dirs) {
    const report = makeReport();
    checkSubmit(d, channel, report, prints);
    out[d] = { ok: !report.blocked.length, blocked: report.blocked.length, warned: report.warned.length, items: report.items };
  }
  return out;
}

export function summarize(items) {
  return {
    ok: !items.some((i) => i.level === 'BLOCK'),
    blocked: items.filter((i) => i.level === 'BLOCK').length,
    warned: items.filter((i) => i.level === 'WARN').length
  };
}
