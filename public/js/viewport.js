// viewport.js — iOS Safari 键盘/视口适配（VisualViewport 稳定显示方案）。
//
// 依据（本机调研 + 外部证据，见 docs/design/README.md 6）：
//   1. 唯一可靠方案 = window.visualViewport + CSS 自定义属性（dvh/svh/lvh 不响应软键盘）；
//   2. app shell 高度：无键盘时用布局视口 innerHeight（随地址栏收放，且不用 iOS 26.0
//      会在底部留缝的 100dvh）；键盘弹起时用 visualViewport.height（可视区高度），
//      composer 作为 flex 末项自然贴在键盘上沿；
//   3. iOS 26 已知缺陷：键盘收起后 visualViewport.offsetTop 可能残留 >0
//      （Apple Forums 800125，本机仅经第三方转述确认）。非键盘态一律把补偿量归零，
//      不再盲目 translate shell —— 否则整壳下移造成「顶部被遮 + 底部空白」；
//   4. 监听 resize + scroll（offsetTop 变化只发 scroll）+ pageshow/visibilitychange
//      （bfcache/多步收放后立即重采样并清 stale），用 rAF 合并；
//   5. scale !== 1（捏合缩放）时几何量不可信，放弃施加 inset；
//   6. 无聚焦可编辑元素时的高度变化视为地址栏收放，不当作键盘；
//   7. 键盘「停稳」用递增超时序列判定（Safari UI 展开时 resize 会迟到），
//      不用固定时长做 CSS transition（会双重跳动）；
//   8. 只在值真的变化时写 DOM；全部写入根元素 CSS 变量与类名，不直接改元素样式。

/** 小于该值的 inset 视为地址栏收放，不是键盘（vaul 经验值 60px）。 */
export const KB_MIN_INSET = 60;

/** 键盘停稳的递增探测档位（ms）。 */
export const SETTLE_LADDER = Object.freeze([50, 200, 500, 1000, 1500]);

/** 键盘收起后的补偿重采样时点（ms）：iOS 的 offsetTop 复位可能晚于 resize。 */
export const RECOVER_DELAYS = Object.freeze([100, 320, 760]);

/** 无焦点、无偏移时，可视视口比布局视口矮超过该值 → 视为浏览器 chrome 外露（而非键盘）。 */
export const CHROME_GAP_MIN = 80;

/** ?diag=1 保留的最近几何样本数量。 */
export const SAMPLE_KEEP = 5;

/** standalone 下顶部安全区解析为 0 时，头部用的 px 兜底（iOS 26.1 回归）。 */
export const SAFE_TOP_FALLBACK = 12;

/**
 * iOS 26.1 standalone 安全区回归判定：只有「已添加到主屏幕（standalone）+ 顶部
 * env(safe-area-inset-top) 解析为 0」时才启用 px 兜底；浏览器标签页模式不动，
 * 避免给正常 Safari 界面凭空加 padding。
 * @param {{standalone?:boolean, safeTop?:number}} input
 * @returns {boolean}
 */
export function needsSafeTopFallback(input) {
  const standalone = Boolean(input && input.standalone);
  const safeTop = Math.max(0, Number(input && input.safeTop) || 0);
  return standalone && safeTop < 4;
}

/** initViewport 注册的刷新函数（openReader/openLibraryPanel 等可在布局变化后主动重测）。 */
let activeRefresh = null;

/** 手动触发一次视口几何重算（已初始化过才生效）。 */
export function refreshViewport() {
  if (typeof activeRefresh === 'function') activeRefresh();
}

/**
 * 输入框/可编辑元素判定。
 * @param {unknown} el
 * @returns {boolean}
 */
