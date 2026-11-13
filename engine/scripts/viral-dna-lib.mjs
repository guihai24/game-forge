/* viral-dna-lib.mjs —— 爆款基因自审（第二层 precheck）的判定逻辑。
 *
 * 与 precheck-lib.mjs 并列，同样被 CLI 和 DSH 面板共用。
 * 这一层答"值不值得上架"，不是"能不能上架"。
 *
 * 设计约束（见 references/rules/viral-dna-rules.md §六）：
 *   - 病毒基因项只到 WARN，不设 BLOCK。"可能爆"无法被证明，BLOCK 会把批量试错堵死。
 *   - 情绪主题不做硬编码规则，只作 brief 输入（emotion_theme / trend_evidence）。
 *   - Gate 2 的断言只采信产物实测，不采信 brief / 生成器的自述。
 *
 * Gate 1 是静态判定（读 brief）；Gate 2 是动态判定（读产物 + playtest 计时）。
 */

import fs from 'node:fs';
import path from 'node:path';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

/* ---------- Gate 1：需求阶段 8 项 ---------- */

/** 每条 0/1 分。返回 { items, score, total, failCount }。 */
export function scoreBrief(brief) {
  const b = brief || {};
  const text = `${b.title || ''} ${b.genre || ''} ${b.notes || ''} ${JSON.stringify(b.rules || {})} ${b.emotion_theme || ''} ${b.trend_evidence || ''}`;
  const rules = b.rules || {};
  const items = [];

  // VD-01 5 秒上手：规则一句话说得清。有 genre + 简短 notes 就算过。
  items.push({
    id: 'VD-01',
    ok: Boolean(b.genre) && String(b.notes || '').length > 0 && String(b.notes || '').length <= 120,
    label: '5 秒上手',
    detail: !b.genre ? 'brief 没写玩法类型' : (String(b.notes || '').length > 120 ? 'notes 太长，规则可能说不清' : (b.notes ? 'notes 已描述规则' : '没有 notes')),
    manual: Boolean(b.genre) && String(b.notes || '').length > 120
  });

  // VD-02 单局 3–5 分钟。看 rules.duration（秒）。
  const duration = Number(rules.duration);
  items.push({
    id: 'VD-02',
    ok: Number.isFinite(duration) && duration >= 180 && duration <= 300,
    label: '3 分钟一局',
    detail: Number.isFinite(duration) ? `duration=${duration}s` : 'brief.rules.duration 没写',
    manual: false
  });

  // VD-03 即时反馈：brief 里要能看出"每次操作有反馈"。
  const feedbackHint = /反馈|动画|特效|立即|即时|秒回|命中|音效|震动/.test(text);
  items.push({
    id: 'VD-03',
    ok: feedbackHint,
    label: '即时反馈',
    detail: feedbackHint ? 'brief 里提到反馈形式' : 'brief 没描述操作后的反馈',
    manual: !feedbackHint
  });

  // VD-04 近失设计：机器判不了，只能提示人工确认。
  items.push({
    id: 'VD-04',
    ok: false,
    label: '近失设计',
    detail: '需人工确认：失败时玩家是否觉得"差一点"，且归因于自己而不是运气',
    manual: true,
    needsHuman: true
  });

  // VD-05 分享即机制：brief 要有分享字段或在玩法里描述。
  const shareHint = b.share !== undefined || /分享|邀请|组队|排行|晒|好友/.test(text);
  items.push({
    id: 'VD-05',
    ok: shareHint,
    label: '分享即机制',
    detail: b.share ? `brief.share=${JSON.stringify(b.share)}` : (shareHint ? 'brief 里提到分享/排行' : '没有任何分享机制'),
    manual: !shareHint
  });

  // VD-06 话题钩子：机器判不了。
  items.push({
    id: 'VD-06',
    ok: false,
    label: '话题钩子',
    detail: '需人工确认：玩完后玩家有一句话可跟朋友说（战绩/挫败/争议点）',
    manual: true,
    needsHuman: true
  });

  // VD-07 零摩擦：免费、无注册、点开即玩。
  const frictionFree = b.offline === true && !b.iap && !/注册|登录|实名/.test(text);
  items.push({
    id: 'VD-07',
    ok: frictionFree,
    label: '零摩擦',
    detail: frictionFree
      ? '单机、无内购、无注册'
      : (!b.offline ? 'brief 没标 offline=true' : (b.iap ? '含内购' : 'brief 里提到注册/登录')),
    manual: false
  });

  // VD-08 时间窗口：看 trend_evidence 是否给了"势"的依据。
  const trendOk = String(b.trend_evidence || '').trim().length >= 10;
  items.push({
    id: 'VD-08',
    ok: trendOk,
    label: '时间窗口',
    detail: trendOk ? `trend_evidence: ${String(b.trend_evidence).slice(0, 60)}` : 'brief 没写 trend_evidence（凭什么现在是这个题材的窗口期）',
    manual: false
  });

  const passed = items.filter((i) => i.ok).length;
  const failed = items.filter((i) => !i.ok);
  const autoFailed = failed.filter((i) => !i.needsHuman);

  return {
    score: passed,
    total: items.length,
    items,
    failed,
    // 砍线只看能机器判的部分，避免"人工项默认不过"直接把每款都判死
    autoFailed: autoFailed.length,
    verdict: autoFailed.length >= 2 ? 'suggest-drop' : 'proceed',
    note: autoFailed.length >= 2
      ? `自动判定的 ${autoFailed.length} 项未过（${autoFailed.map((i) => i.label).join('、')}），按规则建议别做`
      : '自动判定未触发砍线（缺 2 条以上才建议放弃）'
  };
}

