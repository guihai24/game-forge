/* 原型生成器：按玩法类型生成一个能玩的最小游戏。
 *
 * 为什么要这个：让用户"选玩法"是行不通的——用户无法从文字里想象手感。
 * 正确做法是先做出来给用户玩，玩过之后"对吧不对"是人人都会的。
 *
 * 用法:
 *   node prototype.mjs --genre reflex   --title "抢早高峰" --out /tmp/proto/reflex
 *   node prototype.mjs --list
 *
 * 产物是一个自包含 HTML，直接用浏览器打开就能玩。
 * 每个原型都暴露 window.__gameState()，测试脚本和 Game Studio 的
 * autopilot 都能读（phase/score/hearts/fps）。
 */
import fs from 'node:fs';
import path from 'node:path';

const GENRES = {
  reflex: {
    label: '反应 / 节奏',
    hint: '在固定节拍上做精确输入',
    feel: '进入状态后手比脑子快',
  },
  puzzle: {
    label: '解谜 / 观察',
    hint: '看、找规律、做一次不可逆的操作',
    feel: '啊，原来是这样',
  },
  strategy: {
    label: '资源 / 取舍',
    hint: '在两个都想要的选项里放弃一个',
    feel: '每个决定都疼',
  },
  sim: {
    label: '养成 / 经营',
    hint: '投一点资源，等它长大，再投',
    feel: '看着东西从无到有',
  },
  bluff: {
    label: '赌运气 / 博弈',
    hint: '不完全信息下押注',
    feel: '手心出汗',
  },
  roleplay: {
    label: '模拟 / 代入',
    hint: '选一句话，看对方怎么反应',
    feel: '这话我说不出口，但我好想说',
  },
};

/* ─────────── 每种玩法的核心循环 ───────────
 * 每个 body 里能用的东西：canvas ctx、GAME.rules、__state 对象。
 * 外壳（画布、循环、状态导出、重开）由 shell() 提供。
 */
