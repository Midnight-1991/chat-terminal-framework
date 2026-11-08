// viewport-diag.js — `?diag=1` 真机视口几何诊断面板。
//
// 用途：用户在 iPhone 真机打开 `?diag=1` 后，面板直接显示 Safari 暴露的视口几何
// （innerHeight / visualViewport.height / offsetTop / scale / env(safe-area-inset-*)、
// app/reader/reader-scroll 的实际 rect、最近 5 次几何采样），可截图或点「复制」把
// JSON 发回，用真实数据定位「顶部被遮 / 底部空白 / 键盘收起残留 offsetTop」类问题。
//
// 只在 `?diag=1` 时渲染；正常访问零开销。面板本身用 absolute 定位（不用 fixed），
// 避免再依赖 iOS 26 有缺陷的 fixed 绘制路径。

import { readSafeArea, readViewportMetrics } from './viewport.js';

const PANEL_ID = 'viewportDiag';

/** @param {Window} win */
export function isDiagMode(win) {
  try {
    return new URLSearchParams(win.location.search).get('diag') === '1';
  } catch {
    return false;
  }
}

function round(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function rectOf(doc, selector) {
  const el = typeof selector === 'string' ? doc.querySelector(selector) : selector;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: round(r.top), bottom: round(r.bottom), height: round(r.height), width: round(r.width) };
}

/**
 * 采集一次完整诊断报告（供面板渲染与「复制」）。
 * @param {Window} win
 * @param {Document} doc
 */