export function isEditableElement(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * 键盘遮挡高度：布局视口高度 - 可视视口高度。
 *
 * 注意：不能减去 visualViewport.offsetTop。iOS Safari 在键盘弹起后会做
 * 「reveal-scroll」——把可视视口整体往下平移 offsetTop（≈300–700px）以便露出
 * 输入框，此时可视区高度仍是「布局视口 - 键盘」，offsetTop 是这次平移量、
 * 不是键盘遮挡量。把 offsetTop 减进来会让算出的 inset 接近 0，从而把真实
 * 键盘态误判成「键盘已收起」（真机问题根因）。
 * @param {{visualHeight:number, layoutHeight:number}} metrics
 * @returns {number} 非负整数 px
 */
export function computeKeyboardInset(metrics) {
  const layoutHeight = Number(metrics && metrics.layoutHeight) || 0;
  const visualHeight = Number(metrics && metrics.visualHeight) || 0;
  return Math.max(0, Math.round(layoutHeight - visualHeight));
}

/**
 * 判定「键盘弹起」。两个信号任一成立即可（iOS 26 Safari 的键盘期不一定同时出现）：
 *   - shrink：可视视口比布局视口矮了 KB_MIN_INSET 以上（常规键盘遮挡量）；
 *   - pan：可视视口被整体下移 offsetTop（iOS 26 键盘期 Safari 会 pan 可视视口露出输入框，
 *     此时 shrink 可能滞后甚至为 0）。pan 信号必须伴随 shrink>0，避免把「键盘已收起但
 *     offsetTop 残留」误判成键盘态（stale 归零规则保持）。
 * 另需可编辑元素聚焦、页面可见、非捏合缩放。
 * @param {{inset?:number, pan?:number, hasEditableFocus:boolean, scale?:number}} input
 * @returns {boolean}
 */
export function shouldTreatAsKeyboard(input = {}) {
  const shrink = Math.max(0, Number(input.inset) || 0);
  const pan = Math.max(0, Number(input.pan) || 0);
  const scale = typeof input.scale === 'number' ? input.scale : 1;
  const focused = Boolean(input.hasEditableFocus);
  const scaleReliable = Math.abs(scale - 1) <= 0.01;
  const shrinkSignal = shrink >= KB_MIN_INSET;
  const panSignal = pan >= KB_MIN_INSET && shrink > 0;
  return focused && scaleReliable && (shrinkSignal || panSignal);
}

/**
 * 把一次原始视口采样规划成可安全写入 DOM 的几何（纯函数，便于单测）。
 *
 * 关键规则：
 *   - shellHeight 无键盘时 = 布局视口高度（innerHeight，随地址栏收放；不用 100dvh）；
 *     键盘弹起时 = 可视视口高度（视觉视口可能比布局视口矮一个键盘）。
 *   - offsetTop 只有「键盘确实弹起 + 页面可见」时才作为 reveal-scroll 补偿保留；
 *     其余（键盘收起残留、页面隐藏/bcache 残留）一律归零，避免整壳位移。
 *   - visualViewport 缺失/为 0（后台标签、bfcache、首帧前）时沿用布局视口。
 *
 * @param {{layoutHeight?:number, visualHeight?:number, offsetTop?:number, scale?:number,
 *          hasEditableFocus?:boolean, pageVisible?:boolean}} metrics
 * @returns {{shellHeight:number, keyboardInset:number, offsetTop:number,
 *            keyboardVisible:boolean, staleOffsetReset:boolean, scaleReliable:boolean}}
 */
export function computeStableViewport(metrics = {}) {
  const layoutHeight = Math.max(0, Number(metrics.layoutHeight) || 0);
  const visualHeight = Math.max(0, Number(metrics.visualHeight) || 0);
  const rawOffsetTop = Math.max(0, Number(metrics.offsetTop) || 0);
  const scrollY = Math.max(0, Number(metrics.scrollY) || 0);
  const scale = typeof metrics.scale === 'number' && metrics.scale > 0 ? metrics.scale : 1;
  const hasEditableFocus = Boolean(metrics.hasEditableFocus);
  const pageVisible = metrics.pageVisible !== false;
  const scaleReliable = Math.abs(scale - 1) <= 0.01;

  const baseline = layoutHeight || visualHeight;
  const visual = visualHeight || baseline;
  // shrink = 可视视口比布局视口矮多少（键盘遮挡量，不含 offsetTop 平移量）；
  const shrink = computeKeyboardInset({
    layoutHeight: layoutHeight || visual,
    visualHeight: visual,
  });
  const keyboardVisible = shouldTreatAsKeyboard({
    inset: shrink,
    pan: rawOffsetTop,
    hasEditableFocus: hasEditableFocus && pageVisible,
    scale,
  });

  // shell 高度的合理性校验：无可编辑焦点、offsetTop 为 0，但可视视口比布局视口矮
  // 80px 以上 → 这是浏览器 chrome（地址栏/底部悬浮栏）外露，不是键盘。
  // 此时不能把 shell 压到 visualViewport.height（会留下约 chrome 高度的底部空白，
  // 正是用户真机截图里的 ~200px 空白），应按布局视口满高渲染。
  const chromeExposed =
    !keyboardVisible &&
    rawOffsetTop === 0 &&
    !hasEditableFocus &&
    baseline > 0 &&
    visual > 0 &&
    baseline - visual > CHROME_GAP_MIN;

  // 键盘态：壳体同时绑定「高 = 可视视口高」「top = 可视视口顶」：
  //   appTop = visualViewport.offsetTop（Safari 把可视视口下移了多少，壳就下移多少）
  //          + window.scrollY（H1：若 iOS 实际滚的是文档，文档滚动已把 absolute 壳上移，
  //            这里把滚动量加回 top，使壳仍对齐可视视口顶）。
  // 非键盘态：布局视口高度随地址栏收放；top 归零（chrome 外露行为）。
  const shellHeight = keyboardVisible
    ? Math.min(visual, baseline || visual)
    : baseline || visual;
  const appTop = keyboardVisible ? rawOffsetTop + scrollY : 0;
  const staleOffsetReset = !keyboardVisible && (rawOffsetTop > 0 || scrollY > 0);

  return {
    shellHeight: Math.round(shellHeight),
    keyboardInset: keyboardVisible ? Math.round(shrink) : 0,
    // 键盘态整壳 top 偏移（CSS --app-top）；offsetTop 字段保留为同义值，兼容 诊断/测试。
    appTop: scaleReliable ? Math.round(appTop) : 0,
    offsetTop: scaleReliable ? Math.round(appTop) : 0,
    keyboardVisible,
    staleOffsetReset,
    chromeExposed,
    scaleReliable,
    pan: Math.round(rawOffsetTop),
    scrollY: Math.round(scrollY),
  };
}

/**
 * 读取安全区（env(safe-area-inset-*)）的当前计算值，单位 px；非浏览器环境返回 0。
 * @param {Document} [doc]
 * @returns {{safeTop:number, safeBottom:number, safeRight:number, safeLeft:number,
 *            safeTopRaw:string, safeBottomRaw:string}}
 */
export function readSafeArea(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const result = {
    safeTop: 0,
    safeBottom: 0,
    safeRight: 0,
    safeLeft: 0,
    safeTopRaw: '',
    safeBottomRaw: '',
  };
  if (!d || typeof getComputedStyle !== 'function') return result;
  const rootEl = d.documentElement;
  if (!rootEl) return result;
  try {
    const cs = getComputedStyle(rootEl);
    result.safeTopRaw = (cs.getPropertyValue('--safe-top') || '').trim();
    result.safeBottomRaw = (cs.getPropertyValue('--safe-bottom') || '').trim();
    result.safeTop = parseFloat(result.safeTopRaw) || 0;
    result.safeBottom = parseFloat(result.safeBottomRaw) || 0;
    const safeRightRaw = (cs.getPropertyValue('--safe-right') || '').trim();
    const safeLeftRaw = (cs.getPropertyValue('--safe-left') || '').trim();
    result.safeRight = parseFloat(safeRightRaw) || 0;
    result.safeLeft = parseFloat(safeLeftRaw) || 0;
    if (!result.safeTopRaw) {
      // 自定义属性被覆盖时，用探针元素的实际 padding 计算值兜底。
      const probe = d.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);';
      document.body.appendChild(probe);
      const pcs = getComputedStyle(probe);
      result.safeTop = parseFloat(pcs.paddingTop) || 0;
      result.safeBottom = parseFloat(pcs.paddingBottom) || 0;
      result.safeRight = parseFloat(pcs.paddingRight) || 0;
      result.safeLeft = parseFloat(pcs.paddingLeft) || 0;
      result.safeTopRaw = probe.style.paddingTop;
      result.safeBottomRaw = probe.style.paddingBottom;
      probe.remove();
    }
  } catch {
    /* 诊断不因此中断 */
  }
  return result;
}