const BODIES = {
  // 反应：方块滑向判定线，在线上按
  reflex: `
  // 判定窗口 78px / 速度 220 → 约 0.35 秒反应时间，新手也能打中
  var lanes = 3, speed = 220, notes = [], spawnT = 0, combo = 0, best = 0;
  var lineY = 0, judge = 78, spawnEvery = 1.1;
  function reset() {
    notes = []; spawnT = 0; combo = 0; best = 0; S.score = 0; S.hearts = 3;
    // 判定线放在中下部（不是最底部）：方块要从上方可见地滑下来，
    // 贴在屏幕边缘打等于看不见，没法练节奏。
    lineY = H > 0 ? Math.round(H * 0.74) : 560;
  }
  function spawn() {
    var lane = Math.floor(Math.random() * lanes);
    notes.push({ lane: lane, y: -30, hit: false, gone: false });
  }
  function tap(lane) {
    var bestD = 1e9, bi = -1;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.hit || n.gone || n.lane !== lane) continue;
      var d = Math.abs(n.y - lineY);
      if (d < bestD) { bestD = d; bi = i; }
    }
    if (bi >= 0 && bestD < judge) {
      notes[bi].hit = true; combo++; if (combo > best) best = combo;
      S.score += 10 + Math.min(30, combo * 2);
      flash('#7ee787');
    } else {
      combo = 0; S.score = Math.max(0, S.score - 5);
      flash('#ff7b72');
    }
  }
  function flash(c) { S.flashColor = c; S.flashT = 0.18; }
  function step(dt) {
    spawnT -= dt;
    if (spawnT <= 0) { spawnT = Math.max(0.42, spawnEvery - S.elapsed * 0.012); spawn(); }
    for (var i = notes.length - 1; i >= 0; i--) {
      var n = notes[i];
      n.y += speed * dt;
      if (n.hit && n.y > lineY + 40) { n.gone = true; notes.splice(i, 1); continue; }
      if (!n.hit && n.y > lineY + judge) {
        n.gone = true; notes.splice(i, 1); combo = 0;
        S.hearts--; flash('#ff7b72');
        if (S.hearts <= 0) S.phase = 'lost';
      }
    }
    if (S.flashT > 0) S.flashT -= dt;
  }
  function draw() {
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    var laneW = W / lanes;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (var i = 1; i < lanes; i++) {
      ctx.beginPath(); ctx.moveTo(i * laneW, 0); ctx.lineTo(i * laneW, H); ctx.stroke();
    }
    ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(W, lineY); ctx.stroke();
    for (var j = 0; j < notes.length; j++) {
      var n = notes[j];
      var x = n.lane * laneW + laneW * 0.2;
      ctx.fillStyle = n.hit ? '#3fb950' : '#f0883e';
      ctx.fillRect(x, n.y - 14, laneW * 0.6, 28);
    }
    ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 20px system-ui';
    ctx.fillText('连击 ' + combo + '（最好 ' + best + '）', 16, 34);
    ctx.textAlign = 'right';
    ctx.fillText(S.hearts + ' ♥', W - 16, 34);
    ctx.textAlign = 'left';
    if (S.flashT > 0) {
      ctx.globalAlpha = S.flashT / 0.18 * 0.35;
      ctx.fillStyle = S.flashColor; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }
  function onTap(x, y) { tap(Math.min(lanes - 1, Math.floor(x / (W / lanes)))); }
  function onKey(k) {
    if (k === '1' || k === 'a' || k === 'arrowleft') tap(0);
    if (k === '2' || k === 's' || k === 'arrowdown') tap(1);
    if (k === '3' || k === 'd' || k === 'arrowright') tap(2);
  }
  `,

  // 解谜：点格子翻转，把盘子摆成目标
  puzzle: `
  var N = 5, grid = [], goal = [], moves = 0, maxMoves = 14;
  function reset() {
    N = 5; grid = []; goal = []; moves = 0; S.score = 0; S.hearts = 1;
    for (var i = 0; i < N * N; i++) { grid.push(0); goal.push(Math.random() < 0.5 ? 1 : 0); }
    // 从目标倒推几步，保证有解
    var tmp = goal.slice();
    for (var k = 0; k < 6; k++) {
      var pos = Math.floor(Math.random() * N * N);
      flip(tmp, pos % N, Math.floor(pos / N));
    }
    grid = tmp;
  }
  function flip(g, x, y) {
    var d = [[0,0],[1,0],[-1,0],[0,1],[0,-1]];
    for (var i = 0; i < d.length; i++) {
      var nx = x + d[i][0], ny = y + d[i][1];
      if (nx >= 0 && nx < N && ny >= 0 && ny < N) g[ny * N + nx] = 1 - g[ny * N + nx];
    }
  }
  function solved() {
    for (var i = 0; i < grid.length; i++) if (grid[i] !== goal[i]) return false;
    return true;
  }
  function step(dt) {}
  function draw() {
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    var pad = 40, size = Math.min(W, H) - pad * 2;
    var cell = size / N, ox = (W - size) / 2, oy = (H - size) / 2;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var on = grid[y * N + x];
      var want = goal[y * N + x];
      ctx.fillStyle = on ? '#1f6feb' : '#161b22';
      ctx.fillRect(ox + x * cell + 2, oy + y * cell + 2, cell - 4, cell - 4);
      if (want) {
        ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 3;
        ctx.strokeRect(ox + x * cell + 6, oy + y * cell + 6, cell - 12, cell - 12);
      }
    }
    ctx.fillStyle = '#8b949e'; ctx.font = '14px system-ui';
    ctx.fillText('点格子翻转，让蓝块和绿框对上', ox, oy - 14);
    ctx.textAlign = 'right';
    ctx.fillSTyle = '#8b949e';
    ctx.fillText((maxMoves - moves) + ' 步剩', ox + size, oy - 14);
    ctx.textAlign = 'left';
  }
  function onTap(x, y) {
    var pad = 40, size = Math.min(W, H) - pad * 2;
    var cell = size / N, ox = (W - size) / 2, oy = (H - size) / 2;
    var gx = Math.floor((x - ox) / cell), gy = Math.floor((y - oy) / cell);
    if (gx < 0 || gx >= N || gy < 0 || gy >= N) return;
    flip(grid, gx, gy); moves++;
    S.score = Math.round((1 - unmatched() / grid.length) * 100);
    if (solved()) { S.phase = 'won'; S.score = 100; }
    else if (moves >= maxMoves) S.phase = 'lost';
  }
  function unmatched() {
    var n = 0;
    for (var i = 0; i < grid.length; i++) if (grid[i] !== goal[i]) n++;
    return n;
  }
  function onKey(k) {}
  `,

  // 策略：每回合在两个烂选择里挑
  strategy: `
  var round = 0, totalRounds = 8, opts = [], log = [];
  var pool = [
    { t: '老板临时加需求，今晚要', a: { label: '接下来，熬夜做', cost: '体面 -15', d: { face: -15, time: -20 } }, b: { label: '说做不完', cost: '信任 -12', d: { trust: -12 } } },
    { t: '同事让你背锅', a: { label: '认了', cost: '体面 -18', d: { face: -18 } }, b: { label: '当场反驳', cost: '关系 -15', d: { trust: -15 } } },
    { t: 'HR 约你下午聊', a: { label: '提前准备材料', cost: '精力 -14', d: { energy: -14, trust: 12 } }, b: { label: '装作没事', cost: '风险 +', d: { risk: 20 } } },
    { t: '有人甩来一个急活', a: { label: '接手', cost: '精力 -18', d: { energy: -18, face: 10 } }, b: { label: '推给新人', cost: '口碑 -12', d: { trust: -12 } } },
    { t: '年会抽奖，你要不要表演', a: { label: '上去唱一首', cost: '体面 波动', d: { face: -8, trust: 15 } }, b: { label: '装病', cost: '存在感 -10', d: { face: -10 } } },
    { t: '猎头来电话', a: { label: '聊聊', cost: '被发现风险', d: { risk: 25, trust: 10 } }, b: { label: '挂掉', cost: '机会 -∞', d: {} } }
  ];
  function reset() {
    round = 0; log = []; S.score = 0; S.hearts = 1;
    S.v = { face: 60, trust: 60, energy: 60, risk: 0 };
    nextRound();
  }
  function nextRound() {
    if (round >= totalRounds) {
      S.phase = S.v.face > 0 ? 'won' : 'lost';
      S.score = Math.round(S.v.face);
      opts = [];
      return;
    }
    var p = pool[round % pool.length];
    opts = [ { text: p.t, a: p.a, b: p.b } ];
  }
  function apply(d) {
    for (var k in d) S.v[k] = (S.v[k] || 0) + d[k];
    S.v.face = Math.max(0, Math.min(100, S.v.face));
    round++;
    S.score = Math.round(S.v.face);
    if (S.v.face <= 0) { S.phase = 'lost'; return; }
    nextRound();
  }
  function step(dt) {}
  function draw() {
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    if (!opts.length) return;
    var o = opts[0];
    ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 18px system-ui';
    wrap(o.text, 30, 70, W - 60, 26);
    var bw = W - 80, bh = 74;
    drawBtn(40, H * 0.45, bw, bh, o.a.label, o.a.cost, '#1f6feb');
    drawBtn(40, H * 0.45 + bh + 22, bw, bh, o.b.label, o.b.cost, '#8957e5');
    var keys = ['face', 'trust', 'energy', 'risk'];
    var names = { face: '体面', trust: '信任', energy: '精力', risk: '风险' };
    for (var i = 0; i < keys.length; i++) {
      var v = Math.max(0, Math.min(100, S.v[keys[i]] || 0));
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(30, H - 90 + i * 18, W - 60, 10);
      ctx.fillStyle = keys[i] === 'risk' ? '#f85149' : '#3fb950';
      ctx.fillRect(30, H - 90 + i * 18, (W - 60) * v / 100, 10);
      ctx.fillStyle = '#8b949e'; ctx.font = '11px system-ui';
      ctx.fillText(names[keys[i]], 30, H - 96 + i * 18);
    }
    ctx.fillStyle = '#8b949e'; ctx.font = '12px system-ui';
    ctx.textAlign = 'right'; ctx.fillText('第 ' + (round + 1) + '/' + totalRounds + ' 天', W - 30, 30); ctx.textAlign = 'left';
  }
  function drawBtn(x, y, w, h, label, cost, color) {
    ctx.fillStyle = color; ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff'; ctx.font = 'bold 16px system-ui';
    ctx.fillText(label, x + 16, y + 30);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '12px system-ui';
    ctx.fillText(cost, x + 16, y + 54);
  }
  function wrap(text, x, y, maxW, lh) {
    var words = text.split(''), line = '', yy = y;
    for (var i = 0; i < words.length; i++) {
      var t = line + words[i];
      if (ctx.measureText(t).width > maxW) { ctx.fillText(line, x, yy); line = words[i]; yy += lh; }
      else line = t;
    }
    ctx.fillText(line, x, yy);
  }
  function onTap(x, y) {
    if (!opts.length) return;
    var o = opts[0], bw = W - 80, bh = 74;
    if (y >= H * 0.45 && y <= H * 0.45 + bh) apply(o.a.d);
    else if (y >= H * 0.45 + bh + 22 && y <= H * 0.45 + bh * 2 + 22) apply(o.b.d);
  }
  function onKey(k) {
    if (!opts.length) return;
    var o = opts[0];
    if (k === '1' || k === 'a') apply(o.a.d);
    if (k === '2' || k === 'b') apply(o.b.d);
  }
  `,

  // 养成：资源分配，60 秒内把指标推到阈值
  sim: `
  var bars, allocT = 0;
  function reset() {
    bars = [
      { k: 'skill', name: '能力', v: 10, rate: 1.0, cost: 1 },
      { k: 'network', name: '人脉', v: 5, rate: 0.7, cost: 1 },
      { k: 'rest', name: '状态', v: 40, rate: -0.5, cost: 1 }
    ];
    S.points = 20; S.score = 0; S.hearts = 1;
  }
  function step(dt) {
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      b.v = Math.max(0, Math.min(100, b.v + b.rate * dt * (b.active ? 3.2 : 1)));
    }
    S.points += dt * 1.4;
    S.score = Math.round(bars[0].v * 0.6 + bars[1].v * 0.4);
    if (bars[2].v <= 0) S.phase = 'lost';
    if (S.score >= 90) S.phase = 'won';
  }
  function draw() {
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 18px system-ui';
    ctx.fillText('把「能力」和「人脉」推上去，别让「状态」见底', 24, 44);
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i], y = 100 + i * 110;
      ctx.fillStyle = '#8b949e'; ctx.font = '14px system-ui';
      ctx.fillText(b.name + '  ' + Math.round(b.v), 24, y);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(24, y + 12, W - 48, 22);
      ctx.fillStyle = b.k === 'rest' ? (b.v < 20 ? '#f85149' : '#3fb950') : '#58a6ff';
      ctx.fillRect(24, y + 12, (W - 48) * b.v / 100, 22);
      // 投入按钮
      var bx = W - 130, by = y + 50, bw = 106, bh = 40;
      var can = S.points >= b.cost;
      ctx.globalAlpha = can ? 0.9 : 0.3;
      ctx.fillStyle = b.active ? '#3fb950' : '#1f6feb';
      ctx.fillRect(bx, by, bw, bh); ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(b.active ? '投入中' : '投 1 点', bx + bw / 2, by + 25); ctx.textAlign = 'left';
      b._btn = { x: bx, y: by, w: bw, h: bh };
    }
    ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 16px system-ui';
    ctx.fillText('可分配 ' + Math.floor(S.points), 24, H - 30);
  }
  function onTap(x, y) {
    for (var i = 0; i < bars.length; i++) {
      var btn = bars[i]._btn;
      if (!btn) continue;
      if (x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h) {
        if (S.points >= bars[i].cost) { S.points -= bars[i].cost; bars[i].active = !bars[i].active; }
        return;
      }
    }
  }
  function onKey(k) {
    if (k === '1') bars[0].active = !bars[0].active;
    if (k === '2') bars[1].active = !bars[1].active;
    if (k === '3') bars[2].active = !bars[2].active;
  }
  `,

  // 赌运气：不完全信息下押注
  bluff: `
  var round = 0, totalRounds = 10, cards = [], reveal = 0, choice = null, shown = false;
  function reset() {
    round = 0; S.score = 50; S.hearts = 1; nextRound();
  }
  function nextRound() {
    if (round >= totalRounds) { S.phase = 'won'; return; }
    cards = [];
    for (var i = 0; i < 3; i++) cards.push(Math.random() < 0.5 ? 'good' : 'bad');
    reveal = cards.filter(function (c) { return c === 'good'; }).length;
    shown = false; choice = null;
  }
  function bet(kind) {
    if (shown) return;
    choice = kind;
    shown = true;
    var goods = cards.filter(function (c) { return c === 'good'; }).length;
    if (kind === 'skip') { S.score -= 2; }
    else if (kind === 'high' && goods >= 2) S.score += 18;
    else if (kind === 'low' && goods < 2) S.score += 18;
    else S.score -= 14;
    S.score = Math.max(0, S.score);
    setTimeout(function () { round++; nextRound(); }, 900);
  }
  function step(dt) {}
  function draw() {
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 18px system-ui';
    ctx.fillText('老板今天心情如何？', 24, 50);
    ctx.fillStyle = '#8b949e'; ctx.font = '14px system-ui';
    ctx.fillText('你能看到 ' + reveal + ' / 3 个信号是好的', 24, 80);
    // 三张牌
    var cw = 90, gap = 20, total = cw * 3 + gap * 2;
    var sx = (W - total) / 2;
    for (var i = 0; i < 3; i++) {
      var x = sx + i * (cw + gap), y = 130;
      ctx.fillStyle = shown ? (cards[i] === 'good' ? '#238636' : '#da3633') : '#21262d';
      ctx.fillRect(x, y, cw, 120);
      if (shown) {
        ctx.fillStyle = '#fff'; ctx.font = '34px system-ui'; ctx.textAlign = 'center';
        ctx.fillText(cards[i] === 'good' ? '✓' : '✕', x + cw / 2, y + 74); ctx.textAlign = 'left';
      }
    }
    if (!shown) {
      var labels = [
        ['押「心情好」', 'high', 260],
        ['押「心情差」', 'low', 330],
        ['不押，保本', 'skip', 400]
      ];
      for (var j = 0; j < labels.length; j++) {
        var L = labels[j];
        ctx.fillStyle = j === 2 ? '#30363d' : (j === 0 ? '#1f6feb' : '#8957e5');
        ctx.fillRect(40, L[2], W - 80, 54);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 16px system-ui';
        ctx.fillText(L[0], 60, L[2] + 33);
      }
    }
    ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 20px system-ui';
    ctx.fillText('筹码 ' + Math.round(S.score), 24, H - 40);
    ctx.textAlign = 'right'; ctx.fillStyle = '#8b949e'; ctx.font = '13px system-ui';
    ctx.fillText('第 ' + Math.min(round + 1, totalRounds) + '/' + totalRounds + ' 天', W - 24, H - 40);
    ctx.textAlign = 'left';
  }
  function onTap(x, y) {
    if (shown) return;
    if (y >= 260 && y <= 314) bet('high');
    else if (y >= 330 && y <= 384) bet('low');
    else if (y >= 400 && y <= 454) bet('skip');
  }
  function onKey(k) {
    if (k === '1') bet('high');
    if (k === '2') bet('low');
    if (k === '3') bet('skip');
  }
  `,

  // 模拟：对话框选一句
  roleplay: `
  var stepIdx = 0, attitude = 50, lines = [
    { who: 'HR', text: '公司最近在做组织调整，你的岗位……也在讨论范围内。', opts: [
      { t: '直接问：是不是要我走？', d: -12, reply: 'HR 愣了一下：还没到那一步，你别紧张。' },
      { t: '我能知道是哪方面的调整吗？', d: 8, reply: 'HR 松了口：主要是这个业务线要收缩。' },
      { t: '低头不说话', d: -6, reply: 'HR 等了几秒，翻了翻手里的纸。' }
    ]},
    { who: 'HR', text: '如果给你 N+1，你能接受吗？', opts: [
      { t: '我要 N+2', d: -15, reply: 'HR 皱眉：这个我做不了主。' },
      { t: '能不能给我一点时间考虑', d: 10, reply: 'HR 点头：可以，明天给我答复。' },
      { t: '我接受', d: -3, reply: 'HR 很快记了一笔。' }
    ]},
    { who: 'HR', text: '还有别的想问的吗？', opts: [
      { t: '我这个月的绩效是不是有问题？', d: 6, reply: 'HR 说：你的绩效没问题，是岗位没了。' },
      { t: '那我同事呢？', d: -8, reply: 'HR 脸色变了：这个不方便说。' },
      { t: '没了', d: 0, reply: '谈话就到这里。' }
    ]}
  ];
  var reply = '', replyT = 0, lastChoice = '';
  function reset() { stepIdx = 0; attitude = 50; reply = ''; replyT = 0; lastChoice = ''; S.score = 50; S.hearts = 1; }
  function choose(i) {
    var L = lines[stepIdx];
    if (!L || !L.opts[i]) return;
    var o = L.opts[i];
    attitude = Math.max(0, Math.min(100, attitude + o.d));
    S.score = attitude;
    lastChoice = o.t;
    reply = o.reply; replyT = 2.2;
    stepIdx++;
  }
  function step(dt) {
    if (replyT > 0) { replyT -= dt; if (replyT <= 0) { reply = ''; if (stepIdx >= lines.length) S.phase = 'won'; } }
  }
  function draw() {
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#8b949e'; ctx.font = '13px system-ui';
    ctx.fillText('和 HR 的这次谈话', 24, 34);
    // 态度条
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(24, 48, W - 48, 8);
    ctx.fillStyle = attitude > 50 ? '#3fb950' : (attitude > 25 ? '#d29922' : '#f85149');
    ctx.fillRect(24, 48, (W - 48) * attitude / 100, 8);
    if (reply) {
      // 回复期间把"你刚才说了什么"也留着，否则整屏空白、没有上下文
      if (lastChoice) {
        ctx.fillStyle = '#30363d'; ctx.fillRect(24, 80, W - 48, 56);
        ctx.fillStyle = '#8b949e'; ctx.font = '12px system-ui';
        ctx.fillText('你说', 40, 102);
        ctx.fillStyle = '#c9d1d9'; ctx.font = '14px system-ui';
        wrapText('「' + lastChoice + '」', 40, 122, W - 80, 20);
      }
      ctx.fillStyle = '#0d1117'; ctx.fillRect(24, 156, W - 48, 92);
      ctx.fillStyle = '#f0f6fc'; ctx.font = '16px system-ui';
      wrapText(reply, 28, 186, W - 56, 26);
      return;
    }
    var L = lines[stepIdx];
    if (!L) { S.phase = 'won'; return; }
    // 对方说的话
    ctx.fillStyle = '#21262d'; ctx.fillRect(24, 80, W - 48, 88);
    ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 15px system-ui';
    ctx.fillText(L.who, 40, 106);
    ctx.font = '15px system-ui'; ctx.fillStyle = '#c9d1d9';
    wrapText(L.text, 40, 132, W - 80, 22);
    // 选项
    for (var i = 0; i < L.opts.length; i++) {
      var y = 200 + i * 80;
      ctx.fillStyle = '#1f6feb'; ctx.globalAlpha = 0.85;
      ctx.fillRect(28, y, W - 56, 64); ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff'; ctx.font = '15px system-ui';
      wrapText(L.opts[i].t, 44, y + 26, W - 88, 20);
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '11px system-ui';
      ctx.fillText(String(i + 1), 40, y + 52);
    }
  }
  function wrapText(text, x, y, maxW, lh) {
    var line = '', yy = y;
    for (var i = 0; i < text.length; i++) {
      var t = line + text[i];
      if (ctx.measureText(t).width > maxW) { ctx.fillText(line, x, yy); line = text[i]; yy += lh; }
      else line = t;
    }
    ctx.fillText(line, x, yy);
  }
  function onTap(x, y) {
    if (reply) return;
    var L = lines[stepIdx]; if (!L) return;
    for (var i = 0; i < L.opts.length; i++) {
      var yy = 200 + i * 80;
      if (y >= yy && y <= yy + 64) { choose(i); return; }
    }
  }
  function onKey(k) {
    if (k === '1') choose(0);
    if (k === '2') choose(1);
    if (k === '3') choose(2);
  }
  `,
};