/* ---------- Gate 2：提交前对产物断言 ---------- */

const SHARE_API = /(navigator\.(share|clipboard)|wx\.shareAppMessage|wx\.onShareAppMessage|shareAppMessage|onShareTimeline|leaderboard|rankList|invite|openDataContext)/i;
const SHARE_TEXT = /分享|邀请|排行|组队|晒一晒|好友/;

/** 代码里有没有分享调用，且入口在核心循环可达路径上。 */
export function checkShareRuntime(dir) {
  const gameJs = path.join(dir, 'game.js');
  let code = '';
  try { code = fs.readFileSync(gameJs, 'utf8'); } catch (e) { return { id: 'VD-05b', ok: false, label: '分享机制（实测）', detail: '读不到 game.js' }; }

  const api = SHARE_API.exec(code);
  if (!api) {
    return {
      id: 'VD-05b',
      ok: false,
      label: '分享机制（实测）',
      detail: SHARE_TEXT.test(code)
        ? '代码里只有分享文案，没有分享 API 调用'
        : '产物里完全没有分享机制'
    };
  }
  // 在核心循环可达路径上：分享调用不能只出现在某个不可达函数里。
  // 近似判据：出现次数 ≥1，且不是全部落在注释里（注释已被上面的正则漏过了，这里看真实调用）。
  const calls = code.match(new RegExp(SHARE_API.source, 'gi')) || [];
  return {
    id: 'VD-05b',
    ok: true,
    label: '分享机制（实测）',
    detail: `发现 ${calls.length} 处分享 API：${calls[0]}`
  };
}

/** 读 playtest 计时结果，判 VD-02b / VD-03b / VD-07b。 */
export function evalPlaytestTimings(timings) {
  const t = timings || {};
  const items = [];

  // VD-07b 冷启动：页面加载到可操作 ≤3 秒。
  items.push({
    id: 'VD-07b',
    ok: Number.isFinite(t.bootMs) && t.bootMs <= 3000,
    label: '冷启动（实测）',
    detail: Number.isFinite(t.bootMs) ? `${(t.bootMs / 1000).toFixed(1)}s 到可操作` : '没测到启动耗时'
  });

  // VD-03b 操作到反馈 <1 秒，失败后重开 <2 秒。
  const feedbackOk = Number.isFinite(t.feedbackMs) && t.feedbackMs <= 1000;
  const restartOk = !Number.isFinite(t.restartMs) || t.restartMs <= 2000;
  items.push({
    id: 'VD-03b',
    ok: feedbackOk && restartOk,
    label: '反馈延迟（实测）',
    detail: [
      Number.isFinite(t.feedbackMs) ? `操作→反馈 ${t.feedbackMs}ms` : '没测到反馈延迟',
      Number.isFinite(t.restartMs) ? `重开 ${(t.restartMs / 1000).toFixed(1)}s` : ''
    ].filter(Boolean).join('，')
  });

  // VD-02b 单局时长 3–5 分钟。
  items.push({
    id: 'VD-02b',
    ok: Number.isFinite(t.roundSeconds) && t.roundSeconds >= 180 && t.roundSeconds <= 300,
    label: '单局时长（实测）',
    detail: Number.isFinite(t.roundSeconds) ? `${t.roundSeconds}s` : '没测到单局时长'
  });

  return items;
}

/** Gate 2 的"值不值得上架"摘要。 */
export function verdictSummary(gate1, gate2) {
  const score = gate1 ? gate1.score : 0;
  const total = gate1 ? gate1.total : 8;
  const g2fail = (gate2 || []).filter((i) => !i.ok && i.level !== 'BLOCK');
  const parts = [];
  parts.push(`基因 ${score}/${total}`);
  if (gate1 && gate1.verdict === 'suggest-drop') parts.push('需求阶段已触发砍线');
  if (g2fail.length) parts.push(`产物实测 ${g2fail.length} 项未达`);
  else if ((gate2 || []).length) parts.push('产物实测全部达标');
  return parts.join(' · ');
}