export function collectViewportReport(win, doc) {
  const debug = win.__vvDebug || win.__vvDiag || {};
  let raw;
  try {
    raw = typeof debug.metrics === 'function' ? debug.metrics() : readViewportMetrics(win, doc);
  } catch {
    raw = readViewportMetrics(win, doc);
  }
  let safe;
  try {
    safe = typeof debug.safeArea === 'function' ? debug.safeArea() : readSafeArea(doc);
  } catch {
    safe = readSafeArea(doc);
  }
  let samples = [];
  try {
    samples = typeof debug.samples === 'function' ? debug.samples() : [];
  } catch {
    samples = [];
  }
  const lastPlan = debug.last && typeof debug.last === 'object' ? debug.last : {};

  const root = doc.documentElement;
  const cs = win.getComputedStyle(root);
  const readerScroll = doc.getElementById('readerScroll');
  const reader = doc.getElementById('reader');
  const readerHead = doc.querySelector('.reader-head');
  const composerBar = doc.getElementById('composerBar');
  const composerInput = doc.getElementById('input');
  const active = doc.activeElement;
  const vv = win.visualViewport;
  const composerRect = rectOf(doc, composerBar);
  const composerInputRect = rectOf(doc, composerInput);

  return {
    generatedAt: new Date().toISOString(),
    href: win.location.href,
    userAgent: win.navigator.userAgent,
    devicePixelRatio: win.devicePixelRatio,
    viewer: {
      innerHeight: win.innerHeight,
      innerHeightType: typeof win.innerHeight,
      clientHeight: root.clientHeight,
      scrollY: round(win.scrollY),
      visualViewport: {
        width: raw.visualHeight ? round(win.visualViewport ? win.visualViewport.width : null) : null,
        height: round(raw.visualHeight),
        offsetTop: round(raw.offsetTop),
        offsetLeft: round(win.visualViewport ? win.visualViewport.offsetLeft : null),
        scale: round(raw.scale),
        pageLeft: round(win.visualViewport ? win.visualViewport.pageLeft : null),
        pageTop: round(win.visualViewport ? win.visualViewport.pageTop : null),
      },
      pageVisible: raw.pageVisible !== false,
      documentScrollTop: round(raw.documentScrollTop),
      standalone: Boolean(
        (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches) ||
          win.navigator.standalone === true,
      ),
      matchMediaStandalone: Boolean(win.matchMedia && win.matchMedia('(display-mode: standalone)').matches),
      locationSearch: String(win.location && win.location.search ? win.location.search : ''),
      activeElement: active
        ? {
            tag: active.tagName ? active.tagName.toLowerCase() : null,
            id: active.id || null,
            className: typeof active.className === 'string' ? active.className : null,
            editable: active.isContentEditable === true || ['INPUT', 'TEXTAREA'].includes(active.tagName),
          }
        : null,
    },
    safeArea: {
      top: round(safe.safeTop),
      bottom: round(safe.safeBottom),
      right: round(safe.safeRight),
      left: round(safe.safeLeft),
      topRaw: safe.safeTopRaw,
      bottomRaw: safe.safeBottomRaw,
    },
    shell: {
      appHeight: (cs.getPropertyValue('--app-height') || '').trim(),
      appTop: (cs.getPropertyValue('--app-top') || '').trim(),
      vvOffsetTop: (cs.getPropertyValue('--vv-offset-top') || '').trim(),
      keyboardInset: (cs.getPropertyValue('--keyboard-inset') || '').trim(),
      classes: root.className,
      kbVisible: root.classList.contains('kb-visible'),
      kbAnimating: root.classList.contains('kb-animating'),
      kbSettled: root.classList.contains('kb-settled'),
      hasVvDrift: root.classList.contains('has-vv-drift'),
      appRect: rectOf(doc, '#app'),
    },
    keyboard: {
      visible: root.classList.contains('kb-visible'),
      plannedShellHeight: round(lastPlan.appHeight),
      plannedInset: round(lastPlan.inset),
      plannedOffsetTop: round(lastPlan.offsetTop),
      plannedAppTop: round(lastPlan.appTop),
      panned: round(lastPlan.pan),
      plannedScrollY: round(lastPlan.scrollY),
      kbMinInset: 60,
    },
    composer: {
      barRect: composerRect,
      inputRect: composerInputRect,
      inputValueLength: composerInput ? String(composerInput.value || '').length : null,
      // 输入框/输入区底边相对「可视视口底边」的距离：键盘态应接近 0（贴在键盘上沿）。
      barBottomGapToVisual: composerRect && vv
        ? round(vv.height - (composerRect.bottom - vv.offsetTop))
        : null,
      inputBottomGapToVisual: composerInputRect && vv
        ? round(vv.height - (composerInputRect.bottom - vv.offsetTop))
        : null,
      barTopScreen: composerRect && vv ? round(composerRect.top - vv.offsetTop) : null,
      barBottomScreen: composerRect && vv ? round(composerRect.bottom - vv.offsetTop) : null,
      inputTopScreen: composerInputRect && vv ? round(composerInputRect.top - vv.offsetTop) : null,
      inputBottomScreen: composerInputRect && vv ? round(composerInputRect.bottom - vv.offsetTop) : null,
    },
    reader: {
      hidden: Boolean(reader && reader.hidden),
      open: Boolean(reader && reader.classList.contains('is-open')),
      readerRect: rectOf(doc, reader),
      headRect: rectOf(doc, readerHead),
      scrollRect: rectOf(doc, readerScroll),
      scrollTop: readerScroll ? round(readerScroll.scrollTop) : null,
      scrollHeight: readerScroll ? round(readerScroll.scrollHeight) : null,
      clientHeight: readerScroll ? round(readerScroll.clientHeight) : null,
      title: (() => {
        const el = doc.getElementById('readerTitle');
        return el ? (el.textContent || '').trim() : null;
      })(),
    },
    samples,
  };
}

function row(doc, parent, key, value) {
  const line = doc.createElement('div');
  line.className = 'viewport-diag-row';
  const k = doc.createElement('span');
  k.className = 'viewport-diag-key';
  k.textContent = key;
  const v = doc.createElement('span');
  v.className = 'viewport-diag-val';
  v.textContent = value == null ? '—' : String(value);
  line.append(k, v);
  parent.append(line);
  return line;
}

function section(doc, parent, text) {
  const head = doc.createElement('div');
  head.className = 'viewport-diag-sec';
  head.textContent = text;
  parent.append(head);
  return head;
}

/**
 * 渲染诊断面板。非 `?diag=1` 直接返回 null。
 * @param {{window?:Window, document?:Document}} [options]
 * @returns {{report:()=>object, refresh:()=>object, close:()=>void, element:Element}|null}
 */