/**
 * 读取一次原始视口采样（纯函数：只读传入的 window/document）。
 * @param {Window} win
 * @param {Document} [doc]
 * @param {{forceVisible?:boolean}} [options]
 */
export function readViewportMetrics(win, doc, options = {}) {
  const d = doc || (win ? win.document : null);
  const vv = win ? win.visualViewport : null;
  const docEl = d ? d.documentElement : null;
  const pageVisible = typeof d !== 'undefined' && d ? d.visibilityState !== 'hidden' : true;
  const safe = readSafeArea(d);
  return {
    layoutHeight: win ? win.innerHeight : 0,
    visualHeight: vv ? vv.height : 0,
    offsetTop: vv ? vv.offsetTop : 0,
    scale: vv ? vv.scale : 1,
    hasEditableFocus: isEditableElement(d ? d.activeElement : null),
    pageVisible: options.forceVisible ? true : pageVisible,
    layoutOffsetTop: win && typeof win.scrollY === 'number' ? Math.max(0, win.scrollY) : 0,
    documentScrollTop: docEl ? Math.max(0, docEl.scrollTop || 0) : 0,
    clientHeight: docEl ? docEl.clientHeight : 0,
    safeTop: safe.safeTop,
    safeBottom: safe.safeBottom,
    safeTopRaw: safe.safeTopRaw,
    safeBottomRaw: safe.safeBottomRaw,
  };
}

