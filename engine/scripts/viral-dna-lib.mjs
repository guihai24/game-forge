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

/* ---------- 单局时长：按品类分段 ---------- *
 *
 * 早期版本统一按 180–300s 判，依据是"注意力回报率"的直觉，没有出处——
 * 这是错的。Flappy Bird、跳一跳、羊了个羊的单局都是秒级到 1 分钟，
 * 爆款形态是"短局 + 秒重开 + 多局"，不是"一局 3 分钟"。
 *
 * 现在按品类给区间。区间来自对爆款的观察，不是渠道条款，所以只到 WARN。
 * 品类判断优先用 brief.genre，其次 brief.pace。
 */
const ROUND_SECONDS = {
  // 秒级到 1 分钟：靠"再来一次"的冲动驱动，失败成本必须极低
  twitch: { min: 10, max: 90, label: '秒级/短局' },
  // 1–3 分钟：单局有完整起承转合，但还不至于要求长时间投入
  midcore: { min: 60, max: 180, label: '1–3 分钟' },
  // 3–8 分钟：有经营/关卡感，适合放置、消除、塔防
  strategy: { min: 180, max: 480, label: '3–8 分钟' }
};

/* 品类 → 节奏档的匹配表。
 *
 * 旧实现用三条正则按顺序 try，先命中的赢。问题是词根会重叠：
 * collect-and-dodge 里 dodge 属于 twitch、collect 属于 midcore，
 * 谁先谁后决定了结论——这是实现顺序在冒充品类判断。
 *
 * 现在改成表驱动 + 打分：每个词根属于哪个档、权重多少都写清楚，
 * 命中多个时按总分最高的档。这样 collect-and-dodge 会同时命中
 * dodge(twitch) 和 collect(midcore)，按权重决出，而不是按代码行号。
 */
const PACE_LEXICON = {
  twitch: [
    { re: /twitch|flappy/i, w: 3 },
    { re: /runner|reflex|tap-?game/i, w: 3 },
    { re: /dodge|jump|dash/i, w: 2 },
    { re: /click/i, w: 2 },
    { re: /躲避|跳跃|反应|点击/i, w: 2 }
  ],
  midcore: [
    { re: /collect/i, w: 3 },
    { re: /arcade/i, w: 2 },
    { re: /collect-and/i, w: 2 },   // 复合品类多给一分，倾向 midcore
    { re: /收集/i, w: 2 }
  ],
  strategy: [
    { re: /merge|match-?3|match3/i, w: 3 },
    { re: /puzzle|tycoon|tower-?defense|idle|sim|strategy|rpg|card/i, w: 3 },
    { re: /消除|合成|三消|塔防|经营|放置|策略|卡牌/i, w: 3 }
  ]
};

/**
 * 从 genre 推断节奏档。命中多个档时按加权总分取最高；同分时取更"长"的档
 * （长局档通常意味着更具体的玩法描述），并返回候选供排查。
 * @returns { pace, scores, candidates } —— 认不出来 pace 为 null。
 */
export function paceDetail(brief) {
  const b = brief || {};
  if (ROUND_SECONDS[b.pace]) return { pace: b.pace, scores: { [b.pace]: 99 }, candidates: [], source: 'brief.pace' };

  const g = String(b.genre || '');
  if (!g) return { pace: null, scores: {}, candidates: [], source: 'none' };

  const scores = {};
  const hits = [];
  for (const [pace, rules] of Object.entries(PACE_LEXICON)) {
    for (const { re, w } of rules) {
      if (re.test(g)) {
        scores[pace] = (scores[pace] || 0) + w;
        hits.push({ pace, pattern: String(re), weight: w });
      }
    }
  }

  const entries = Object.entries(scores).sort((a, z) => z[1] - a[1]);
  if (!entries.length) return { pace: null, scores, candidates: [], source: 'no-match' };

  // 同分时取更长（更具体）的档：twitch 最短、strategy 最长
  const order = ['twitch', 'midcore', 'strategy'];
  const top = entries[0][1];
  const tied = entries.filter(([, s]) => s === top).map(([p]) => p);
  const pace = tied.sort((a, z) => order.indexOf(z) - order.indexOf(a))[0];

  return { pace, scores, candidates: hits, source: 'genre' };
}

/** 从 genre 推断节奏档；认不出来就返回 null（不猜）。 */
export function paceOf(brief) {
  return paceDetail(brief).pace;
}

/** 判单局时长是否落在该品类的合理区间。返回 { ok, range, note }。 */
export function judgeRoundSeconds(seconds, brief) {
  const pace = paceOf(brief);
  if (!Number.isFinite(seconds)) return { ok: false, measured: false, range: null, note: '没测到单局时长' };
  if (!pace) {
    // 品类认不出来时不判对错，只说观测值——不猜比猜错好
    return { ok: true, measured: true, range: null, note: `${seconds}s（品类未识别，未判区间）` };
  }
  const r = ROUND_SECONDS[pace];
  return {
    ok: seconds >= r.min && seconds <= r.max,
    measured: true,
    range: r,
    note: `${seconds}s（${r.label}品类合理区间 ${r.min}–${r.max}s）`
  };
}