export function initViewportDiag(options = {}) {
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const doc = options.document || (win ? win.document : null);
  if (!win || !doc || !isDiagMode(win)) return null;

  const panel = doc.createElement('aside');
  panel.id = PANEL_ID;
  panel.className = 'viewport-diag';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  panel.setAttribute('data-testid', 'viewport-diag');

  const head = doc.createElement('div');
  head.className = 'viewport-diag-head';
  const title = doc.createElement('strong');
  title.className = 'viewport-diag-title';
  title.textContent = '视口诊断 ?diag=1';
  const refreshBtn = doc.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'viewport-diag-btn';
  refreshBtn.textContent = '刷新';
  const copyBtn = doc.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'viewport-diag-btn';
  copyBtn.textContent = '复制';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'viewport-diag-btn';
  closeBtn.textContent = '关闭';
  head.append(title, refreshBtn, copyBtn, closeBtn);

  const body = doc.createElement('div');
  body.className = 'viewport-diag-body';
  panel.append(head, body);

  let timer = 0;
  let lastReport = null;

  function report() {
    lastReport = collectViewportReport(win, doc);
    return lastReport;
  }

  function render() {
    const data = report();
    const vv = data.viewer.visualViewport;
    const r = data.reader;
    body.replaceChildren();

    section(doc, body, '布局视口');
    row(doc, body, 'typeof innerHeight', data.viewer.innerHeightType);
    row(doc, body, 'innerHeight', data.viewer.innerHeight);
    row(doc, body, 'documentElement.clientHeight', data.viewer.clientHeight);
    row(doc, body, 'window.scrollY', data.viewer.scrollY);
    row(doc, body, 'documentElement.scrollTop', data.viewer.documentScrollTop);
    row(doc, body, 'standalone / matchMedia', `${data.viewer.standalone} / ${data.viewer.matchMediaStandalone}`);
    row(doc, body, 'location.search', data.viewer.locationSearch || '（空）');
    row(doc, body, 'dpr / visible', `${data.devicePixelRatio} / ${data.viewer.pageVisible}`);

    section(doc, body, 'visualViewport');
    row(doc, body, 'vv.height', vv.height);
    row(doc, body, 'vv.offsetTop / offsetLeft', `${vv.offsetTop} / ${vv.offsetLeft}`);
    row(doc, body, 'vv.scale', vv.scale);
    row(doc, body, 'vv.width', vv.width);
    row(doc, body, 'vv.pageTop / pageLeft', `${vv.pageTop} / ${vv.pageLeft}`);

    section(doc, body, '安全区 env()');
    row(doc, body, 'safe-area-inset-top', `${data.safeArea.top}（原始 ${data.safeArea.topRaw || '—'}）`);
    row(doc, body, 'safe-area-inset-bottom', `${data.safeArea.bottom}（原始 ${data.safeArea.bottomRaw || '—'}）`);
    row(doc, body, 'safe-area-inset-right / left', `${data.safeArea.right} / ${data.safeArea.left}`);

    section(doc, body, 'shell 几何');
    row(doc, body, '--app-height', data.shell.appHeight);
    row(doc, body, '--app-top', data.shell.appTop);
    row(doc, body, '--vv-offset-top（同义）', data.shell.vvOffsetTop);
    row(doc, body, '--keyboard-inset', data.shell.keyboardInset);
    row(doc, body, 'html.class', data.shell.classes);
    row(doc, body, 'kb-visible / animating / settled / drift', `${data.shell.kbVisible} / ${data.shell.kbAnimating} / ${data.shell.kbSettled} / ${data.shell.hasVvDrift}`);
    const app = data.shell.appRect;
    row(doc, body, 'app rect top/bottom', app ? `${app.top} / ${app.bottom}` : '—');
    row(doc, body, 'app height', app ? app.height : '—');

    section(doc, body, '键盘 / 输入区');
    row(doc, body, 'kb-visible', String(data.keyboard.visible));
    row(doc, body, '规划 shell / inset / offsetTop', `${data.keyboard.plannedShellHeight} / ${data.keyboard.plannedInset} / ${data.keyboard.plannedOffsetTop}`);
    row(doc, body, '规划 appTop（=pan + scrollY）', `${data.keyboard.plannedAppTop}（pan ${data.keyboard.panned} + scrollY ${data.keyboard.plannedScrollY}）`);
    row(doc, body, 'activeElement', data.viewer.activeElement
      ? `${data.viewer.activeElement.tag}${data.viewer.activeElement.id ? '#' + data.viewer.activeElement.id : ''}${data.viewer.activeElement.className ? '.' + String(data.viewer.activeElement.className).split(/\s+/).join('.') : ''}${data.viewer.activeElement.editable ? '（可编辑）' : ''}`
      : '—');
    const composer = data.composer;
    row(doc, body, 'composerBar rect', composer.barRect
      ? `${composer.barRect.top} → ${composer.barRect.bottom}（h ${composer.barRect.height}）`
      : '—');
    row(doc, body, 'composer input rect', composer.inputRect
      ? `${composer.inputRect.top} → ${composer.inputRect.bottom}（h ${composer.inputRect.height}）`
      : '—');
    row(doc, body, 'composerBar 屏幕 top→bottom', `${composer.barTopScreen} → ${composer.barBottomScreen}`);
    row(doc, body, 'composer 底边距可视底', composer.barBottomGapToVisual);
    row(doc, body, 'input 底边距可视底', composer.inputBottomGapToVisual);

    section(doc, body, '阅读器');
    row(doc, body, 'reader open/hidden', `${r.open} / ${r.hidden}`);
    row(doc, body, 'reader rect', r.readerRect ? `${r.readerRect.top} → ${r.readerRect.bottom}（h ${r.readerRect.height}）` : '—');
    row(doc, body, 'reader-head rect', r.headRect ? `${r.headRect.top} → ${r.headRect.bottom}（h ${r.headRect.height}）` : '—');
    row(doc, body, 'reader-scroll rect', r.scrollRect ? `${r.scrollRect.top} → ${r.scrollRect.bottom}（h ${r.scrollRect.height}）` : '—');
    row(doc, body, 'readerScroll.scrollTop', r.scrollTop);
    row(doc, body, 'scrollHeight / clientHeight', `${r.scrollHeight} / ${r.clientHeight}`);
    row(doc, body, 'reader title', r.title);

    section(doc, body, `最近 ${data.samples.length} 次几何采样`);
    if (data.samples.length === 0) {
      row(doc, body, 'samples', '（暂无）');
    } else {
      for (const s of data.samples) {
        const line = doc.createElement('div');
        line.className = 'viewport-diag-sample';
        line.textContent = `t${s.t} L${s.layoutHeight}/C${s.clientHeight} V${s.visualHeight} off${s.offsetTop} → shell${s.shellHeight}${s.keyboardVisible ? ' 键盘' : ''}${s.chromeExposed ? ' chrome' : ''}${s.staleOffsetReset ? ' stale复位' : ''}`;
        body.append(line);
      }
    }
    return data;
  }

  function refresh() {
    if (typeof win.__vvDebug?.refresh === 'function') win.__vvDebug.refresh();
    return render();
  }

  async function copyReport() {
    const data = lastReport || report();
    const text = JSON.stringify(data, null, 2);
    try {
      if (win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') {
        await win.navigator.clipboard.writeText(text);
      } else {
        const area = doc.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.cssText = 'position:absolute;left:-9999px;top:0;';
        doc.body.append(area);
        area.select();
        doc.execCommand('copy');
        area.remove();
      }
      copyBtn.textContent = '已复制';
      win.setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
    } catch {
      copyBtn.textContent = '复制失败';
    }
  }

  refreshBtn.addEventListener('click', refresh);
  copyBtn.addEventListener('click', () => { void copyReport(); });
  closeBtn.addEventListener('click', () => {
    panel.hidden = true;
    if (timer) win.clearInterval(timer);
    timer = 0;
  });

  doc.body.append(panel);
  render();
  timer = win.setInterval(() => {
    if (!panel.hidden) render();
  }, 500);

  const api = {
    report,
    refresh,
    close() {
      panel.hidden = true;
      if (timer) win.clearInterval(timer);
      timer = 0;
    },
    element: panel,
  };

  win.__vvDiag = Object.assign({}, win.__vvDebug || {}, win.__vvDiag || {}, api);
  return api;
}