/**
 * 启动键盘/视口跟随。只写 CSS 变量与根元素类名，不直接改元素样式。
 *
 * 写入：
 *   --app-height       app shell 高度（非键盘态=布局视口，键盘态=可视视口）
 *   --keyboard-inset   键盘遮挡高度（未弹起为 0，仅用于诊断/布局参考）
 *   --app-top         键盘态整壳 top 偏移 = visualViewport.offsetTop + scrollY（非键盘态 0）
 *   --vv-offset-top   同 --app-top（兼容 诊断/测试字段）
 * 根元素类名：
 *   kb-visible / kb-animating / kb-settled / has-vv-drift / vv-ready
 *
 * @param {{root?:Document, onResize?:()=>void, window?:Window, debug?:boolean}} [options]
 * @returns {() => void} cleanup
 */
export function initViewport(options = {}) {
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const doc = options.root || (win ? win.document : null);
  const onResize = typeof options.onResize === 'function' ? options.onResize : () => {};
  const debug = Boolean(options.debug);
  if (!win || !doc) return () => {};
  const rootEl = doc.documentElement;

  const prev = { appHeight: 0, inset: 0, offsetTop: 0, appTop: 0, pan: 0, scrollY: 0, visible: false };
  let rafId = 0;
  let settleTimer = 0;
  let settleStep = 0;
  let recoverTimers = [];
  let hasEditableFocus = false;
  let disposed = false;
  /** ?diag=1 展示用的最近几何样本（环形保留最近 SAMPLE_KEEP 次）。 */
  const samples = [];

  function recordSample(raw, plan) {
    const now = win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now();
    samples.push({
      t: Math.round(now),
      layoutHeight: Math.round(raw.layoutHeight || 0),
      clientHeight: Math.round(raw.clientHeight || 0),
      visualHeight: Math.round(raw.visualHeight || 0),
      offsetTop: Math.round(raw.offsetTop || 0),
      scale: Number(raw.scale) || 1,
      safeTop: Math.round((raw.safeTop || 0) * 10) / 10,
      safeBottom: Math.round((raw.safeBottom || 0) * 10) / 10,
      scrollTop: Math.round(raw.documentScrollTop || 0),
      scrollY: Math.round(raw.layoutOffsetTop || 0),
      shellHeight: plan.shellHeight,
      appTop: plan.appTop,
      keyboardVisible: plan.keyboardVisible,
      chromeExposed: Boolean(plan.chromeExposed),
      staleOffsetReset: Boolean(plan.staleOffsetReset),
    });
    while (samples.length > SAMPLE_KEEP) samples.shift();
  }

  function editableFocused() {
    return isEditableElement(doc.activeElement);
  }

  function clearRecoverTimers() {
    for (const timer of recoverTimers) win.clearTimeout(timer);
    recoverTimers = [];
  }

  /** 键盘收起/页面恢复后 iOS 可能延迟复位 offsetTop：多档延时补采样（末档强制重写）。 */
  function scheduleRecover() {
    clearRecoverTimers();
    for (const delay of RECOVER_DELAYS) {
      recoverTimers.push(win.setTimeout(() => schedule(), delay));
    }
    recoverTimers.push(win.setTimeout(() => scheduleForce(), RECOVER_DELAYS[RECOVER_DELAYS.length - 1] + 60));
  }

  function markAnimating() {
    settleStep = 0;
    clearTimeout(settleTimer);
    rootEl.classList.add('kb-animating');
    rootEl.classList.remove('kb-settled');
    let elapsed = 0;
    const tick = () => {
      if (disposed) return;
      schedule();
      if (settleStep >= SETTLE_LADDER.length) {
        rootEl.classList.remove('kb-animating');
        rootEl.classList.add('kb-settled');
        return;
      }
      const next = SETTLE_LADDER[settleStep];
      settleStep += 1;
      settleTimer = win.setTimeout(tick, Math.max(0, next - elapsed));
      elapsed = next;
    };
    tick();
  }

  /** 采样 + 规划 + 写 DOM；返回本次写入的几何（诊断/测试用）。
   *  force=true 时即使规划结果与上次相同也重写 DOM（bfcache/外部残留值的自愈路径）。 */
  function measureAndApply(options = {}) {
    const force = Boolean(options && options.force);
    const raw = readViewportMetrics(win, doc);
    hasEditableFocus = raw.hasEditableFocus;
    const plan = computeStableViewport({ ...raw, scrollY: raw.layoutOffsetTop, hasEditableFocus });
    // H1：iOS 也可能滚文档而不是 pan 可视视口。本应用是固定壳布局，文档本不该滚动；
    // 非键盘态发现 scrollY>0 时先复位（键盘态不强行 scrollTo，避免和 Safari reveal 打架，
    // 而是把 scrollY 计入 appTop 合成偏移）。
    if (!plan.keyboardVisible && plan.scrollY > 0 && typeof win.scrollTo === 'function') {
      try {
        win.scrollTo(0, 0);
      } catch {
        /* 忽略：某些 WebView 禁止滚动复位 */
      }
      schedule();
    }
    const appHeight = plan.shellHeight;
    const inset = plan.keyboardInset;
    const visible = plan.keyboardVisible;

    const heightChanged = Math.abs(appHeight - prev.appHeight) >= 1;
    recordSample(raw, plan);

    if (
      !force &&
      !heightChanged &&
      inset === prev.inset &&
      plan.appTop === prev.appTop &&
      visible === prev.visible
    ) {
      return plan;
    }

    const wasVisible = prev.visible;
    prev.appHeight = appHeight;
    prev.inset = inset;
    prev.offsetTop = plan.offsetTop;
    prev.appTop = plan.appTop;
    prev.pan = plan.pan;
    prev.scrollY = plan.scrollY;
    prev.visible = visible;

    rootEl.style.setProperty('--app-height', `${appHeight}px`);
    rootEl.style.setProperty('--keyboard-inset', `${inset}px`);
    // 键盘态壳体 top 绑定 visualViewport.offsetTop；--vv-offset-top 保留同义值兼容 。
    rootEl.style.setProperty('--app-top', `${plan.appTop}px`);
    rootEl.style.setProperty('--vv-offset-top', `${plan.offsetTop}px`);
    rootEl.classList.toggle('kb-visible', visible);
    rootEl.classList.toggle('has-vv-drift', plan.appTop > 0);
    rootEl.classList.add('vv-ready');

    if (visible !== wasVisible) {
      markAnimating();
      if (!visible) scheduleRecover();
    }
    if (heightChanged) onResize({ appHeight, keyboardInset: inset, keyboardVisible: visible });
    return plan;
  }

  function apply(force = false) {
    rafId = 0;
    if (disposed) return;
    measureAndApply({ force });
  }

  function schedule() {
    if (rafId || disposed) return;
    rafId = win.requestAnimationFrame(() => apply(false));
  }

  /** 强制重写一次几何：用于 pageshow/可见性恢复/阅读器打开等「DOM 可能被外部污染」的时机。 */
  function scheduleForce() {
    if (disposed) return;
    if (rafId) win.cancelAnimationFrame(rafId);
    rafId = 0;
    rafId = win.requestAnimationFrame(() => apply(true));
  }

  function onFocusIn() {
    hasEditableFocus = editableFocused();
    if (hasEditableFocus) {
      schedule();
      markAnimating();
      // 键盘动画期 vv 值会连续变化：rAF×2 + 350ms 各强制重同步一次（research D）。
      win.requestAnimationFrame(() => win.requestAnimationFrame(scheduleForce));
      win.setTimeout(() => {
        if (!disposed) scheduleForce();
      }, 350);
    }
  }

  function onFocusOut() {
    win.requestAnimationFrame(() => {
      if (disposed) return;
      hasEditableFocus = editableFocused();
      if (!hasEditableFocus) {
        schedule();
        scheduleRecover();
      }
    });
  }

  function onOrientation() {
    // 旋转后布局视口与可视视口都还没稳定，等两帧再量。
    win.requestAnimationFrame(() => win.requestAnimationFrame(schedule));
  }

  function onPageShow() {
    // bfcache 恢复：页面可能带着 stale offsetTop/旧高度回来（DOM 与模块内存都可能是旧的），
    // 立即重采样并强制重写几何，确保不会带着错误状态继续渲染。
    scheduleForce();
    win.requestAnimationFrame(() => {
      scheduleForce();
      scheduleRecover();
    });
  }

  function onVisibility() {
    if (doc.visibilityState === 'visible') onPageShow();
  }

  const vv = win.visualViewport;
  if (vv) {
    vv.addEventListener('resize', schedule, { passive: true });
    vv.addEventListener('scroll', schedule, { passive: true });
  }
  win.addEventListener('resize', schedule, { passive: true });
  win.addEventListener('orientationchange', onOrientation, { passive: true });
  win.addEventListener('pageshow', onPageShow, { passive: true });
  doc.addEventListener('visibilitychange', onVisibility, { passive: true });
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);

  // 稳定的初始几何 + 供 ?diag=1 与自动化测试使用的调试入口。
  apply();
  rootEl.classList.add('vv-ready');

  const debugApi = {
    refresh(options = {}) {
      measureAndApply({ force: options.force !== false });
      return prev;
    },
    plan: computeStableViewport,
    metrics: () => readViewportMetrics(win, doc),
    safeArea: () => readSafeArea(doc),
    samples: () => samples.map((item) => ({ ...item })),
    /** 用给定采样走一遍「规划 → 写 DOM」，返回写入的几何（只给 ?diag=1 的测试/诊断用）。 */
    applyForTest(metrics) {
      const plan = computeStableViewport(metrics);
      prev.appHeight = plan.shellHeight;
      prev.inset = plan.keyboardInset;
      prev.offsetTop = plan.offsetTop;
      prev.appTop = plan.appTop;
      prev.pan = plan.pan;
      prev.scrollY = plan.scrollY;
      prev.visible = plan.keyboardVisible;
      rootEl.style.setProperty('--app-height', `${plan.shellHeight}px`);
      rootEl.style.setProperty('--keyboard-inset', `${plan.keyboardInset}px`);
      rootEl.style.setProperty('--app-top', `${plan.appTop}px`);
      rootEl.style.setProperty('--vv-offset-top', `${plan.offsetTop}px`);
      rootEl.classList.toggle('kb-visible', plan.keyboardVisible);
      rootEl.classList.toggle('has-vv-drift', plan.appTop > 0);
      rootEl.classList.add('vv-ready');
      return plan;
    },
    last: prev,
  };
  if (debug && win) {
    win.__vvDebug = debugApi;
    if (win.__vvDiag && typeof win.__vvDiag === 'object') {
      Object.assign(win.__vvDiag, debugApi);
    }
  }

  activeRefresh = () => {
    if (!disposed) scheduleForce();
  };

  return function cleanup() {
    disposed = true;
    if (activeRefresh) activeRefresh = null;
    clearTimeout(settleTimer);
    clearRecoverTimers();
    if (rafId) win.cancelAnimationFrame(rafId);
    if (vv) {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
    }
    win.removeEventListener('resize', schedule);
    win.removeEventListener('orientationchange', onOrientation);
    win.removeEventListener('pageshow', onPageShow);
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    if (win.__vvDebug === debugApi) delete win.__vvDebug;
  };
}