/* ---------- Gate 1：需求阶段 8 项 ---------- */

/** 每条 0/1 分。返回 { items, score, total, failCount }。
 *
 * known：brief 之外的已知事实（来自 .forge/state.json 台账）。
 * Gate 1 的判分输入不该只有 brief——台账里已经确认过的事实（单机、内购）
 * 比 brief 里漏填的字段更可信。
 */
export function scoreBrief(brief, known) {
  const b = brief || {};
  const k = known || {};
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

  // VD-02 单局时长：按品类分段，不再统一卡 180–300s。
  const duration = Number(rules.duration);
  const round = judgeRoundSeconds(duration, b);
  items.push({
    id: 'VD-02',
    ok: round.ok,
    label: '单局时长',
    detail: Number.isFinite(duration) ? round.note : 'brief.rules.duration 没写',
    manual: false,
    // 品类认不出来时是"未判"，不是"未达"
    unmeasured: !round.range && Number.isFinite(duration)
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

  // VD-05 分享即机制：brief 要有非空的 share 字段，或在玩法描述里提到。
  const hasShareField = b.share !== undefined && b.share !== null && b.share !== false;
  const shareHint = hasShareField || /分享|邀请|组队|排行|晒|好友/.test(text);
  items.push({
    id: 'VD-05',
    ok: shareHint,
    label: '分享即机制',
    detail: hasShareField ? `brief.share=${JSON.stringify(b.share)}` : (shareHint ? 'brief 里提到分享/排行' : '没有任何分享机制'),
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
  // brief 没写不代表不是单机——.forge/state.json 里可能已经记着 offline: true。
  // 判分输入不该只有 brief：凡是台账里已有的已知事实，都该被利用。
  const offlineKnown = b.offline === true || k.offline === true;
  const iapKnown = b.iap === true || k.iap === true;
  const frictionFree = offlineKnown && !iapKnown && !/注册|登录|实名/.test(text);
  items.push({
    id: 'VD-07',
    ok: frictionFree,
    label: '零摩擦',
    detail: frictionFree
      ? `单机（来源：${b.offline === true ? 'brief' : '台账'}）、无内购、无注册`
      : (!offlineKnown ? 'brief 和台账都没标单机' : (iapKnown ? '含内购' : '文本里提到注册/登录')),
    manual: false
  });

  // VD-08 时间窗口：trend_evidence 要写出「势」的依据。
  //
  // 只看长度是不够的：写「本品类当前无窗口期」也有 200 字，但那恰恰说明不该做。
  // 所以分两件事判：
  //   - 有没有写（没写 = 没想过，判否）
  //   - 写的是正向还是负向（负向结论一样有价值，但要把 verdict 引到"别做"）
  const te = String(b.trend_evidence || '').trim();
  const NEGATIVE = /无窗口期|没有窗口|不建议|不宜|下行|萎缩|已饱和|接盘|不占势|未进榜|没有机会/;
  const hasTrend = te.length >= 10;
  const negative = hasTrend && NEGATIVE.test(te);
  items.push({
    id: 'VD-08',
    ok: hasTrend,
    label: '时间窗口',
    detail: !hasTrend
      ? 'brief 没写 trend_evidence（凭什么现在是这个题材的窗口期）'
      : negative
        ? `已写，但结论是负向：${te.slice(0, 70)}…（依据充分，所以本项通过；但它说明不该做）`
        : `trend_evidence: ${te.slice(0, 60)}`,
    manual: false,
    // 负向依据：项算通过（你确实做了判断），但要单独标出来影响总评
    negative
  });

  const passed = items.filter((i) => i.ok).length;
  const failed = items.filter((i) => !i.ok);
  // 三分类：能判且过了 / 能判但没过 / 判不了（需人工）
  const autoFailed = failed.filter((i) => !i.needsHuman && !i.unmeasured);
  const human = failed.filter((i) => i.needsHuman);
  const unmeasured = failed.filter((i) => !i.needsHuman && i.unmeasured);
  // 负向依据：项本身通过（你做了判断），但结论就是「不该做」。
  // 这不该被"缺 2 条"的计数掩盖——证据说没势，比缺两条基因更该砍。
  const negativeTrend = items.filter((i) => i.id === 'VD-08' && i.ok && i.negative);

  const drop = autoFailed.length >= 2 || negativeTrend.length > 0;
  return {
    score: passed,
    total: items.length,
    items,
    failed,
    // 砍线只看能机器判、且真的判了的部分。人工项默认不过会把每款都判死；
    // 未测项（品类认不出来）同理，不能当成未达。
    autoFailed: autoFailed.length,
    autoJudged: items.length - human.length,
    humanCount: human.length,
    unmeasuredCount: unmeasured.length,
    negativeTrend: negativeTrend.length > 0,
    verdict: drop ? 'suggest-drop' : 'proceed',
    note: negativeTrend.length
      ? 'trend_evidence 的结论是负向（当前没有窗口期）——按规则建议别做'
      : autoFailed.length >= 2
        ? `${autoFailed.length} 项自动判定未过（${autoFailed.map((i) => i.label).join('、')}），按规则建议别做`
        : autoFailed.length === 1
          ? `1 项自动判定未过（${autoFailed[0].label}），未触及"缺 2 条"的砍线`
        : '自动判定全部通过'
  };
}

/** Gate 1 的静态判定 vs Gate 2 的实测结论：同一件事两边说法不一致时，实测优先。
 *
 * Gate 1 是"从 brief 文字推断"，Gate 2 是"对产物实测"。brief 说没写反馈，
 * 不代表游戏没反馈——实测 34ms 才是事实。冲突时以实测为准，并在输出里
 * 标出"静态判定被实测推翻"，而不是让两个结论各自出现在界面上。
 *
 * 映射：Gate 1 的项 → 能推翻它的 Gate 2 项。
 */
const G2_OVERRIDES = {
  'VD-07': ['VD-07b'],                 // 零摩擦 / 冷启动
  'VD-03': ['VD-03b'],                 // 即时反馈 / 反馈延迟
  'VD-02': ['VD-02b'],                 // 单局时长 / 实测时长
  'VD-05': ['VD-05b']                  // 分享机制 / 实测分享
};

/**
 * 用 Gate 2 实测结果修正 Gate 1。
 * @returns { score, total, items, overridden } —— items 里被推翻的项标 overriddenBy。
 */
export function reconcileGates(gate1, gate2Items) {
  if (!gate1) return gate1;
  const byId = new Map();
  for (const i of gate2Items || []) if (i.id) byId.set(i.id, i);

  const items = gate1.items.map((i) => {
    const probes = (G2_OVERRIDES[i.id] || []).map((id) => byId.get(id)).filter(Boolean);
    if (!probes.length) return i;
    // 只有当 Gate 1 判否、且 Gate 2 确有实测通过时，才算被推翻
    const measuredPass = probes.find((p) => p.ok === true);
    const measuredFail = probes.find((p) => p.ok === false);
    if (!i.ok && measuredPass) {
      return {
        ...i,
        ok: true,
        overriddenBy: measuredPass.id,
        detail: `实测推翻静态判定：${measuredPass.detail}`
      };
    }
    if (i.ok && measuredFail) {
      return {
        ...i,
        ok: false,
        overriddenBy: measuredFail.id,
        detail: `实测推翻静态判定：${measuredFail.detail}`
      };
    }
    return i;
  });

  const passed = items.filter((i) => i.ok).length;
  const failed = items.filter((i) => !i.ok);
  const autoFailed = failed.filter((i) => !i.needsHuman && !i.unmeasured);
  const human = failed.filter((i) => i.needsHuman);
  const unmeasured = failed.filter((i) => !i.needsHuman && i.unmeasured);
  const overridden = items.filter((i) => i.overriddenBy);

  return {
    ...gate1,
    score: passed,
    items,
    failed,
    autoFailed: autoFailed.length,
    autoJudged: items.length - human.length,
    humanCount: human.length,
    unmeasuredCount: unmeasured.length,
    overridden,
    reconciled: true,
    // 负向趋势依据与"缺 2 条"一样触发砍线，不能被实测修正掩盖
    negativeTrend: Boolean(gate1.negativeTrend) || items.some((i) => i.id === 'VD-08' && i.ok && i.negative),
    verdict: (autoFailed.length >= 2 || gate1.negativeTrend || items.some((i) => i.id === 'VD-08' && i.ok && i.negative))
      ? 'suggest-drop' : 'proceed',
    note: (gate1.negativeTrend || items.some((i) => i.id === 'VD-08' && i.ok && i.negative))
      ? 'trend_evidence 的结论是负向（当前没有窗口期）——按规则建议别做'
      : autoFailed.length >= 2
        ? `${autoFailed.length} 项自动判定未过（${autoFailed.map((i) => i.label).join('、')}），按规则建议别做`
        : autoFailed.length === 1
          ? `1 项自动判定未过（${autoFailed[0].label}），未触及"缺 2 条"的砍线`
          : '自动判定全部通过'
  };
}

/** Gate 2 的"值不值得上架"摘要。 */
export function verdictSummary(gate1, gate2) {
  const score = gate1 ? gate1.score : 0;
  const total = gate1 ? gate1.total : 8;
  const g2 = (gate2 || []).filter((i) => i.level !== 'INFO');
  const g2fail = g2.filter((i) => i.ok === false);
  const g2unmeasured = g2.filter((i) => i.ok === null);
  const parts = [];
  parts.push(`基因 ${score}/${total}`);
  if (gate1 && gate1.verdict === 'suggest-drop') parts.push('需求阶段已触发砍线');
  if (gate1 && gate1.overridden && gate1.overridden.length) {
    parts.push(`实测推翻 ${gate1.overridden.length} 项静态判定`);
  }
  if (g2fail.length) parts.push(`产物实测 ${g2fail.length} 项未达`);
  else if (g2.length) parts.push('产物实测无未达');
  if (g2unmeasured.length) parts.push(`${g2unmeasured.length} 项未测到`);
  return parts.join(' · ');
}
