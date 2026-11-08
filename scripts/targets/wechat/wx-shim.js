/* wx-shim.js — 让浏览器 Canvas 游戏跑在微信小游戏运行时里的适配层。
 *
 * 重要设计：微信小游戏的运行时**已经自带** window / document / requestAnimationFrame
 * （weapp-adapter 注入，运行时标记 `__isAdapterInjected`）：
 *   - window 是一个只读 getter（赋值会抛 TypeError）
 *   - document 只有一个 location
 * 所以这一层是「增补」而不是「替换」：只在缺失处补 API，已有的不覆盖。
 *
 * 补齐的表面：
 *   document.getElementById('game') / createElement('canvas')
 *   window.Image（运行时没有）
 *   触摸 → pointerdown/move/up/cancel（游戏用 Pointer Events 写虚拟摇杆）
 *   window.devicePixelRatio（运行时没有）
 *   resize / visibilitychange 等合成事件
 */
(function () {
  'use strict';

  var g = typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis;

  /* 运行时已有的 window：优先用它，拿不到才退化成 globalThis */
  var W = null;
  try { W = g.window; } catch (e) { W = null; }
  if (!W) {
    try { g.window = g; } catch (e) { /* 只读就只读吧 */ }
    W = g;
  }

  /* 安全地定义属性：defineProperty 失败就退回赋值，全都失败就算了 */
  function def(obj, key, value) {
    try {
      var d = Object.getOwnPropertyDescriptor(obj, key);
      if (d && (d.get || d.set) && !d.configurable) return false; // 只读访问器，别碰
      Object.defineProperty(obj, key, {
        configurable: true, enumerable: true, writable: true, value: value
      });
      return true;
    } catch (e) {
      try { obj[key] = value; return true; } catch (e2) { return false; }
    }
  }

  /* ---------- 上屏 canvas ---------- */
  var DEBUG = !!g.__G2WX_DEBUG__;
  function log() {
    if (!DEBUG) return;
    var parts = ['[g2wx]'];
    for (var i = 0; i < arguments.length; i += 1) parts.push(arguments[i]);
    console.log.apply(console, parts);
  }

  var mainCanvas = wx.createCanvas();
  log('boot canvas=', mainCanvas.width, mainCanvas.height);

  /* ---------- 事件注册表 ---------- */
  function makeTarget() {
    var map = Object.create(null);
    return {
      addEventListener: function (type, fn) {
        if (typeof fn !== 'function') return;
        (map[type] || (map[type] = [])).push(fn);
      },
      removeEventListener: function (type, fn) {
        var a = map[type];
        if (!a) return;
        var i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      },
      dispatch: function (ev) {
        var a = map[ev.type];
        if (!a || !a.length) return;
        var copy = a.slice();
        for (var i = 0; i < copy.length; i++) {
          try { copy[i](ev); } catch (e) { /* 单个监听器出错不影响其它 */ }
        }
      }
    };
  }

  var winTarget = makeTarget();
  var docTarget = makeTarget();
  var canvasTarget = makeTarget();

  /* canvas：游戏在这里注册 pointer* 监听器，必须换成我们的表 */
  def(mainCanvas, 'addEventListener', canvasTarget.addEventListener);
  def(mainCanvas, 'removeEventListener', canvasTarget.removeEventListener);
  if (typeof mainCanvas.focus !== 'function') def(mainCanvas, 'focus', function () {});
  if (typeof mainCanvas.getBoundingClientRect !== 'function') {
    def(mainCanvas, 'getBoundingClientRect', function () {
      return { left: 0, top: 0, right: W.innerWidth, bottom: W.innerHeight, width: W.innerWidth, height: W.innerHeight };
    });
  }

  /* ---------- 触摸 → Pointer Events ---------- */
  function pointerEvent(type, t) {
    return {
      type: type,
      pointerId: t.identifier === undefined ? 0 : t.identifier,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      clientX: t.clientX,
      clientY: t.clientY,
      pageX: t.clientX,
      pageY: t.clientY,
      screenX: t.clientX,
      screenY: t.clientY,
      preventDefault: function () {},
      stopPropagation: function () {}
    };
  }
  function firstTouch(e) {
    if (e && e.touches && e.touches.length) return e.touches[0];
    if (e && e.changedTouches && e.changedTouches.length) return e.changedTouches[0];
    return null;
  }
  function bindTouch(name, type) {
    if (typeof wx[name] !== 'function') return;
    wx[name](function (e) {
      var t = firstTouch(e);
      if (t) canvasTarget.dispatch(pointerEvent(type, t));
    });
  }
  bindTouch('onTouchStart', 'pointerdown');
  bindTouch('onTouchMove', 'pointermove');
  bindTouch('onTouchEnd', 'pointerup');
  bindTouch('onTouchCancel', 'pointercancel');

  /* ---------- document：在运行时的 document 上增补 ---------- */
  var D = null;
  try { D = W.document; } catch (e) { D = null; }
  if (!D) { D = {}; def(W, 'document', D); }

  def(D, 'getElementById', function (id) { return id === 'game' ? mainCanvas : null; });
  def(D, 'createElement', function (tag) {
    return String(tag).toLowerCase() === 'canvas' ? wx.createCanvas() : {};
  });
  def(D, 'addEventListener', docTarget.addEventListener);
  def(D, 'removeEventListener', docTarget.removeEventListener);
  if (D.hidden === undefined) def(D, 'hidden', false);
  if (D.body === undefined) def(D, 'body', null);
  if (D.documentElement === undefined) def(D, 'documentElement', null);

  /* ---------- window 增补 ---------- */
  if (typeof W.Image === 'undefined') {
    def(W, 'Image', function Image() { return wx.createImage(); });
    def(g, 'Image', W.Image);
  }

  /* 视口：运行时的 window.innerWidth/innerHeight 是 1×1、devicePixelRatio 是 null，
   * 游戏会用它们算画布尺寸，必须换成真实值，并在窗口变化时更新。 */
  var viewport = { w: 1, h: 1, dpr: 1 };
  function readViewport() {
    var info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
    viewport.w = info.windowWidth || info.screenWidth || 375;
    viewport.h = info.windowHeight || info.screenHeight || 667;
    viewport.dpr = info.pixelRatio || 1;
  }
  readViewport();

  function defineLive(obj, key, getter) {
    try {
      Object.defineProperty(obj, key, { configurable: true, enumerable: true, get: getter });
      return true;
    } catch (e) {
      try { return def(obj, key, getter()); } catch (e2) { return false; }
    }
  }

  log('viewport w=', viewport.w, 'h=', viewport.h, 'dpr=', viewport.dpr);

  defineLive(W, 'innerWidth', function () { return viewport.w; });
  defineLive(W, 'innerHeight', function () { return viewport.h; });
  defineLive(W, 'devicePixelRatio', function () { return viewport.dpr; });
  if (W.screen) {
    defineLive(W.screen, 'width', function () { return viewport.w; });
    defineLive(W.screen, 'height', function () { return viewport.h; });
  }

  /* window 的监听器：记到我们的表里（同时尽量挂一份到运行时上） */
  var origAdd = typeof W.addEventListener === 'function' ? W.addEventListener.bind(W) : null;
  var origRemove = typeof W.removeEventListener === 'function' ? W.removeEventListener.bind(W) : null;
  def(W, 'addEventListener', function (type, fn) {
    winTarget.addEventListener(type, fn);
    if (origAdd) { try { origAdd(type, fn); } catch (e) {} }
  });
  def(W, 'removeEventListener', function (type, fn) {
    winTarget.removeEventListener(type, fn);
    if (origRemove) { try { origRemove(type, fn); } catch (e) {} }
  });

  /* ---------- 窗口尺寸变化 ---------- */
  if (typeof wx.onWindowResize === 'function') {
    wx.onWindowResize(function () { readViewport(); winTarget.dispatch({ type: 'resize' }); });
  }

  /* ---------- 前后台 ---------- */
  function setHidden(hidden) {
    try { D.hidden = hidden; } catch (e) {}
    docTarget.dispatch({ type: 'visibilitychange' });
    if (hidden) winTarget.dispatch({ type: 'blur' });
  }
  if (typeof wx.onShow === 'function') wx.onShow(function () { readViewport(); setHidden(false); });
  if (typeof wx.onHide === 'function') wx.onHide(function () { setHidden(true); });

  /* ---------- 暴露给小游戏的调试/自动化入口 ---------- */
  def(g, '__g2wx', {
    canvas: mainCanvas,
    dispatchPointer: function (type, x, y) {
      canvasTarget.dispatch(pointerEvent(type, { identifier: 0, clientX: x, clientY: y }));
    }
  });
})();