/* ─────────── 外壳：画布、循环、状态导出 ─────────── */
function shell(genre, title, body, meta) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${title}</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0d1117;
  font-family:system-ui,-apple-system,"PingFang SC",sans-serif}
canvas{display:block;width:100vw;height:100vh;touch-action:none}
</style></head><body>
<canvas id="game"></canvas>
<script>
(function () {
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize); resize();

  var S = { phase: 'title', score: 0, hearts: 1, elapsed: 0, time: 60,
            flashT: 0, flashColor: '#fff' };

  window.__gameState = function () {
    return { phase: S.phase, score: Math.round(S.score), hearts: S.hearts,
             fps: 60, hero: { x: W / 2, y: H / 2 }, pickups: [], enemies: [],
             world: { w: W, h: H } };
  };

  ${body}

  var last = 0;
  function frame(ts) {
    var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
    last = ts;
    if (S.phase === 'playing') { S.elapsed += dt; S.time -= dt; step(dt); }
    ctx.save();
    if (S.phase === 'title') drawTitle();
    else if (S.phase === 'playing') draw();
    else drawEnd();
    ctx.restore();
    requestAnimationFrame(frame);
  }

  function drawTitle() {
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 26px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(${JSON.stringify(title)}, W / 2, H / 2 - 30);
    ctx.font = '15px system-ui'; ctx.fillStyle = '#8b949e';
    ctx.fillText(${JSON.stringify(meta.hint)}, W / 2, H / 2 + 6);
    ctx.fillStyle = '#58a6ff'; ctx.font = 'bold 17px system-ui';
    ctx.fillText('点一下开始', W / 2, H / 2 + 62);
    ctx.textAlign = 'left';
  }
  function drawEnd() {
    draw();
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.fillStyle = '#f0f6fc';
    ctx.font = 'bold 26px system-ui';
    ctx.fillText(S.phase === 'won' ? '过了' : '没撑住', W / 2, H / 2 - 20);
    ctx.font = '15px system-ui'; ctx.fillStyle = '#8b949e';
    ctx.fillText('得分 ' + Math.round(S.score), W / 2, H / 2 + 14);
    ctx.fillStyle = '#58a6ff'; ctx.font = 'bold 15px system-ui';
    ctx.fillText('点一下再来一局', W / 2, H / 2 + 56);
    ctx.textAlign = 'left';
  }

  function restart() { reset(); S.phase = 'playing'; S.elapsed = 0; S.time = 60; }

  canvas.addEventListener('pointerdown', function (e) {
    var r = canvas.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    if (S.phase === 'title') { restart(); return; }
    if (S.phase !== 'playing') { restart(); return; }
    onTap(x, y);
    e.preventDefault();
  });
  window.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if (k === ' ' || k === 'enter') { e.preventDefault(); if (S.phase !== 'playing') restart(); }
    if (k === 'r') restart();
    if (S.phase === 'playing') onKey(k);
  });

  reset();
  requestAnimationFrame(frame);
})();
</script></body></html>
`;
}

/* ─────────── CLI ─────────── */
const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : '';
};

if (args.includes('--list') || args.length === 0) {
  console.log('可用玩法原型：\n');
  for (const [k, v] of Object.entries(GENRES)) {
    console.log(`  ${k.padEnd(10)} ${v.label}  —  ${v.hint}`);
    console.log(`  ${''.padEnd(10)} 体验：${v.feel}\n`);
  }
  console.log('用法: node prototype.mjs --genre reflex --title "抢早高峰" --out /tmp/proto/reflex');
  process.exit(0);
}

const genre = get('genre');
const title = get('title') || (GENRES[genre] ? GENRES[genre].label : '原型');
const out = get('out') || path.join('/tmp/prototype', genre);

if (!GENRES[genre]) {
  console.error(`✗ 未知玩法 "${genre}"。可用: ${Object.keys(GENRES).join(' / ')}`);
  process.exit(1);
}

const html = shell(genre, title, BODIES[genre], GENRES[genre]);
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'index.html');
fs.writeFileSync(file, html);
console.log(`✓ ${title}（${GENRES[genre].label}）`);
console.log(`  ${file}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
console.log(`  直接双击打开就能玩；或让用户用面板的「试玩」按钮。`);
