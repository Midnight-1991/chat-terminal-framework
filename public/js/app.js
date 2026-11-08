// app.js — 界面编排（v2）：会话抽屉 / 长期记忆 / 流式渲染 / 思维链 / 引用阅读器。
//
// 数据契约见 docs/API-CONTRACT.md：
// - v3：进入页面 POST /api/conversations 建会话；POST /api/chat 带 conversationId + memory，
//   meta 返回 conversationId/title/memoryUsed；抽屉用 /api/conversations、记忆用 /api/memories。
// - v1 兼容：v3 接口 404 时降级为 sessionId 内存会话（顶部标题变「本地会话」并提示）。
//
// 纯函数在 api.js / markup.js / sse.js / effort.js，键盘适配在 viewport.js。

import { consumeSSE } from './sse.js';
import {
  backgroundAssistantReady,
  domainOf,
  formatDuration,
  formatTerminalError,
  isBackgroundInterruption,
  isSendable,
  normalizeMessage,
  parseBackgroundPending,
  parseCitations,
  safeCutoff,
  safeExternalUrl,
  shortSessionId,
} from './markup.js';
import { effortLabel, loadEffort, normalizeEffort, saveEffort } from './effort.js';
import {
  initViewport,
  needsSafeTopFallback,
  readSafeArea,
  refreshViewport,
} from './viewport.js';
import { initViewportDiag, isDiagMode } from './viewport-diag.js';
import {
  ATTACHMENT_LIMITS,
  attachmentChipLabel,
  buildAttachmentPayload,
  canAddDraft,
  classifyAttachmentFile,
  countDraftKinds,
  formatBytes,
  normalizeMessageAttachments,
  normalizeMetaAttachments,
  safeAttachmentPreviewUrl,
  scaledSize,
} from './attachments.js';
import { readerNoticeFor } from './reader-notice.js';
import {
  ApiError,
  STORAGE,
  buildChatBody,
  charCountLabel,
  charCountNearLimit,
  buildScaleHistoryView,
  buildScaleTrend,
  conversationTitle,
  createApi,
  formatRelativeTime,
  formatScaleHistoryDateTime,
  healthViewFromPayload,
  loginUrlFor,
  memoryUsedLabel,
  normalizeWebSearchUsed,
  webCitationCount,
  webSearchRunLabel,
  webSearchViewFromHealth,
} from './api.js';

/** DATA-CONTRACT 5 固定消息：?demo=1 时自动发送一次，用于截图测试。 */
const DEMO_MESSAGE = '我最近一到晚上就很孤独，睡不着，脑子里全是以前做错的事。';
const LEGACY_SESSION_KEY = 'ctf.sessionId';
const NEAR_BOTTOM_PX = 96;
const OVERLAY_TRANSITION_MS = 240;
const TOAST_MS = 3400;
/** 离页后台续跑的待恢复记录与轮询参数（前端只轮询现有会话详情）。 */
const BG_PENDING_KEY = 'ctf.bg.pending';
const BG_POLL_INTERVAL_MS = 3000;
const BG_POLL_TIMEOUT_MS = 180000;
const BG_NEUTRAL_TEXT = '已转到后台继续生成，返回页面后自动显示结果';
/** 首次开启联网的一次性隐私提示（设备级只弹一次）。 */
const WEBSEARCH_HINT =
  '联网搜索会把当前问题（自动脱敏）发给 DeepSeek 搜索，结果仅供参考；隐私内容建议关闭。';

const $ = (id) => document.getElementById(id);

const dom = {
  app: $('app'),
  screen: $('screen'),
  empty: $('emptyState'),
  hello: $('helloGreeting'),
  jump: $('jump'),
  jumpLabel: $('jumpLabel'),
  composerBar: $('composerBar'),
  composer: $('composer'),
  attachBtn: $('attachBtn'),
  attachInput: $('chatAttachInput'),
  draftTray: $('draftTray'),
  memoryAttachBtn: $('memoryAttachBtn'),
  memoryAttachInput: $('memoryAttachInput'),
  memoryDraftTray: $('memoryDraftTray'),
  input: $('input'),
  send: $('send'),
  charCount: $('charCount'),
  convTitle: $('convTitle'),
  convSubtitle: $('convSubtitle'),
  drawerToggle: $('drawerToggle'),
  newChatBtn: $('newChatBtn'),
  drawer: $('drawer'),
  drawerClose: $('drawerClose'),
  drawerScrim: $('drawerScrim'),
  convList: $('convList'),
  convEmpty: $('convEmpty'),
  memoryEntry: $('memoryEntry'),
  memoryCount: $('memoryCount'),
  memoryPanel: $('memoryPanel'),
  memoryBack: $('memoryBack'),
  memoryClear: $('memoryClear'),
  memoryToggle: $('memoryToggle'),
  memoryList: $('memoryList'),
  memoryEmpty: $('memoryEmpty'),
  memoryForm: $('memoryForm'),
  memoryInput: $('memoryInput'),
  memoryChip: $('memoryChip'),
  memoryValue: $('memoryValue'),
  webSearchChip: $('webSearchChip'),
  webSearchValue: $('webSearchValue'),
  libraryEntry: $('libraryEntry'),
  libraryCount: $('libraryCount'),
  libraryPanel: $('libraryPanel'),
  libraryBack: $('libraryBack'),
  libraryClose: $('libraryClose'),
  libraryStats: $('libraryStats'),
  libraryStatus: $('libraryStatus'),
  libraryDisciplines: $('libraryDisciplines'),
  libraryGroups: $('libraryGroups'),
  libraryRetry: $('libraryRetry'),
  marksEntry: $('marksEntry'),
  marksCount: $('marksCount'),
  marksPanel: $('marksPanel'),
  marksBack: $('marksBack'),
  marksClose: $('marksClose'),
  marksStatus: $('marksStatus'),
  marksFavList: $('marksFavList'),
  marksFavCount: $('marksFavCount'),
  marksFavEmpty: $('marksFavEmpty'),
  marksExcList: $('marksExcList'),
  marksExcCount: $('marksExcCount'),
  marksExcEmpty: $('marksExcEmpty'),
  marksRetry: $('marksRetry'),
  scalesEntry: $('scalesEntry'),
  scalesCount: $('scalesCount'),
  scalesPanel: $('scalesPanel'),
  scalesBack: $('scalesBack'),
  scalesClose: $('scalesClose'),
  scalesStatus: $('scalesStatus'),
  scalesList: $('scalesList'),
  scalesForm: $('scalesForm'),
  scalesResult: $('scalesResult'),
  scalesRetry: $('scalesRetry'),
  scalesHistoryEntry: $('scalesHistoryEntry'),
  scalesHistory: $('scalesHistory'),
  scalesHistoryBack: $('scalesHistoryBack'),
  scalesHistoryStatus: $('scalesHistoryStatus'),
  scalesHistoryContent: $('scalesHistoryContent'),
  scalesHistoryChips: $('scalesHistoryChips'),
  scaleChart: $('scaleChart'),
  scaleChartTitle: $('scaleChartTitle'),
  scaleChartTip: $('scaleChartTip'),
  scaleChartNote: $('scaleChartNote'),
  scalesHistoryCount: $('scalesHistoryCount'),
  scalesHistoryList: $('scalesHistoryList'),
  scalesHistoryClear: $('scalesHistoryClear'),
  scalesHistoryConfirm: $('scalesHistoryConfirm'),
  scalesHistoryConfirmCancel: $('scalesHistoryConfirmCancel'),
  scalesHistoryConfirmClear: $('scalesHistoryConfirmClear'),
  scalesHistoryEmpty: $('scalesHistoryEmpty'),
  scalesHistoryRetry: $('scalesHistoryRetry'),
  healthEntry: $('healthEntry'),
  healthCount: $('healthCount'),
  healthPanel: $('healthPanel'),
  healthBack: $('healthBack'),
  healthClose: $('healthClose'),
  healthStatus: $('healthStatus'),
  healthLastImported: $('healthLastImported'),
  healthSummary: $('healthSummary'),
  healthList: $('healthList'),
  healthEmpty: $('healthEmpty'),
  healthClear: $('healthClear'),
  healthRetry: $('healthRetry'),
  effortChip: $('effortChip'),
  effortValue: $('effortValue'),
  effortSheet: $('effortSheet'),
  effortOptions: [...document.querySelectorAll('.effort-opt')],
  sessionChip: $('sessionChip'),
  stateChip: $('stateChip'),
  reader: $('reader'),
  readerCmd: $('readerCmd'),
  readerClose: $('readerClose'),
  readerScroll: $('readerScroll'),
  readerTitle: $('readerTitle'),
  readerMeta: $('readerMeta'),
  readerNotice: $('readerNotice'),
  readerTools: $('readerTools'),
  favoriteBtn: $('favoriteBtn'),
  favoriteIcon: $('favoriteIcon'),
  excerptBtn: $('excerptBtn'),
  readerBody: $('readerBody'),
  imageViewer: $('imageViewer'),
  imageViewerScrim: $('imageViewerScrim'),
  imageViewerImg: $('imageViewerImg'),
  imageViewerCaption: $('imageViewerCaption'),
  imageViewerClose: $('imageViewerClose'),
  toast: $('toast'),
  // 多用户入口（AUTH=off 时保持 hidden，旧行为不变）
  accountEntry: $('accountEntry'),
  accountName: $('accountName'),
  feedbackEntry: $('feedbackEntry'),
  adminEntry: $('adminEntry'),
  // 离线提示条 + 首登同意弹层
  offlineBanner: $('offlineBanner'),
  consentModal: $('consentModal'),
  consentAgree: $('consentAgree'),
  consentDecline: $('consentDecline'),
  consentError: $('consentError'),
};

const state = {
  api: null,
  // 登录态 {mode:'on'|'off'|null, user:publicUser|null}；null=AUTH 未知/旧后端
  auth: null,
  v3: null, // null=探测中, true=v3 会话, false=降级 v1
  conversationId: null,
  sessionId: null,
  conversations: [],
  memories: [],
  library: null, // GET /api/library 的缓存（面板与抽屉共用）
  libraryDisciplineId: '', // 当前选中的学科方向（内存，不跨会话持久化）
  marks: null, // GET /api/marks 的缓存（读者工具栏与面板共用）
  marksSupported: null, // null=未知, true=可用, false=后端未启用
  scales: null, // GET /api/scales 的缓存（列表 + 免责声明）
  scalesSupported: null, // null=未知, true=可用, false=旧后端（隐藏入口）
  scalesCurrent: null, // 正在作答的问卷定义
  scalesAnswers: null, // 当前答案 { '1': 0, ... }，只存在内存
  scalesPage: 1, // 大题量问卷的分页页码（1 起）
  scalesSex: null, // v2 常模问卷的性别口径（'male'|'female'），只存在内存
  scalesBusy: false,
  scalesHistory: null, // GET /api/scales/history 的缓存
  scalesHistoryCurrent: null, // 当前选中的历史问卷 id（默认最近测过的那份）
  scalesHistoryBusy: false,
  imageViewerReturnFocus: null, // 打开大图前的焦点元素
  health: null, // GET /api/health 的记录缓存（面板用）
  readerDocId: null, // 当前阅读器文档（收藏/摘录目标）
  readerFavoriteId: null,
  effort: 'high',
  memory: 'on',
  webSearch: 'off', // 联网搜索开关（默认关，按设备持久化）
  webSearchSupported: null, // null=未知, true=后端启用, false=旧后端/不可用（chip 隐藏）
  webSearchUsed: 0, // 最近一轮 meta.webSearchUsed（0=未用/失败）
  streaming: false,
  abort: null,
  chatDrafts: [], // 聊天草稿区附件（图片 ≤3、文本 ≤1；）
  memoryDrafts: [], // 记忆草稿区附件（≤1）
  draftSeq: 0,
  lastFocus: null,
  readerSeq: 0,
  readerTimer: 0,
  toastTimer: 0,
  demo: false,
  booted: false,
  // 离页后台续跑（pageHidden=发生过 pagehide；pending={conversationId,at}）
  pageHidden: false,
  backgroundPending: null,
  backgroundTimer: 0,
  backgroundStartedAt: 0,
  backgroundPausedMs: 0,
  backgroundPausedAt: 0,
  backgroundBusy: false,
};

/* ==========================================================================
   小工具
   ========================================================================== */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readKey(key) {
  try {
    return getStorage()?.getItem(key) || null;
  } catch {
    return null;
  }
}

function writeKey(key, value) {
  try {
    if (value === null) getStorage()?.removeItem(key);
    else getStorage()?.setItem(key, value);
  } catch {
    /* 隐私模式：忽略 */
  }
}

function saveConversationId(id) {
  writeKey(STORAGE.conversationId, id || null);
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

function setRunState(name) {
  dom.stateChip.dataset.state = name;
  dom.stateChip.textContent =
    name === 'websearch'
      ? '联网中…'
      : name === 'streaming'
        ? '思考中'
        : name === 'error'
          ? '出错'
          : '就绪';
}

let toastTimer = 0;
function toast(message, ms = TOAST_MS) {
  if (!message) return;
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.hidden = true;
  }, ms);
}

function humanizeError(error) {
  const raw = typeof error?.message === 'string' ? error.message.trim() : '';
  if (!raw) return '';
  if (error?.apiCode || error?.code) return raw;
  if (error?.name === 'TypeError') return '网络中断或服务未启动';
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return '网络中断或服务未启动';
  return raw;
}

function isUnsupported(error) {
  return error instanceof ApiError && error.status === 404 && error.code === 'NOT_FOUND';
}

/* ==========================================================================
   推理等级 / 记忆开关
   ========================================================================== */

function setEffort(value, options = {}) {
  state.effort = normalizeEffort(value);
  dom.effortValue.textContent = effortLabel(state.effort);
  for (const button of dom.effortOptions) {
    button.setAttribute('aria-checked', String(button.dataset.effort === state.effort));
  }
  if (options.persist !== false) saveEffort(getStorage(), state.effort);
}

function openEffortSheet(open) {
  const shouldOpen = Boolean(open);
  dom.effortSheet.hidden = !shouldOpen;
  dom.effortChip.setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) {
    const current = dom.effortOptions.find((button) => button.dataset.effort === state.effort);
    current?.focus({ preventScroll: true });
  }
}

function toggleEffortSheet() {
  openEffortSheet(dom.effortSheet.hidden);
}

function setMemory(value, options = {}) {
  state.memory = value === 'off' ? 'off' : 'on';
  dom.memoryValue.textContent = state.memory === 'on' ? '开' : '关';
  dom.memoryChip.setAttribute('aria-pressed', String(state.memory === 'on'));
  updateWebSearchChip();
  dom.memoryToggle.checked = state.memory === 'on';
  if (options.persist !== false) writeKey(STORAGE.memory, state.memory);
}

/* ==========================================================================
   联网搜索开关：仿 DeepSeek App 输入框上方工具区
   - 默认关；开启后本轮请求带 webSearch:'on'
   - 仅 /api/health 的 webSearch.enabled===true 时可见（旧后端/缺失 → 隐藏）
   - 选择按设备 localStorage 持久化；首次开启弹一次隐私提示
   ========================================================================== */

function updateWebSearchChip() {
  const on = state.webSearch === 'on';
  dom.webSearchChip.hidden = state.webSearchSupported !== true;
  dom.webSearchChip.setAttribute('aria-pressed', String(on));
  dom.webSearchChip.classList.toggle('is-on', on);
  dom.webSearchValue.textContent = on ? '开' : '关';
}

function setWebSearch(value, options = {}) {
  state.webSearch = value === 'on' ? 'on' : 'off';
  updateWebSearchChip();
  if (options.persist !== false) writeKey(STORAGE.webSearch, state.webSearch);
}

/** 读 /api/health 决定 chip 显隐；失败/旧后端/字段缺失 → 隐藏并按关处理。 */
async function loadWebSearchCapability() {
  let view = { available: false, provider: '', maxCitations: 0 };
  try {
    view = webSearchViewFromHealth(await state.api.health());
  } catch {
    /* 健康检查失败按不可用处理：chip 隐藏，不阻塞对话 */
  }
  state.webSearchSupported = view.available;
  if (!view.available) setWebSearch('off', { persist: false });
  updateWebSearchChip();
}

function toggleWebSearch() {
  if (state.webSearchSupported !== true) return;
  const next = state.webSearch === 'on' ? 'off' : 'on';
  setWebSearch(next);
  if (next === 'on' && readKey(STORAGE.webSearchHintSeen) !== '1') {
    toast(WEBSEARCH_HINT, 5200);
    writeKey(STORAGE.webSearchHintSeen, '1');
  }
}

/* ==========================================================================
   滚动跟随
   ========================================================================== */

/**
 * 「跟随最新」意图：只有**用户主动滚动**才改写 pinnedToBottom；
 * 内容增长时若仍在跟随就贴底，否则 unreadCount + 1（悬浮按钮显示「新内容」）。
 * 键盘/视口 resize 引发的 scroll 事件不得改变该意图（见 setupViewport 的 wasPinned 保护）。
 */
let pinnedToBottom = true;
/** 未读新增计数：仅「不在底部 + 内容新增」时 +1；回到底部/点击跳转清零。 */
let unreadCount = 0;
/** 最近一次用户滚动手势之后的保护窗口：窗口内的 scroll 事件视为用户意图。 */
let userScrollUntil = 0;
/** 视口/键盘 resize 保护窗口：窗口内的 scroll 事件不改变 pin 意图。 */
let resizeGuardUntil = 0;
/** resize 开始前记录的 pin 意图，用于 resize 结束后恢复贴底。 */
let wasPinnedBeforeResize = true;
/** resize 保护窗口时长（键盘动画/布局重排都发生在这段时间内）。 */
const RESIZE_INTENT_GUARD_MS = 400;
/** 用户滚动意图窗口：触摸滚动尾流/滚轮连续事件都覆盖到。 */
const USER_SCROLL_INTENT_MS = 1200;

function distanceFromBottom() {
  return dom.screen.scrollHeight - dom.screen.scrollTop - dom.screen.clientHeight;
}

function scrollToBottom(behavior = 'auto') {
  dom.screen.scrollTo({ top: dom.screen.scrollHeight, behavior });
}

function jumpLabelText() {
  return unreadCount > 0 ? '新内容' : '回到最新';
}

function updateJumpButton() {
  if (dom.jumpLabel) dom.jumpLabel.textContent = jumpLabelText();
  dom.jump.hidden = pinnedToBottom || distanceFromBottom() <= NEAR_BOTTOM_PX;
}

/** 回到「跟随最新」并清零未读（新会话、加载历史、发送消息时用）。 */
function resetFollow() {
  pinnedToBottom = true;
  unreadCount = 0;
  scrollToBottom();
  updateJumpButton();
}

/** 内容增长后调用：跟随态贴底，否则记一条未读（用户主动触发的高度变化传 { unread: false }）。 */
function maybeFollow(options = {}) {
  const allowUnread = options.unread !== false;
  if (pinnedToBottom) {
    scrollToBottom();
    if (unreadCount > 0) unreadCount = 0;
  } else if (allowUnread) {
    unreadCount += 1;
  }
  updateJumpButton();
}

function markUserScrollIntent() {
  userScrollUntil = performance.now() + USER_SCROLL_INTENT_MS;
}

const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', ' ']);

function markScrollKeyIntent(event) {
  if (dom.jump.hidden && !dom.screen.contains(document.activeElement)) return;
  if (!SCROLL_KEYS.has(event.key)) return;
  markUserScrollIntent();
}

function handleScreenScroll() {
  const now = performance.now();
  if (now >= userScrollUntil) {
    // 程序化贴底、流式跟随、布局重排引发的滚动：不改变用户意图
    return;
  }
  if (now < resizeGuardUntil) {
    // 键盘/视口 resize 期间的滚动不算用户主动滚动，resize 结束后由 onResize 重贴底
    return;
  }
  const atBottom = distanceFromBottom() < NEAR_BOTTOM_PX;
  pinnedToBottom = atBottom;
  if (atBottom) unreadCount = 0;
  updateJumpButton();
}

function jumpToLatest() {
  pinnedToBottom = true;
  unreadCount = 0;
  // 点击跳转是明确的「回到底部」意图：清掉用户滚动保护窗口，
  // 避免平滑滚动途中经过的位置被当成新的用户滚动而再次弹出按钮。
  userScrollUntil = 0;
  scrollToBottom('smooth');
  updateJumpButton();
  dom.jump.blur();
}

/* ==========================================================================
   空状态
   ========================================================================== */

function playHello() {
  if (!dom.hello) return;
  dom.hello.classList.remove('is-playing');
  // 强制回流，让动画可以从头重播（进入页面 / 新对话 / 回到空状态时各写一次）
  void dom.hello.offsetWidth;
  dom.hello.classList.add('is-playing');
}

function showEmpty() {
  dom.empty.hidden = false;
  pinnedToBottom = true;
  unreadCount = 0;
  updateJumpButton();
  playHello();
}

function hideEmpty() {
  dom.empty.hidden = true;
}

function clearScreen() {
  dom.screen.replaceChildren(dom.empty);
  dom.empty.hidden = false;
}

/* ==========================================================================
   思考过程块（固定高度内部滚动区，仅贴底自动跟随）
   ========================================================================== */

/** 流式思考区距离底部多少像素内算「贴底」（用户上滑后不再自动跳回）。 */
const THINKING_FOLLOW_PX = 24;

/**
 * 思考用时：<60s 用「x.xs」，≥60s 用「m分s秒」（标题「已深度思考（用时 x.xs）」）。
 * 保留 formatDuration 的毫秒分支给流式计时（<1s 时「820ms」）。
 */
function formatThinkingDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '0.0s';
  if (value < 1000) return formatDuration(value);
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}分${total % 60}秒`;
}

function isThinkingNearBottom(body) {
  return body.scrollHeight - body.scrollTop - body.clientHeight <= THINKING_FOLLOW_PX;
}

function createThinkingBlock(turn) {
  const root = el('div', 'thinking');
  root.hidden = true;
  root.dataset.streaming = 'false';
  root.dataset.open = 'false';

  const head = el('button', 'thinking-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');

  const caret = el('span', 'thinking-caret', '▸');
  const label = el('span', 'thinking-label', '思考过程');
  const time = el('span', 'thinking-time', '');
  head.append(caret, label, time);

  const body = el('div', 'thinking-body');
  body.hidden = true;
  body.tabIndex = 0;
  body.setAttribute('aria-label', '思考内容，可滚动');
  root.append(head, body);
  turn.section.append(root);

  let memoryBadge = null;
  /** 流式追加时是否继续贴底；用户上滑后置 false，回到接近底部再置 true。 */
  let stickToBottom = true;
  /** 程序化滚动不改变用户意图；只有用户手动滚动才更新 stickToBottom。 */
  let programmaticScroll = false;

  const block = {
    root,
    head,
    body,
    caret,
    label,
    time,
    raw: '',
    expanded: false,
    streaming: false,
    userToggled: false,
    restored: false,
    startedAt: 0,
    elapsedMs: 0,
    timer: 0,

    begin() {
      if (block.streaming) return;
      block.streaming = true;
      block.startedAt = performance.now();
      root.hidden = false;
      root.dataset.streaming = 'true';
      label.textContent = '思考中…';
      time.textContent = '0.0s';
      stickToBottom = true;
      block.setExpanded(true);
      body.scrollTop = body.scrollHeight;
      clearInterval(block.timer);
      block.timer = window.setInterval(() => {
        time.textContent = formatDuration(performance.now() - block.startedAt);
      }, 200);
    },

    append(text) {
      if (!text) return;
      if (!block.streaming) block.begin();
      // 只有追加前就已经在贴底附近才继续跟随；用户上滑后不强制跳回。
      if (!body.hidden && isThinkingNearBottom(body)) stickToBottom = true;
      block.raw += text;
      body.textContent = block.raw;
      if (stickToBottom) {
        programmaticScroll = true;
        body.scrollTop = body.scrollHeight;
        programmaticScroll = false;
      }
      maybeFollow();
    },

    finish() {
      if (!block.streaming) {
        block.applyCollapsedVisual();
        return;
      }
      block.streaming = false;
      block.elapsedMs = performance.now() - block.startedAt;
      clearInterval(block.timer);
      root.dataset.streaming = 'false';
      label.textContent = '已深度思考';
      time.textContent = `（用时 ${formatThinkingDuration(block.elapsedMs)}）`;
      if (!block.userToggled) block.setExpanded(false);
      block.applyCollapsedVisual();
    },

    /** 历史回放：直接填入已保存的思考文本（默认折叠；展开后同样是固定高度滚动区）。 */
    restore(text, options = {}) {
      block.restored = true;
      block.streaming = false;
      block.raw = String(text || '');
      root.hidden = false;
      root.dataset.streaming = 'false';
      label.textContent = '已深度思考';
      const duration = Number(options.durationMs);
      time.textContent =
        Number.isFinite(duration) && duration > 0 ? `（用时 ${formatThinkingDuration(duration)}）` : '';
      body.textContent = block.raw;
      stickToBottom = false;
      block.setExpanded(false);
    },

    setExpanded(expanded) {
      block.expanded = Boolean(expanded);
      root.dataset.open = String(block.expanded);
      caret.textContent = block.expanded ? '▾' : '▸';
      head.setAttribute('aria-expanded', String(block.expanded));
      body.hidden = !block.expanded;
    },

    applyCollapsedVisual() {
      root.dataset.open = String(block.expanded);
      caret.textContent = block.expanded ? '▾' : '▸';
      head.setAttribute('aria-expanded', String(block.expanded));
      body.hidden = !block.expanded;
    },

    toggle() {
      block.userToggled = true;
      block.setExpanded(!block.expanded);
      if (block.expanded) {
        // 展开时若仍在流式，跟随到底；历史回放则从顶部开始读。
        if (block.streaming) {
          programmaticScroll = true;
          body.scrollTop = body.scrollHeight;
          programmaticScroll = false;
        }
        body.focus({ preventScroll: true });
      }
    },

    /** meta.memoryUsed > 0 时在折叠块标题上挂「想起 N 条」。 */
    setMemoryUsed(count) {
      const text = memoryUsedLabel(count);
      if (!text) return;
      if (!memoryBadge) {
        memoryBadge = el('span', 'thinking-memory', text);
        head.append(memoryBadge);
      } else {
        memoryBadge.textContent = text;
      }
    },

    destroy() {
      clearInterval(block.timer);
    },
  };

  head.addEventListener('click', () => block.toggle());
  body.addEventListener(
    'scroll',
    () => {
      if (programmaticScroll) return;
      stickToBottom = isThinkingNearBottom(body);
    },
    { passive: true },
  );
  return block;
}

/* ==========================================================================
   流式正文：`[[cN]]` 角标 + 分片安全
   ========================================================================== */

function createAnswerView(turn, onCitation) {
  const wrapper = el('div', 'answer');
  wrapper.dataset.streaming = 'true';
  const container = el('span', 'answer-text');
  const cursor = el('span', 'cursor');
  cursor.setAttribute('aria-hidden', 'true');
  wrapper.append(container, cursor);
  turn.line.append(el('span', 'ps1', '$'), wrapper);
  // 正文开始前先不显示空白的 $ 行：思考阶段只留思考块。
  turn.line.hidden = true;

  let revealed = false;
  let lastTextNode = null;
  let rendered = 0;
  let raw = '';

  const view = {
    wrapper,
    append(delta) {
      if (!delta) return;
      if (!revealed) {
        revealed = true;
        turn.line.hidden = false;
      }
      raw += delta;
      const cut = Math.max(rendered, safeCutoff(raw));
      if (cut <= rendered) {
        maybeFollow();
        return;
      }
      renderSegment(raw.slice(rendered, cut));
      rendered = cut;
      maybeFollow();
    },
    finish() {
      if (rendered < raw.length) {
        renderSegment(raw.slice(rendered));
        rendered = raw.length;
      }
      wrapper.dataset.streaming = 'false';
      cursor.remove();
      if (!revealed) turn.line.hidden = true;
    },
    get length() {
      return raw.length;
    },
    get rawText() {
      return raw;
    },
    destroy() {
      cursor.remove();
    },
  };

  function renderSegment(segment) {
    for (const token of parseCitations(segment)) {
      if (token.type === 'text') {
        if (lastTextNode) {
          lastTextNode.appendData(token.value);
        } else {
          lastTextNode = document.createTextNode(token.value);
          container.append(lastTextNode);
        }
      } else {
        lastTextNode = null;
        const cite = el('button', 'cite', `[${token.c}]`);
        cite.type = 'button';
        cite.dataset.c = String(token.c);
        cite.setAttribute('aria-label', `查看引用 ${token.c}`);
        cite.addEventListener('click', (event) => {
          event.stopPropagation();
          onCitation(token.c);
        });
        container.append(cite);
      }
    }
  }

  return view;
}

/* ==========================================================================
   附件草稿区：图片/文本先停在草稿区，补文字后一起发送
   ========================================================================== */

function draftContext(target) {
  if (target === 'memory') return { drafts: state.memoryDrafts, tray: dom.memoryDraftTray };
  return { drafts: state.chatDrafts, tray: dom.draftTray };
}

function nextDraftId() {
  state.draftSeq += 1;
  return `draft-${state.draftSeq}`;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片无法读取'));
    };
    image.src = url;
  });
}

/** canvas 压缩：最长边 ≤1568px、JPEG q0.85；失败返回 null（调用方 toast）。 */
async function compressImageFile(file) {
  try {
    let source = null;
    if (typeof createImageBitmap === 'function') {
      try {
        source = await createImageBitmap(file);
      } catch {
        source = null;
      }
    }
    if (!source) source = await loadImageElement(file);
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    if (!width || !height) throw new Error('图片尺寸未知');
    const size = scaledSize(width, height, ATTACHMENT_LIMITS.maxImageEdge);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas 不可用');
    // JPEG 没有透明通道：透明 PNG 先垫白底，避免变成黑块。
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(source, 0, 0, size.width, size.height);
    const dataUrl = canvas.toDataURL('image/jpeg', ATTACHMENT_LIMITS.jpegQuality);
    if (typeof source.close === 'function') source.close();
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (!base64) throw new Error('压缩结果为空');
    return {
      dataBase64: base64,
      mime: 'image/jpeg',
      width: size.width,
      height: size.height,
      previewUrl: dataUrl,
    };
  } catch {
    return null;
  }
}

/** 读取文本文件（UTF-8）；失败返回 null。 */
async function readTextFile(file) {
  try {
    if (typeof file.text === 'function') return await file.text();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('读取失败'));
      reader.readAsText(file, 'utf-8');
    });
  } catch {
    return null;
  }
}

/** 图片草稿的展示名：统一改成 .jpg（内容已由 canvas 转成 JPEG）。 */
function jpegName(name) {
  const base = String(name || '图片')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .trim();
  return `${base || '图片'}.jpg`;
}

/** 解析中占位：meta 到达前先显示「正在理解附件…」，之后被解析结果替换。 */
function renderParsingAttachments(ctx, drafts) {
  const list = drafts.filter((draft) => draft.kind === 'image' || draft.kind === 'text');
  if (list.length === 0) return;
  const wrap = el('div', 'answer-attachments');
  for (const draft of list) {
    const chip = el('span', 'att-chip att-chip-parsing');
    chip.append(
      el('span', 'att-chip-name', `附件：${draft.name || '附件'}`),
      el('span', 'att-chip-state', '正在理解…'),
    );
    wrap.append(chip);
  }
  ctx.attachmentView = wrap;
  ctx.line.after(wrap);
  maybeFollow();
}

/** 把一个 File 变成草稿对象；失败返回 {error}。 */
async function createDraftFromFile(file) {
  const classified = classifyAttachmentFile({ name: file.name, mime: file.type, size: file.size });
  if (!classified.kind) return { error: classified.reason };
  if (classified.kind === 'image') {
    const compressed = await compressImageFile(file);
    if (!compressed) {
      // iPhone 相册 HEIC/HEIF 等格式必须转 JPEG；解码失败就提示换图/截图。
      return { error: '这张图片格式暂不支持，请换一张或截图后再试。' };
    }
    return {
      draft: {
        id: nextDraftId(),
        kind: 'image',
        name: jpegName(file.name),
        mime: compressed.mime,
        size: file.size,
        dataBase64: compressed.dataBase64,
        previewUrl: compressed.previewUrl,
        width: compressed.width,
        height: compressed.height,
      },
    };
  }
  const text = await readTextFile(file);
  if (text === null) return { error: `${file.name || '文本文件'}读取失败。` };
  if (!text.trim()) return { error: `${file.name || '文本文件'}是空的。` };
  return {
    draft: {
      id: nextDraftId(),
      kind: 'text',
      name: file.name || '文本',
      mime: file.type || 'text/plain',
      size: file.size,
      text,
    },
  };
}

/** 批量把文件加入草稿区：先校验类型/上限，超限 toast 且不入草稿。 */
async function addDraftFiles(target, fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  if (target === 'chat' && state.streaming) {
    toast('等这轮回答结束再添加附件。');
    return;
  }
  for (const file of files) {
    const { drafts } = draftContext(target);
    if (target === 'memory' && drafts.length >= 1) {
      toast('一条记忆最多带 1 个附件。');
      break;
    }
    if (file.size > ATTACHMENT_LIMITS.maxTotalBytes) {
      toast('附件超过 12MB 上限。');
      continue;
    }
    const classified = classifyAttachmentFile({ name: file.name, mime: file.type, size: file.size });
    if (!classified.kind) {
      toast(classified.reason);
      continue;
    }
    const gate = canAddDraft(drafts, { kind: classified.kind, size: file.size });
    if (!gate.ok) {
      toast(gate.message);
      continue;
    }
    const created = await createDraftFromFile(file);
    if (created.error) {
      toast(created.error);
      continue;
    }
    drafts.push(created.draft);
    renderDraftTray(target);
    maybeFollow();
  }
}

function renderDraftTray(target) {
  const { drafts, tray } = draftContext(target);
  tray.replaceChildren();
  tray.hidden = drafts.length === 0;
  if (target === 'memory') {
    // 默认上限 200；带 1 个附件时后端放宽到 800（与 POST /api/memories 一致）。
    dom.memoryInput.maxLength = drafts.length > 0 ? 800 : 200;
  }
  for (const draft of drafts) {
    const item = el('div', 'draft-item');
    item.dataset.kind = draft.kind;
    item.dataset.draftId = draft.id;
    if (draft.kind === 'image') {
      const thumb = el('img', 'draft-thumb');
      thumb.src = draft.previewUrl || '';
      thumb.alt = draft.name || '图片';
      item.append(thumb);
    } else {
      item.append(el('span', 'draft-kind', '文'));
    }
    const info = el('div', 'draft-info');
    info.append(el('span', 'draft-name', draft.name || '附件'));
    const kindLabel = draft.kind === 'image' ? '图片' : '文本';
    info.append(el('span', 'draft-size', `${kindLabel} · ${formatBytes(draft.size)}`));
    item.append(info);
    const remove = el('button', 'draft-remove', '✕');
    remove.type = 'button';
    remove.setAttribute('aria-label', `移除附件 ${draft.name || ''}`.trim());
    remove.addEventListener('click', () => removeDraft(target, draft.id));
    item.append(remove);
    tray.append(item);
  }
}

function removeDraft(target, id) {
  const { drafts } = draftContext(target);
  const index = drafts.findIndex((draft) => draft.id === id);
  if (index >= 0) drafts.splice(index, 1);
  renderDraftTray(target);
}

function clearDrafts(target) {
  const { drafts } = draftContext(target);
  drafts.length = 0;
  renderDraftTray(target);
}

/** 附件降级 chip（无同源预览 / 图片加载失败时沿用 视觉）。 */
function attachmentFallbackChip(attachment) {
  const chip = el('span', 'att-chip');
  chip.append(el('span', 'att-chip-kind', attachment.kind === 'image' ? '图' : '文'));
  chip.append(el('span', 'att-chip-name', attachment.name || '附件'));
  if (attachment.size) chip.append(el('span', 'att-chip-size', formatBytes(attachment.size)));
  return chip;
}

/**
 * 图片附件缩略图按钮（同源 previewUrl；点击看大图）。
 * 加载失败时把按钮替换成原文字 chip（不出现破图，也不改变布局高度）。
 */
function createAttachmentThumb(attachment, className = 'att-thumb') {
  const previewUrl = safeAttachmentPreviewUrl(attachment.previewUrl);
  if (attachment.kind !== 'image' || !previewUrl) return null;
  const button = el('button', className);
  button.type = 'button';
  button.setAttribute('aria-label', `查看图片：${attachment.name || '附件'}`);
  const img = el('img', 'att-thumb-img');
  img.src = previewUrl;
  img.alt = attachment.name || '图片';
  img.loading = 'lazy';
  img.decoding = 'async';
  button.append(img);
  button.addEventListener('click', () => openImageViewer(previewUrl, attachment.name || '图片', button));
  img.addEventListener(
    'error',
    () => {
      button.replaceWith(attachmentFallbackChip(attachment));
    },
    { once: true },
  );
  return button;
}

/** 用户消息气泡下的附件：有同源预览的图片显示缩略图，其余是文字 chip。 */
function renderUserAttachments(section, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return;
  const wrap = el('div', 'msg-attachments');
  for (const attachment of list) {
    const thumb = createAttachmentThumb(attachment);
    wrap.append(thumb || attachmentFallbackChip(attachment));
  }
  if (wrap.querySelector('.att-thumb')) wrap.classList.add('msg-attachments-images');
  const bubble = section.querySelector('.bubble');
  if (bubble) bubble.after(wrap);
  else section.append(wrap);
}

/* ---------------- 大图查看（同源图片，键盘可关） ---------------- */

function openImageViewer(url, name, returnFocus) {
  const src = safeAttachmentPreviewUrl(url);
  if (!src) return;
  state.imageViewerReturnFocus = returnFocus || document.activeElement;
  const label = name || '图片';
  dom.imageViewerImg.src = src;
  dom.imageViewerImg.alt = label;
  dom.imageViewerCaption.textContent = label;
  dom.imageViewer.hidden = false;
  dom.imageViewerClose.focus({ preventScroll: true });
}

function closeImageViewer() {
  if (dom.imageViewer.hidden) return;
  dom.imageViewer.hidden = true;
  dom.imageViewerImg.removeAttribute('src');
  dom.imageViewerCaption.textContent = '';
  const target = state.imageViewerReturnFocus;
  state.imageViewerReturnFocus = null;
  if (target && document.contains(target)) target.focus({ preventScroll: true });
}

/** 回答 meta 里的解析结果：`附件：name（已解析）` chip，可展开摘要；失败显示解析失败。 */
function renderAnswerAttachments(ctx) {
  const list = Array.isArray(ctx.attachments) ? ctx.attachments : [];
  if (list.length === 0) return;
  if (ctx.attachmentView) {
    ctx.attachmentView.remove();
    ctx.attachmentView = null;
  }
  const wrap = el('div', 'answer-attachments');
  for (const attachment of list) {
    if (attachment.error) {
      wrap.append(
        el('span', 'att-chip att-chip-error', attachmentChipLabel(attachment, { state: 'error' })),
      );
      continue;
    }
    const details = el('details', 'att-details');
    const summary = el('summary', 'att-chip att-chip-ok');
    summary.append(
      el('span', 'att-chip-name', attachmentChipLabel(attachment, { state: 'parsed' })),
      el('span', 'att-chip-caret', '▾'),
    );
    details.append(summary);
    details.append(el('p', 'att-summary', attachment.summary || '（没有解析摘要）'));
    wrap.append(details);
  }
  ctx.attachmentView = wrap;
  ctx.line.after(wrap);
  maybeFollow();
}

/* ==========================================================================
   一轮 bot 回答
   ========================================================================== */

function createAssistantTurn() {
  const section = el('section', 'turn turn-bot');
  section.dataset.role = 'bot';
  dom.screen.append(section);

  const thinking = createThinkingBlock({ section });
  const line = el('div', 'line');
  section.append(line);

  const answered = createAnswerView({ section, line }, (c) => openCitationFromTurn(ctx, c));

  const ctx = {
    section,
    line,
    thinking,
    answer: answered,
    citations: [],
    meta: null,
    attachments: [],
    attachmentView: null,
    memoryUsed: 0,
    webSearchUsed: 0, // meta.webSearchUsed（0=未用/失败）
    webSearchOn: false, // 本轮用户是否开启联网（用于失败降级文案）
    done: false,
    errored: false,
    finished: false,
    startedAt: performance.now(),
    doneMs: 0,

    finish() {
      if (ctx.finished) return;
      ctx.finished = true;
      answered.finish();
      thinking.finish();
      if (ctx.citations.length > 0 && (ctx.done || answered.rawText.length > 0)) {
        renderCitationList(ctx);
      }
      if (ctx.done && !ctx.errored) {
        ctx.doneMs = performance.now() - ctx.startedAt;
        renderRunMeta(ctx);
      }
      section.dataset.done = String(ctx.done);
      maybeFollow();
    },

    fail(error) {
      if (ctx.errored) return;
      ctx.errored = true;
      if (ctx.attachmentView && ctx.attachments.length === 0) {
        ctx.attachmentView.remove();
        ctx.attachmentView = null;
      }
      ctx.finish();
      const lineNode = el('p', 'error-line');
      lineNode.textContent = formatTerminalError({
        code: error.apiCode || error.code || 'NETWORK',
        message: humanizeError(error),
        status: Number.isInteger(error.status) ? error.status : undefined,
      });
      section.append(lineNode);
      section.dataset.error = 'true';
      setRunState('error');
      maybeFollow();
    },

    /** 页面不可见导致流中断——不渲染红色错误，改中性状态，交给回页轮询恢复。 */
    backgroundInterrupted() {
      if (ctx.errored) return;
      ctx.finish();
      const note = el('p', 'turn-meta');
      note.dataset.background = 'true';
      note.textContent = BG_NEUTRAL_TEXT;
      section.append(note);
      maybeFollow();
    },

    setMemoryUsed(count) {
      ctx.memoryUsed = Number(count) || 0;
      thinking.setMemoryUsed(ctx.memoryUsed);
    },
  };

  return ctx;
}

/** 每轮结束的元信息：`完 · 2.4s · 推理 高 · 想起 2 条`（对齐画册页脚的小字注）。 */
function renderRunMeta(ctx) {
  const meta = el('p', 'run-meta');
  const parts = ['完', formatDuration(ctx.doneMs), `推理 ${effortLabel(state.effort)}`];
  const memory = memoryUsedLabel(ctx.memoryUsed);
  if (memory) parts.push(memory);
  // 联网来源条数 / 本轮未获取到联网资料（弱化、不报错）。
  const webLabel = webSearchRunLabel(ctx.webSearchUsed, ctx.webSearchOn);
  if (webLabel) parts.push(webLabel);
  meta.textContent = parts.join(' · ');
  meta.dataset.websearch = ctx.webSearchUsed > 0 ? 'used' : ctx.webSearchOn ? 'fallback' : 'off';
  ctx.section.append(meta);
}

/* ==========================================================================
   参考资料
   ========================================================================== */

function renderCitationList(ctx) {
  const wrap = el('div', 'refs');
  wrap.dataset.open = 'false';
  const webCount = webCitationCount(ctx.citations);

  const head = el('button', 'refs-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');
  const label = webCount > 0 ? `参考资料 (${ctx.citations.length}) · 联网 ${webCount}` : `参考资料 (${ctx.citations.length})`;
  head.append(el('span', 'refs-caret', '▸'), el('span', 'refs-label', label));

  const list = el('ol', 'refs-list');
  list.hidden = true;
  for (const citation of ctx.citations) {
    const isWeb = citation.source === 'web';
    const item = el('li', isWeb ? 'ref-item-wrap ref-item-wrap-web' : 'ref-item-wrap');
    const safeUrl = isWeb ? safeExternalUrl(citation.sourceUrl) : '';
    // 外链仅允许 http(s)；非法/缺失 → 纯文本渲染，绝不进 href。
    const tag = isWeb ? (safeUrl ? 'a' : 'div') : 'button';
    const row = el(tag, isWeb ? 'ref-item ref-item-web' : 'ref-item');
    if (tag === 'a') {
      row.href = safeUrl;
      row.target = '_blank';
      row.rel = 'noopener noreferrer';
      row.setAttribute('aria-label', `打开网页 ${citation.title || citation.heading || ''}（新窗口）`);
    } else if (tag === 'button') {
      row.type = 'button';
      row.addEventListener('click', () => openCitationFromTurn(ctx, citation.c));
    } else {
      row.setAttribute('aria-disabled', 'true');
    }
    row.append(el('span', 'ref-num', `[${citation.c}]`));
    if (isWeb) row.append(el('span', 'ref-badge', '网页'));
    row.append(el('span', 'ref-title', citation.title || citation.heading || citation.docId || '网页'));
    const domain = domainOf(citation.sourceUrl);
    if (domain) row.append(el('span', 'ref-domain', domain));
    item.append(row);
    if (isWeb) {
      const meta = [citation.heading, citation.anchor].filter(Boolean).join(' · ');
      if (meta) item.append(el('p', 'ref-web-meta', meta));
      if (typeof citation.text === 'string' && citation.text.trim()) {
        item.append(el('p', 'ref-web-summary', citation.text.trim().slice(0, 120)));
      }
    }
    // 每条引用可复制纯文本（标题 / 摘录 / 来源）。
    const copy = el('button', 'ref-copy', '复制引用');
    copy.type = 'button';
    copy.setAttribute('aria-label', `复制引用 [${citation.c}]`);
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      copyCitationText(citation);
    });
    item.append(copy);
    list.append(item);
  }

  head.addEventListener('click', () => {
    const open = wrap.dataset.open !== 'true';
    wrap.dataset.open = String(open);
    list.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
    if (open) maybeFollow({ unread: false });
  });

  wrap.append(head, list);
  ctx.section.append(wrap);
}

function openCitationFromTurn(ctx, c) {
  const citation = (ctx?.citations || []).find((item) => item.c === c);
  if (!citation) {
    openReaderFallback(c);
    return;
  }
  if (citation.source === 'web') {
    openWebCitation(citation);
    return;
  }
  openReader(citation);
}

/** 联网引用的浮层：摘要 + 「网页」标记 + 安全外链；复用阅读器的版式与关闭逻辑。 */
function openWebCitation(citation) {
  state.readerSeq += 1;
  state.lastFocus = document.activeElement;
  clearTimeout(state.readerTimer);
  dom.app.dataset.reader = 'open';
  dom.reader.hidden = false;
  dom.readerCmd.textContent = '联网资料 · 外部';
  dom.readerTitle.textContent = citation.title || citation.heading || '联网资料';
  dom.readerMeta.textContent = [citation.heading, citation.anchor].filter(Boolean).join(' · ');
  dom.readerNotice.textContent = '以下摘要来自外部网页，仅供参考；打开原文前请自行判断内容可信度。';
  dom.readerNotice.hidden = false;
  dom.readerTools.hidden = true;
  dom.readerBody.replaceChildren();
  state.readerDocId = null;
  state.readerFavoriteId = null;
  dom.readerScroll.scrollTop = 0;

  const frag = document.createDocumentFragment();
  if (typeof citation.text === 'string' && citation.text.trim()) {
    frag.append(el('p', 'reader-paragraph', citation.text.trim()));
  }
  const safeUrl = safeExternalUrl(citation.sourceUrl);
  const link = el('a', 'ref-item ref-item-web reader-web-link');
  if (safeUrl) {
    link.href = safeUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `打开原文 · ${domainOf(safeUrl) || safeUrl}`;
  } else {
    link.textContent = '这条联网资料没有可打开的外链。';
    link.setAttribute('aria-disabled', 'true');
  }
  frag.append(link);
  dom.readerBody.append(frag);

  requestAnimationFrame(() => {
    dom.reader.classList.add('is-open');
    refreshViewport();
  });
  dom.readerClose.focus({ preventScroll: true });
}

/* ==========================================================================
   阅读器/* ==========================================================================
   阅读器
   ========================================================================== */

function openReader(citation, options = {}) {
  // 文档库直接按 docId 打开：openReader('book-xxx-01', { title })。
  if (typeof citation === 'string') {
    citation = { docId: citation, ...options };
  }
  if (!citation || !citation.docId) return;
  state.readerSeq += 1;
  const seq = state.readerSeq;
  state.lastFocus = document.activeElement;
  clearTimeout(state.readerTimer);

  dom.app.dataset.reader = 'open';
  dom.reader.hidden = false;
  dom.readerCmd.textContent = `原文 · ${citation.docId}`;
  dom.readerTitle.textContent = citation.title || citation.docId;
  dom.readerMeta.textContent = '';
  setReaderNotice('');
  dom.readerBody.replaceChildren(el('p', 'reader-loading', `正在打开原文 · ${citation.title || citation.docId}`));
  dom.readerScroll.scrollTop = 0;
  dom.readerTools.hidden = false;
  state.readerDocId = citation.docId;
  state.readerFavoriteId = null;
  setReaderFavoriteState(false);
  requestAnimationFrame(() => {
    dom.reader.classList.add('is-open');
    refreshViewport();
  });
  dom.readerClose.focus({ preventScroll: true });

  loadReaderDoc(citation, seq);
  refreshReaderFavorite();
}

function openReaderFallback(c) {
  state.readerSeq += 1;
  state.lastFocus = document.activeElement;
  clearTimeout(state.readerTimer);
  dom.app.dataset.reader = 'open';
  dom.reader.hidden = false;
  dom.readerCmd.textContent = '原文 · —';
  dom.readerTitle.textContent = `引用 [${c}]`;
  dom.readerMeta.textContent = '这条历史消息没有保留引用来源。';
  setReaderNotice('');
  dom.readerBody.replaceChildren();
  dom.readerTools.hidden = true;
  state.readerDocId = null;
  state.readerFavoriteId = null;
  dom.readerScroll.scrollTop = 0;
  requestAnimationFrame(() => {
    dom.reader.classList.add('is-open');
    refreshViewport();
  });
  dom.readerClose.focus({ preventScroll: true });
}

async function loadReaderDoc(citation, seq) {
  try {
    const doc = await state.api.getDoc(citation.docId);
    if (seq !== state.readerSeq) return;
    renderReaderDoc(doc, citation);
  } catch (error) {
    if (seq !== state.readerSeq) return;
    const line = el(
      'p',
      'reader-loading reader-error',
      formatTerminalError({
        code: error.code || 'NETWORK',
        message: humanizeError(error),
        status: error.status,
      }),
    );
    dom.readerBody.replaceChildren(line);
  }
}

function safeSelectorValue(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
}

/** 阅读器免责横幅：文案固定，按语料许可切换；空串表示不渲染。 */
function setReaderNotice(license) {
  const notice = readerNoticeFor(license);
  dom.readerNotice.textContent = notice;
  dom.readerNotice.hidden = !notice;
}

function renderReaderDoc(doc, citation) {
  dom.readerTitle.textContent = doc.title || citation.title || doc.id;
  dom.readerCmd.textContent = `原文 · ${doc.id}`;

  const meta = document.createDocumentFragment();
  const authorLine = [doc.author, doc.year].filter(Boolean).join(' · ');
  if (authorLine) meta.append(document.createTextNode(authorLine));
  if (doc.license) meta.append(el('span', 'reader-license', ` · ${doc.license}`));
  const sourceHref = safeExternalUrl(doc.sourceUrl);
  if (sourceHref) {
    const link = el('a', 'reader-source', '原文 ↗');
    link.href = sourceHref;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    meta.append(link);
  }
  dom.readerMeta.replaceChildren(meta);
  setReaderNotice(doc.license || citation.license);

  const fragment = document.createDocumentFragment();
  // 长文档同一章的多个 section 共享章节标题，连续重复的标题只渲染一次。
  let lastHeading = null;
  for (const section of doc.sections || []) {
    const node = el('section', 'doc-section');
    node.dataset.anchor = String(section.anchor);
    const heading = String(section.heading || '');
    if (heading && heading !== lastHeading) node.append(el('h2', 'doc-heading', heading));
    lastHeading = heading;
    for (const paragraph of section.paragraphs || []) {
      const p = el('p', 'doc-para', paragraph.text || '');
      p.dataset.para = String(paragraph.para);
      node.append(p);
    }
    fragment.append(node);
  }
  dom.readerBody.replaceChildren(fragment);

  const anchor = safeSelectorValue(citation.anchor);
  const para = safeSelectorValue(citation.para);
  const targetSection = anchor
    ? dom.readerBody.querySelector(`.doc-section[data-anchor="${anchor}"]`)
    : null;
  let target =
    (targetSection && para ? targetSection.querySelector(`.doc-para[data-para="${para}"]`) : null) ||
    targetSection;

  // 从文档库章节目录进来时没有 anchor：定位并高亮第一节的首段。
  if (!target && citation.openAtStart) {
    const firstSection = dom.readerBody.querySelector('.doc-section');
    target = (firstSection && firstSection.querySelector('.doc-para')) || firstSection;
  }

  if (target) {
    window.requestAnimationFrame(() => {
      if (citation.openAtStart) {
        // 从文档库章节目录进入：首屏必须停在文档顶部（高亮首段但不滚动居中）。
        // 真机上曾出现「scrollTop 残留 + fixed shell 偏移」导致首段被滚到屏外，这里显式归零。
        dom.readerScroll.scrollTop = 0;
        target.classList.add('is-target');
      } else {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('is-target');
      }
      refreshViewport();
    });
  } else if (dom.readerBody.childElementCount > 0) {
    dom.readerBody.append(el('p', 'reader-loading', '# 正文里没有找到对应段落，已显示全文。'));
  }
}

function closeReader() {
  if (dom.reader.hidden) return;
  state.readerDocId = null;
  state.readerFavoriteId = null;
  state.readerSeq += 1;
  dom.app.dataset.reader = 'closed';
  dom.reader.classList.remove('is-open');
  clearTimeout(state.readerTimer);
  const hide = () => {
    dom.reader.hidden = true;
  };
  if (prefersReducedMotion()) hide();
  else state.readerTimer = window.setTimeout(hide, OVERLAY_TRANSITION_MS);
  const restoreFocus = state.lastFocus;
  state.lastFocus = null;
  if (restoreFocus && document.contains(restoreFocus)) {
    requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
  }
}

/* ==========================================================================
   标题 / 状态栏
   ========================================================================== */

function updateConversationTitle(title) {
  const text = title && String(title).trim() ? String(title).trim() : '新对话';
  dom.convTitle.textContent = text;
  dom.convTitle.title = text;
}

function updateStatusChips() {
  dom.effortValue.textContent = effortLabel(state.effort);
  dom.memoryValue.textContent = state.memory === 'on' ? '开' : '关';
  dom.memoryChip.setAttribute('aria-pressed', String(state.memory === 'on'));
  if (state.v3 === false) {
    dom.sessionChip.textContent = '本地会话';
    dom.sessionChip.title = '后端未启用会话持久化，消息只保留在内存里';
    dom.convSubtitle.textContent = '本地会话';
  } else if (state.conversationId) {
    dom.sessionChip.textContent = shortSessionId(state.conversationId);
    dom.sessionChip.title = `会话 ${state.conversationId}`;
    dom.convSubtitle.textContent = 'You’re Not Alone—And You Never Have to Be.';
  } else {
    dom.sessionChip.textContent = '新会话';
    dom.sessionChip.title = '这条消息发出时会自动保存为新会话';
    dom.convSubtitle.textContent = 'You’re Not Alone—And You Never Have to Be.';
  }
}

function updateMemoryCount() {
  dom.memoryCount.textContent = `${state.memories.length} 条`;
}

/* ==========================================================================
   v3 会话：创建 / 恢复 / 列表 / 删除
   ========================================================================== */

async function detectV3() {
  // /api/health 的 storage 字段是 v2 后端标志；旧后端也能跑 chat，只是没有会话/记忆。
  try {
    const health = await state.api.health();
    if (health && health.storage) return true;
  } catch {
    /* 健康检查失败不致命 */
  }
  try {
    await state.api.listConversations();
    return true;
  } catch (error) {
    if (isUnsupported(error)) return false;
    return true; // 其它错误（500/网络）先当成 v3，运行时再降级
  }
}

function degradeToV1(message) {
  state.v3 = false;
  state.conversationId = null;
  saveConversationId(null);
  dom.app.dataset.v3 = 'false';
  dom.convSubtitle.textContent = '本地会话';
  updateStatusChips();
  renderConversationList();
  if (message) toast(message);
}

async function ensureConversation(options = {}) {
  if (state.v3 === false) return null;
  if (state.conversationId && !options.fresh) return state.conversationId;
  if (options.fresh) {
    state.conversationId = null;
    saveConversationId(null);
  }
  try {
    const conversation = await state.api.createConversation();
    state.v3 = true;
    state.conversationId = conversation?.id || null;
    saveConversationId(state.conversationId);
    updateConversationTitle(conversationTitle(conversation));
    updateStatusChips();
    return state.conversationId;
  } catch (error) {
    if (isUnsupported(error)) {
      degradeToV1('后端未启用会话历史，已降级为本地会话。');
    } else {
      degradeToV1(`创建会话失败（${humanizeError(error)}），已降级为本地会话。`);
    }
    return null;
  }
}

async function refreshConversations() {
  if (state.v3 === false) {
    state.conversations = [];
    renderConversationList();
    return;
  }
  try {
    state.conversations = await state.api.listConversations();
    state.v3 = true;
  } catch (error) {
    if (isUnsupported(error)) {
      degradeToV1('后端未启用会话历史，已降级为本地会话。');
      return;
    }
    state.conversations = [];
  }
  renderConversationList();
  // 首轮回答结束后后端会自动生成标题：列表刷新时同步到顶栏，不必等下一次进入。
  const current = state.conversations.find((conversation) => conversation.id === state.conversationId);
  if (current) updateConversationTitle(conversationTitle(current));
}

function renderConversationList() {
  dom.convList.replaceChildren();
  if (state.v3 === false) {
    dom.convEmpty.hidden = false;
    dom.convEmpty.textContent = '当前后端未启用会话历史，消息只保留在这次打开里。';
    return;
  }
  const conversations = state.conversations;
  dom.convEmpty.hidden = conversations.length > 0;
  dom.convEmpty.textContent = '还没有历史会话。';
  for (const conversation of conversations) {
    const li = el('li', 'conv-item');
    li.dataset.id = conversation.id;
    if (conversation.id === state.conversationId) li.dataset.current = 'true';

    const load = el('button', 'conv-load');
    load.type = 'button';
    load.append(
      el('span', 'conv-title', conversationTitle(conversation)),
      el(
        'span',
        'conv-meta',
        `${formatRelativeTime(conversation.updatedAt)} · ${Number(conversation.turnCount) || 0} 轮`,
      ),
    );
    load.addEventListener('click', () => loadConversation(conversation.id));

    const del = el('button', 'conv-del', '✕');
    del.type = 'button';
    del.setAttribute('aria-label', `删除会话：${conversationTitle(conversation)}`);
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteConversation(conversation.id);
    });

    const exp = el('button', 'conv-export', '↓');
    exp.type = 'button';
    exp.title = '导出 Markdown';
    exp.setAttribute('aria-label', `导出 Markdown：${conversationTitle(conversation)}`);
    exp.addEventListener('click', (event) => {
      event.stopPropagation();
      exportConversationMarkdown(conversation.id);
    });

    li.append(load, exp, del);
    dom.convList.append(li);
  }
}

/** 本地日期 YYYY-MM-DD（会话导出文件名用）。 */
function markdownDateStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/** 文件名安全化：去掉路径分隔符与控制字符，限制长度。 */
function fileSafeTitle(title) {
  const raw = String(title || '').trim() || 'conversation';
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, '-');
  return cleaned.slice(0, 60) || 'conversation';
}

/** 把会话与消息拼成 Markdown（正文 + 文末引用列表）；不请求任何新接口。 */
function buildConversationMarkdown(conversation, messages) {
  const title = conversationTitle(conversation || {});
  const lines = [`# ${title}`, ''];
  const citations = [];
  const seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    if (!text) continue;
    lines.push(`## ${message?.role === 'user' ? '我' : 'Chat Terminal'}`, '', text, '');
    for (const citation of Array.isArray(message?.citations) ? message.citations : []) {
      const key = `${citation?.c}|${citation?.title || citation?.heading || citation?.docId || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(citation);
    }
  }
  if (citations.length > 0) {
    lines.push('## 参考资料', '');
    for (const citation of citations) {
      const label =
        [citation?.title, citation?.heading].filter(Boolean).join(' · ') ||
        citation?.docId ||
        '网页';
      const source = citation?.source === 'web' ? citation?.sourceUrl : citation?.docId;
      lines.push(`- [${citation?.c}] ${label}${source ? ` — ${source}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 会话 Markdown 导出（纯前端 Blob 下载，不新增服务端接口）。 */
async function exportConversationMarkdown(conversationId) {
  try {
    const detail = await state.api.getConversation(conversationId);
    const conversation = detail?.conversation || { id: conversationId };
    const markdown = buildConversationMarkdown(conversation, detail?.messages || []);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = `Chat Terminal-${fileSafeTitle(conversationTitle(conversation))}-${markdownDateStamp()}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出 Markdown');
  } catch (error) {
    toast(`导出失败：${humanizeError(error)}`);
  }
}

async function loadConversation(id) {
  if (state.streaming) {
    toast('等这轮回答结束再切换会话。');
    return;
  }
  try {
    const detail = await state.api.getConversation(id);
    state.conversationId = id;
    saveConversationId(id);
    updateConversationTitle(conversationTitle(detail.conversation));
    updateStatusChips();
    clearScreen();
    if (detail.messages.length === 0) showEmpty();
    else {
      hideEmpty();
      for (const message of detail.messages) appendHistoryMessage(message);
      resetFollow();
    }
    closeDrawer();
  } catch (error) {
    if (isUnsupported(error)) {
      degradeToV1('后端未启用会话历史，已降级为本地会话。');
      return;
    }
    toast(`会话读取失败：${humanizeError(error)}`);
  }
}

async function deleteConversation(id) {
  try {
    await state.api.deleteConversation(id);
  } catch (error) {
    toast(`删除失败：${humanizeError(error)}`);
    return;
  }
  const wasCurrent = id === state.conversationId;
  await refreshConversations();
  if (wasCurrent) {
    state.conversationId = null;
    saveConversationId(null);
    clearScreen();
    showEmpty();
    updateStatusChips();
    renderConversationList();
  }
}

async function startNewChat() {
  if (state.streaming) {
    toast('等这轮回答结束再新建对话。');
    return;
  }
  // 手动新建会话 = 放弃上一轮的后台恢复。
  clearBackgroundPending();
  closeDrawer();
  state.conversationId = null;
  saveConversationId(null);
  clearScreen();
  showEmpty();
  updateConversationTitle('新对话');
  updateStatusChips();
  await refreshConversations();
  dom.input.focus({ preventScroll: true });
}

/* ==========================================================================
   历史消息渲染
   ========================================================================== */

function appendHistoryMessage(message) {
  const role = message?.role;
  const text = String(message?.text ?? message?.content ?? '');
  if (role === 'user') {
    const section = el('section', 'turn turn-user');
    section.dataset.role = 'user';
    section.dataset.history = 'true';
    const bubble = el('div', 'bubble');
    bubble.append(el('span', 'bubble-prompt', '>'), document.createTextNode(text));
    section.append(bubble);
    renderUserAttachments(section, normalizeMessageAttachments(message.attachments));
    section.append(el('p', 'turn-meta', '你'));
    dom.screen.append(section);
    return;
  }
  if (role !== 'assistant') return;

  const section = el('section', 'turn turn-bot');
  section.dataset.role = 'bot';
  section.dataset.history = 'true';

  const thinkingText = typeof message.thinking === 'string' ? message.thinking.trim() : '';
  if (thinkingText) {
    // 历史回放与实时同样的固定高度滚动区；有存储用时就显示「（用时 x.xs）」。
    const thinking = createThinkingBlock({ section });
    const durationMs = Number(message.thinkingMs ?? message.thinkingDurationMs);
    thinking.restore(thinkingText, Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : {});
  }

  const line = el('div', 'line');
  const answer = el('div', 'answer');
  answer.dataset.streaming = 'false';
  const answerText = el('span', 'answer-text');
  const citations = Array.isArray(message.citations) ? message.citations : [];
  const ctx = { citations, section };

  for (const token of parseCitations(text)) {
    if (token.type === 'text') {
      answerText.append(document.createTextNode(token.value));
    } else {
      const citation = citations.find((item) => item.c === token.c);
      if (citation) {
        const cite = el('button', 'cite', `[${token.c}]`);
        cite.type = 'button';
        cite.dataset.c = String(token.c);
        cite.setAttribute('aria-label', `查看引用 ${token.c}`);
        cite.addEventListener('click', () => openCitationFromTurn(ctx, token.c));
        answerText.append(cite);
      } else {
        answerText.append(el('span', 'cite cite-static', `[${token.c}]`));
      }
    }
  }
  answer.append(answerText);
  line.append(el('span', 'ps1', '$'), answer);
  section.append(line);

  if (citations.length > 0) renderCitationList(ctx);

  // 历史消息没有 webSearchUsed 字段，用持久化的 web 引用条数反推。
  const historyWebUsed = webCitationCount(citations);
  const parts = ['完'];
  if (message.effort) parts.push(`推理 ${effortLabel(message.effort)}`);
  if (historyWebUsed > 0) parts.push(`联网来源 ${historyWebUsed} 条`);
  if (parts.length > 0) {
    const runMeta = el('p', 'run-meta', parts.join(' · '));
    runMeta.dataset.websearch = historyWebUsed > 0 ? 'used' : 'off';
    section.append(runMeta);
  }

  const historyAttachments = normalizeMessageAttachments(message.attachments);
  if (historyAttachments.length > 0) {
    renderAnswerAttachments({ section, line, attachments: historyAttachments, attachmentView: null });
  }

  dom.screen.append(section);
}

/* ==========================================================================
   发送与流式事件
   ========================================================================== */

function setStreaming(streaming) {
  state.streaming = streaming;
  dom.app.dataset.streaming = String(streaming);
  dom.attachBtn.disabled = streaming;
  dom.attachInput.disabled = streaming;
  updateSendState();
  if (streaming) setRunState('streaming');
  else if (dom.stateChip.dataset.state !== 'error') setRunState('ready');
}

function updateSendState() {
  dom.send.disabled = state.streaming || !isSendable(dom.input.value);
}

function autoGrowInput() {
  const input = dom.input;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

function updateCharCount() {
  const label = charCountLabel(dom.input.value);
  dom.charCount.hidden = label === '';
  dom.charCount.textContent = label;
  dom.charCount.classList.toggle('is-warn', charCountNearLimit(dom.input.value));
}

function appendUserTurn(message, attachments = []) {
  const section = el('section', 'turn turn-user');
  section.dataset.role = 'user';
  const bubble = el('div', 'bubble');
  bubble.append(el('span', 'bubble-prompt', '>'), document.createTextNode(message));
  section.append(bubble);
  renderUserAttachments(section, attachments);
  section.append(el('p', 'turn-meta', '你'));
  dom.screen.append(section);
}

function handleStreamEvent(ctx, event, data, controller) {
  switch (event) {
    case 'meta': {
      ctx.meta = data;
      ctx.citations = Array.isArray(data.citations) ? data.citations : [];
      const attachments = normalizeMetaAttachments(data.attachments);
      if (attachments.length > 0) {
        ctx.attachments = attachments;
        renderAnswerAttachments(ctx);
      }
      if (Number(data.memoryUsed) > 0) ctx.setMemoryUsed(data.memoryUsed);
      // 联网使用了多少条（0=未用/失败）；meta 到达即结束「联网中…」。
      ctx.webSearchUsed = normalizeWebSearchUsed(data.webSearchUsed);
      state.webSearchUsed = ctx.webSearchUsed;
      if (dom.stateChip.dataset.state === 'websearch') setRunState('streaming');
      if (data.conversationId) {
        state.conversationId = data.conversationId;
        state.v3 = true;
        saveConversationId(state.conversationId);
        updateConversationTitle(data.title);
        updateStatusChips();
      }
      if (!state.v3 && data.sessionId && data.sessionId !== state.sessionId) {
        state.sessionId = data.sessionId;
        writeKey(LEGACY_SESSION_KEY, state.sessionId);
        updateStatusChips();
      }
      break;
    }
    case 'thinking_delta': {
      if (typeof data.text === 'string') ctx.thinking.append(data.text);
      maybeFollow();
      break;
    }
    case 'text_delta': {
      if (typeof data.text === 'string') {
        if (ctx.thinking.streaming) ctx.thinking.finish(); // 正文开始 → 自动收起
        ctx.answer.append(data.text);
      }
      maybeFollow();
      break;
    }
    case 'done': {
      ctx.done = true;
      ctx.finish();
      setRunState('ready');
      break;
    }
    case 'error': {
      ctx.fail({ apiCode: data.code, message: data.message, retryable: data.retryable });
      try {
        controller.abort();
      } catch {
        /* 已结束 */
      }
      break;
    }
    default:
      break; // 未知事件忽略：向前兼容
  }
}

async function requestChatStream(body, controller) {
  // -hotfix：AUTH=on 下 POST /api/chat 需要 CSRF double-submit 头（此前漏带 → 生产 403）。
  const buildHeaders = () => {
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
    const csrf = state.api?.csrfToken ? state.api.csrfToken() : '';
    if (csrf) headers['x-csrf-token'] = csrf;
    return headers;
  };
  const send = () =>
    fetch('/api/chat', {
      method: 'POST',
      headers: buildHeaders(),
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  let response = await send();
  if (response.status === 403 && !controller.signal.aborted) {
    // 其他标签页重新登录会轮换 CSRF cookie：刷新一次登录态后重试一次（仅 403 无流，可安全重试）。
    try {
      await state.api?.getAuthMe?.({ timeoutMs: 3000 });
    } catch {
      /* 刷新失败则保留原始 403 */
    }
    if (!controller.signal.aborted) response = await send();
  }
  if (!response.ok) {
    let detail = null;
    try {
      detail = await response.json();
    } catch {
      /* 非 JSON 错误体 */
    }
    const error = new ApiError(detail?.error?.message || `HTTP ${response.status}`, {
      status: response.status,
      code: detail?.error?.code || (response.status === 404 ? 'NOT_FOUND' : 'INTERNAL'),
    });
    throw error;
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    throw new ApiError('响应不是 SSE 流', { code: 'PROTOCOL' });
  }
  if (!response.body) throw new ApiError('响应没有可读取的流', { code: 'PROTOCOL' });
  return response;
}

async function sendMessage(rawText) {
  const message = normalizeMessage(rawText);
  if (state.streaming) return;
  const drafts = state.chatDrafts.slice();
  if (!isSendable(message)) {
    if (drafts.length > 0) toast('给附件补一句说明，再一起发送。');
    return;
  }
  // 新的手动发送接管上一轮的后台恢复（清 pending 并停轮询）。
  clearBackgroundPending();
  state.pageHidden = false;
  const attachments = buildAttachmentPayload(drafts);
  const webSearchOn = state.webSearch === 'on' && state.webSearchSupported === true;

  if (state.v3 !== false && !state.conversationId) {
    await ensureConversation();
  }

  const userTurnMessage = message;
  hideEmpty();
  appendUserTurn(userTurnMessage, drafts);
  clearDrafts('chat');
  dom.input.value = '';
  updateCharCount();
  autoGrowInput();
  updateSendState();
  resetFollow();

  const ctx = createAssistantTurn();
  ctx.webSearchOn = webSearchOn;
  setStreaming(true);
  if (webSearchOn) setRunState('websearch'); // meta 到达后恢复 streaming
  if (drafts.length > 0) renderParsingAttachments(ctx, drafts);

  const controller = new AbortController();
  state.abort = controller;

  const makeBody = () =>
    buildChatBody({
      message,
      effort: state.demo ? 'high' : state.effort,
      conversationId: state.conversationId,
      memory: state.memory === 'on',
      sessionId: state.sessionId,
      v3: state.v3 !== false,
      attachments,
      // 仅在开启时带字段；关闭/旧后端保持旧请求体。
      webSearch: webSearchOn ? 'on' : undefined,
    });

  try {
    let body = makeBody();
    let response;
    try {
      response = await requestChatStream(body, controller);
    } catch (error) {
      // 会话在服务端被删/重启后 404：建一个新会话再重试一次。
      if (
        error?.status === 404 &&
        body.conversationId &&
        state.v3 !== false &&
        !ctx.errored
      ) {
        state.conversationId = null;
        saveConversationId(null);
        const newId = await ensureConversation({ fresh: true });
        if (newId) {
          body = makeBody();
          response = await requestChatStream(body, controller);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    await consumeSSE(
      response.body,
      (event, data) => {
        try {
          handleStreamEvent(ctx, event, data, controller);
        } catch (error) {
          ctx.fail(error);
          controller.abort();
        }
      },
      { signal: controller.signal },
    );

    if (!ctx.done && !ctx.errored) {
      throw new ApiError('连接提前结束，回答可能不完整', { code: 'PROTOCOL' });
    }
  } catch (error) {
    if (ctx.errored) {
      /* 已渲染 error 行 */
    } else if (
      isBackgroundInterruption({
        error,
        hidden: document.hidden,
        pageHidden: state.pageHidden,
      })
    ) {
      // 页面不可见/离页导致的流中断不渲染红色错误；记 pending，等回页轮询补渲染。
      ctx.backgroundInterrupted();
      rememberBackgroundPending(state.conversationId);
    } else if (error?.name === 'AbortError') {
      if (!ctx.done) ctx.fail(Object.assign(new Error('连接已中断'), { apiCode: 'ABORTED' }));
    } else if (error?.status === 404 && state.v3 !== false) {
      degradeToV1('后端未启用会话历史，已降级为本地会话。');
      ctx.fail(error);
    } else {
      ctx.fail(error);
    }
  } finally {
    ctx.finish();
    state.abort = null;
    setStreaming(false);
    updateSendState();
    dom.input.focus({ preventScroll: true });
    maybeFollow();
    if (state.v3 !== false) refreshConversations();
  }
}

/* ==========================================================================
   离页后台续跑（前端轮询现有 GET /api/conversations/:id）
   ========================================================================== */

function getSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readBackgroundPending() {
  try {
    return parseBackgroundPending(getSessionStorage()?.getItem(BG_PENDING_KEY) || null);
  } catch {
    return null;
  }
}

function writeBackgroundPending(pending) {
  try {
    if (pending) getSessionStorage()?.setItem(BG_PENDING_KEY, JSON.stringify(pending));
    else getSessionStorage()?.removeItem(BG_PENDING_KEY);
  } catch {
    /* 隐私模式：忽略，内存态仍可用 */
  }
}

/** 页面转隐藏/离页：暂停 180s 计时（隐藏期不计入超时）。 */
function pauseBackgroundClock() {
  if (!state.backgroundPending || state.backgroundPausedAt) return;
  state.backgroundPausedAt = Date.now();
}

function resumeBackgroundClock() {
  if (!state.backgroundPausedAt) return;
  state.backgroundPausedMs += Date.now() - state.backgroundPausedAt;
  state.backgroundPausedAt = 0;
}

function stopBackgroundPolling() {
  if (state.backgroundTimer) {
    window.clearTimeout(state.backgroundTimer);
    state.backgroundTimer = 0;
  }
  state.backgroundBusy = false;
}

/** 手动发送/新建会话时清掉待恢复记录并停轮询。 */
function clearBackgroundPending() {
  writeBackgroundPending(null);
  state.backgroundPending = null;
  state.backgroundStartedAt = 0;
  state.backgroundPausedMs = 0;
  state.backgroundPausedAt = 0;
  stopBackgroundPolling();
}

/** 流在页面不可见时中断：记 {conversationId, at}，等回到页面后轮询补渲染。 */
function rememberBackgroundPending(conversationId) {
  stopBackgroundPolling();
  state.backgroundPausedMs = 0;
  state.backgroundPausedAt = 0;
  if (typeof conversationId !== 'string' || conversationId === '') {
    state.backgroundPending = null;
    state.backgroundStartedAt = 0;
    return;
  }
  const pending = { conversationId, at: Date.now() };
  state.backgroundPending = pending;
  state.backgroundStartedAt = pending.at;
  writeBackgroundPending(pending);
  scheduleBackgroundPoll(0);
}

/** 单例定时器：重复调度只保留最后一个（防轮询泄漏）。 */
function scheduleBackgroundPoll(delay = BG_POLL_INTERVAL_MS) {
  if (!state.backgroundPending) return;
  if (state.backgroundTimer) window.clearTimeout(state.backgroundTimer);
  state.backgroundTimer = window.setTimeout(pollBackgroundGeneration, Math.max(0, delay));
}

async function pollBackgroundGeneration() {
  state.backgroundTimer = 0;
  const pending = state.backgroundPending;
  if (!pending || state.backgroundBusy) return;
  // 隐藏/离线时不发请求也不推进计时，等可见/联网事件重新调度。
  if (document.hidden || navigator.onLine === false) {
    pauseBackgroundClock();
    return;
  }
  const elapsed = Date.now() - state.backgroundStartedAt - state.backgroundPausedMs;
  state.backgroundBusy = true;
  try {
    const detail = await state.api?.getConversation?.(pending.conversationId);
    state.backgroundBusy = false;
    if (!state.backgroundPending) return;
    if (backgroundAssistantReady(detail, pending)) {
      const isCurrent = pending.conversationId === state.conversationId;
      clearBackgroundPending();
      if (isCurrent) {
        await loadConversation(pending.conversationId);
        toast('后台生成已完成');
      } else {
        await refreshConversations();
        toast('后台生成已完成，可在会话列表查看');
      }
      return;
    }
    if (elapsed > BG_POLL_TIMEOUT_MS) {
      clearBackgroundPending();
      toast('后台生成未完成，请重新发送');
      return;
    }
    scheduleBackgroundPoll();
  } catch (error) {
    state.backgroundBusy = false;
    if (!state.backgroundPending) return;
    if (error?.status === 404) {
      clearBackgroundPending();
      toast('后台生成未完成，请重新发送');
      return;
    }
    if (elapsed > BG_POLL_TIMEOUT_MS) {
      clearBackgroundPending();
      toast('后台生成未完成，请重新发送');
      return;
    }
    scheduleBackgroundPoll();
  }
}

/**
 * 回到页面/启动后恢复后台生成。
 * 幂等：pending 已存在时只刷新单例定时器，不会重复请求。
 */
function resumeBackgroundGeneration() {
  if (!state.api) return;
  if (document.hidden || navigator.onLine === false) return;
  let pending = state.backgroundPending;
  if (!pending) {
    pending = readBackgroundPending();
    if (!pending) return;
  }
  state.backgroundPending = pending;
  if (!state.backgroundStartedAt) state.backgroundStartedAt = pending.at;
  resumeBackgroundClock();
  scheduleBackgroundPoll(0);
}

/* ==========================================================================
   抽屉 / 记忆面板
   ========================================================================== */

function openDrawer() {
  if (!dom.drawer.hidden) return;
  state.lastFocus = document.activeElement;
  dom.drawer.hidden = false;
  dom.app.dataset.drawer = 'open';
  dom.drawerToggle.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => dom.drawer.classList.add('is-open'));
  refreshConversations();
  refreshMemoryCount();
  refreshLibraryCount();
  refreshMarksCount();
  refreshScalesCount();
  dom.drawerClose.focus({ preventScroll: true });
}

/** 抽屉底部的「记忆 N 条」要在打开时就准确，不必等进过记忆面板。 */
async function refreshMemoryCount() {
  if (state.v3 === false) return;
  try {
    state.memories = await state.api.listMemories();
    updateMemoryCount();
  } catch {
    /* 记忆接口失败不影响抽屉 */
  }
}

function closeDrawer() {
  if (dom.drawer.hidden) return;
  dom.app.dataset.drawer = 'closed';
  dom.drawerToggle.setAttribute('aria-expanded', 'false');
  dom.drawer.classList.remove('is-open');
  const hide = () => {
    dom.drawer.hidden = true;
  };
  if (prefersReducedMotion()) hide();
  else window.setTimeout(hide, OVERLAY_TRANSITION_MS);
  const restoreFocus = state.lastFocus;
  state.lastFocus = null;
  if (restoreFocus && document.contains(restoreFocus)) {
    requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
  }
}

/** 记忆级别与类别（core 按类别展示；trivia 固定「其他」。 */
const MEMORY_LEVELS = ['core', 'trivia'];
const MEMORY_LEVEL_LABELS = { core: '长期记忆（核心）', trivia: '琐事摘要' };
const MEMORY_CATEGORIES = [
  ['general', '情绪状态'],
  ['demographics', '年龄性别'],
  ['health', '健康背景'],
  ['family', '家庭'],
  ['identity', '身份认同'],
  ['interpersonal', '人际'],
  ['academic', '学业'],
  ['upload', '上传内容'],
  ['other', '其他'],
];
const MEMORY_CATEGORY_KEYS = MEMORY_CATEGORIES.map(([key]) => key);
const MEMORY_CATEGORY_LABELS = Object.fromEntries(MEMORY_CATEGORIES);
const MEMORY_EMPTY_TEXT =
  '还没有记住的事。长期记忆每轮参考；琐事摘要只在与对话相关时参考。';

function memoryLevelOf(memory) {
  return memory && memory.level === 'trivia' ? 'trivia' : 'core';
}

function memoryCategoryOf(memory) {
  if (memoryLevelOf(memory) === 'trivia') return 'other';
  const category = memory && memory.category;
  return MEMORY_CATEGORY_KEYS.includes(category) ? category : 'other';
}

async function openMemoryPanel() {
  closeDrawer();
  if (!dom.memoryPanel.hidden) return;
  state.lastFocus = document.activeElement;
  dom.memoryPanel.hidden = false;
  requestAnimationFrame(() => dom.memoryPanel.classList.add('is-open'));
  dom.memoryToggle.checked = state.memory === 'on';
  if (state.v3 === false) {
    state.memories = [];
    renderMemoryList('当前后端未启用长期记忆。');
    dom.memoryToggle.disabled = true;
    dom.memoryForm.querySelector('.memory-add').disabled = true;
    dom.memoryAttachBtn.disabled = true;
    dom.memoryClear.disabled = true;
  } else {
    dom.memoryToggle.disabled = false;
    dom.memoryForm.querySelector('.memory-add').disabled = false;
    dom.memoryAttachBtn.disabled = false;
    await loadMemories();
  }
  dom.memoryBack.focus({ preventScroll: true });
}

function closeMemoryPanel() {
  if (dom.memoryPanel.hidden) return;
  dom.memoryPanel.classList.remove('is-open');
  const hide = () => {
    dom.memoryPanel.hidden = true;
  };
  if (prefersReducedMotion()) hide();
  else window.setTimeout(hide, OVERLAY_TRANSITION_MS);
  const restoreFocus = state.lastFocus;
  state.lastFocus = null;
  if (restoreFocus && document.contains(restoreFocus)) {
    requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
  }
}

async function loadMemories() {
  try {
    state.memories = await state.api.listMemories();
    state.v3 = true;
    renderMemoryList();
  } catch (error) {
    if (isUnsupported(error)) {
      degradeToV1('后端未启用长期记忆。');
      renderMemoryList('当前后端未启用长期记忆。');
      return;
    }
    renderMemoryList(`记忆读取失败：${humanizeError(error)}`);
  }
}

function renderMemoryList(emptyText) {
  const memories = Array.isArray(state.memories) ? state.memories : [];
  dom.memoryList.replaceChildren();
  dom.memoryEmpty.hidden = memories.length > 0;
  dom.memoryEmpty.textContent = emptyText || MEMORY_EMPTY_TEXT;
  updateMemoryCount();
  dom.memoryClear.disabled = state.v3 === false || memories.length === 0;
  for (const level of MEMORY_LEVELS) {
    const items = memories.filter((memory) => memoryLevelOf(memory) === level);
    if (items.length === 0) continue; // 空组不渲染
    const group = el('li', 'memory-group');
    group.dataset.level = level;
    const head = el('h3', 'memory-group-head');
    head.append(el('span', 'memory-group-title', MEMORY_LEVEL_LABELS[level]));
    head.append(el('span', 'memory-group-count', `${items.length} 条`));
    group.append(head);
    const list = el('ul', 'memory-group-items');
    for (const memory of items) list.append(renderMemoryItem(memory));
    group.append(list);
    dom.memoryList.append(group);
  }
}

/** core 行显示类别标签，trivia 行显示「琐事」；每行带编辑/删除。 */
function renderMemoryItem(memory) {
  const level = memoryLevelOf(memory);
  const category = memoryCategoryOf(memory);
  const li = el('li', 'memory-item');
  li.dataset.memoryId = memory.id;
  li.dataset.level = level;
  li.dataset.category = category;
  const body = el('div', 'memory-text', memory.text);
  const date = formatRelativeTime(memory.createdAt);
  if (date) body.append(el('span', 'memory-date', date));
  const meta = el('div', 'memory-meta');
  meta.append(
    el(
      'span',
      level === 'trivia' ? 'memory-level-chip' : 'memory-cat-chip',
      level === 'trivia' ? '琐事' : MEMORY_CATEGORY_LABELS[category],
    ),
  );
  const attachments = Array.isArray(memory.attachments) ? memory.attachments : [];
  const attachmentRow = el('div', 'memory-attachments');
  for (const attachment of attachments) {
    const thumb = createAttachmentThumb(attachment, 'memory-attach-thumb');
    if (thumb) attachmentRow.append(thumb);
  }
  if (!attachmentRow.children.length && attachments.length > 0) {
    attachmentRow.append(
      el('span', 'memory-attach-mark', attachments.some((item) => item.kind === 'image') ? '图' : '文'),
    );
  }
  const actions = el('div', 'memory-item-actions');
  const edit = el('button', 'memory-edit', '编辑');
  edit.type = 'button';
  edit.setAttribute('aria-label', '编辑这条记忆');
  edit.addEventListener('click', () => startMemoryEdit(memory, li));
  const del = el('button', 'memory-del', '✕');
  del.type = 'button';
  del.setAttribute('aria-label', '删除这条记忆');
  del.addEventListener('click', () => deleteMemory(memory.id));
  actions.append(edit, del);
  li.append(body, meta);
  if (attachmentRow.children.length > 0) li.append(attachmentRow);
  li.append(actions);
  return li;
}

/** 行内编辑（textarea + 级别 select + 类别 select，category 仅 core 可选）。 */
function startMemoryEdit(memory, li) {
  const level = memoryLevelOf(memory);
  const category = memoryCategoryOf(memory);
  li.classList.add('is-editing');
  li.replaceChildren();
  const editor = el('div', 'memory-editor');
  const textarea = el('textarea', 'memory-edit-text');
  textarea.rows = 3;
  textarea.maxLength = 800;
  textarea.value = String(memory.text || '');
  textarea.setAttribute('aria-label', '记忆内容（1–800 字）');
  const fields = el('div', 'memory-edit-fields');
  const levelField = el('label', 'memory-edit-field');
  levelField.append(el('span', 'memory-edit-label', '级别'));
  const levelSelect = el('select', 'memory-edit-level');
  levelSelect.setAttribute('aria-label', '记忆级别');
  levelSelect.append(new Option('核心', 'core', false, level === 'core'));
  levelSelect.append(new Option('琐事', 'trivia', false, level === 'trivia'));
  levelField.append(levelSelect);
  const categoryField = el('label', 'memory-edit-field');
  categoryField.append(el('span', 'memory-edit-label', '类别'));
  const categorySelect = el('select', 'memory-edit-category');
  categorySelect.setAttribute('aria-label', '记忆类别（仅核心记忆可选）');
  for (const [key, label] of MEMORY_CATEGORIES) {
    categorySelect.append(new Option(label, key, false, key === category));
  }
  categoryField.append(categorySelect);
  fields.append(levelField, categoryField);
  const hint = el('p', 'memory-edit-hint');
  hint.setAttribute('role', 'alert');
  const actions = el('div', 'memory-editor-actions');
  const save = el('button', 'memory-edit-save', '保存');
  save.type = 'button';
  const cancel = el('button', 'memory-edit-cancel', '取消');
  cancel.type = 'button';
  actions.append(save, cancel);
  editor.append(textarea, fields, hint, actions);
  li.append(editor);

  const syncCategoryState = () => {
    const trivia = levelSelect.value === 'trivia';
    categorySelect.disabled = trivia;
    if (trivia) categorySelect.value = 'other';
  };
  syncCategoryState();
  levelSelect.addEventListener('change', syncCategoryState);
  const restore = () => renderMemoryList();
  cancel.addEventListener('click', restore);
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      restore();
    }
  });
  save.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (text.length < 1 || text.length > 800) {
      hint.textContent = '内容需为 1–800 字。';
      textarea.focus();
      return;
    }
    const patch = { text, level: levelSelect.value };
    if (levelSelect.value === 'core') patch.category = categorySelect.value;
    hint.textContent = '';
    save.disabled = true;
    try {
      const updated = await state.api.updateMemory(memory.id, patch);
      if (updated) {
        state.memories = state.memories.map((item) => (item.id === memory.id ? updated : item));
      }
      await loadMemories();
      toast('已保存修改。');
    } catch (error) {
      save.disabled = false;
      hint.textContent = `保存失败：${humanizeError(error)}`;
    }
  });
  textarea.focus();
  try {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  } catch {
    /* 忽略选区异常 */
  }
}

async function deleteMemory(id) {
  try {
    await state.api.deleteMemory(id);
    state.memories = state.memories.filter((memory) => memory.id !== id);
    renderMemoryList();
  } catch (error) {
    toast(`删除失败：${humanizeError(error)}`);
  }
}

async function clearMemories() {
  if (state.v3 === false) return;
  try {
    await state.api.clearMemories();
    state.memories = [];
    renderMemoryList();
    toast('已清空全部记忆。');
  } catch (error) {
    toast(`清空失败：${humanizeError(error)}`);
  }
}

async function addMemory(rawText) {
  const text = String(rawText || '').trim();
  const drafts = state.memoryDrafts.slice();
  if (!text && drafts.length === 0) return;
  const attachments = buildAttachmentPayload(drafts);
  try {
    const memory = await state.api.addMemory(text, attachments);
    if (memory) state.memories = [memory, ...state.memories];
    dom.memoryInput.value = '';
    clearDrafts('memory');
    renderMemoryList();
    toast(attachments.length > 0 ? '已记住（含 1 个附件）。' : '已记住。');
  } catch (error) {
    toast(`添加失败：${humanizeError(error)}`);
  }
}

/* ==========================================================================
   文档库（GET /api/library）
   ========================================================================== */

/** 字符数 → 「547.82 万字」；未知返回空串。 */
function formatWan(chars) {
  const value = Number(chars);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${(value / 10000).toFixed(2)} 万字`;
}

function libraryStatsLine(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.books) parts.push(`${stats.books} 本书`);
  if (stats.docs) parts.push(`${stats.docs} 篇`);
  const chars = formatWan(stats.chars);
  if (chars) parts.push(chars);
  return parts.join(' · ');
}

function updateLibraryCount() {
  const docs = state.library?.stats?.docs;
  dom.libraryCount.textContent = docs ? `${docs} 篇` : '—';
}

/** 抽屉打开时顺带取一次文档库统计（接口失败不影响抽屉）。 */
async function refreshLibraryCount() {
  if (state.library) {
    updateLibraryCount();
    return;
  }
  try {
    const data = await state.api.getLibrary();
    const hasDisciplines = Array.isArray(data?.disciplines) && data.disciplines.length > 0;
    const hasGroups = Array.isArray(data?.groups) && data.groups.length > 0;
    if (data && (hasDisciplines || hasGroups)) {
      state.library = data;
      updateLibraryCount();
    }
  } catch {
    /* 文档库不可用：入口仍可打开，面板内提示重试 */
  }
}

async function openLibraryPanel() {
  closeDrawer();
  if (!dom.libraryPanel.hidden) return;
  state.lastFocus = document.activeElement;
  dom.libraryPanel.hidden = false;
  requestAnimationFrame(() => dom.libraryPanel.classList.add('is-open'));
  dom.libraryBack.focus({ preventScroll: true });
  if (state.library) renderLibrary(state.library);
  else await loadLibrary();
}

function closeLibraryPanel() {
  if (dom.libraryPanel.hidden) return;
  dom.libraryPanel.classList.remove('is-open');
  const hide = () => {
    dom.libraryPanel.hidden = true;
  };
  if (prefersReducedMotion()) hide();
  else window.setTimeout(hide, OVERLAY_TRANSITION_MS);
  const restoreFocus = state.lastFocus;
  state.lastFocus = null;
  if (restoreFocus && document.contains(restoreFocus)) {
    requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
  }
}

async function loadLibrary() {
  dom.libraryStats.textContent = '';
  dom.libraryStatus.hidden = false;
  dom.libraryStatus.dataset.state = 'loading';
  dom.libraryStatus.textContent = '正在打开文档库…';
  dom.libraryRetry.hidden = true;
  dom.libraryDisciplines.replaceChildren();
  dom.libraryDisciplines.hidden = true;
  dom.libraryGroups.replaceChildren();
  try {
    const data = await state.api.getLibrary();
    const disciplines = libraryDisciplinesOf(data);
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    if (!data || (disciplines.length === 0 && groups.length === 0)) {
      throw new ApiError('文档库暂不可用', { code: 'EMPTY' });
    }
    state.library = data;
    renderLibrary(data);
  } catch {
    state.library = null;
    dom.libraryStatus.hidden = false;
    dom.libraryStatus.dataset.state = 'error';
    dom.libraryStatus.textContent = '文档库暂不可用';
    dom.libraryRetry.hidden = false;
    dom.libraryGroups.replaceChildren();
  }
}

const LIBRARY_THEMES_WARNING =
  '主题分组暂不可用，仅显示公版、政府、国际组织、论文、行业规范与模板卡。';
const LIBRARY_TAXONOMY_WARNING = '学科分类暂不可用，已回退到按主题分组。';

/** 两级分类数据：只认 disciplines[].topics[] 形状，缺字段时按空处理。 */
function libraryDisciplinesOf(data) {
  if (!Array.isArray(data?.disciplines)) return [];
  return data.disciplines.filter((discipline) => discipline && Array.isArray(discipline.topics));
}

/** 统计行后的小字：N 学科 / M 主题（旧 17 组结构没有该信息时返回空串）。 */
function libraryDisciplineSummary(data) {
  const disciplines = libraryDisciplinesOf(data);
  if (disciplines.length === 0) return '';
  const topics = disciplines.reduce((sum, discipline) => sum + discipline.topics.length, 0);
  return `${disciplines.length} 学科 / ${topics} 主题`;
}

function renderLibrary(data) {
  const summary = libraryDisciplineSummary(data);
  const statsLine = libraryStatsLine(data.stats);
  dom.libraryStats.textContent = summary ? (statsLine ? `${statsLine} · ${summary}` : summary) : statsLine;
  if (data.warning === 'taxonomy_unavailable' || data.warning === 'themes_unavailable') {
    dom.libraryStatus.hidden = false;
    dom.libraryStatus.dataset.state = 'warning';
    dom.libraryStatus.textContent =
      data.warning === 'taxonomy_unavailable' ? LIBRARY_TAXONOMY_WARNING : LIBRARY_THEMES_WARNING;
  } else {
    dom.libraryStatus.hidden = true;
    dom.libraryStatus.textContent = '';
    delete dom.libraryStatus.dataset.state;
  }
  dom.libraryRetry.hidden = true;
  const disciplines = libraryDisciplinesOf(data);
  if (disciplines.length > 0) {
    // 默认选中第一个学科；切换学科只重渲染，不重新请求（内存缓存）。
    const known = disciplines.some((discipline) => discipline.id === state.libraryDisciplineId);
    state.libraryDisciplineId = known ? state.libraryDisciplineId : disciplines[0].id;
    renderLibraryDisciplines(disciplines);
    renderLibraryTopics(disciplines);
    return;
  }
  // 降级路径：旧 17 组扁平手风琴（保留 /的既有渲染与断言）。
  state.libraryDisciplineId = '';
  dom.libraryDisciplines.hidden = true;
  dom.libraryDisciplines.replaceChildren();
  dom.libraryGroups.replaceChildren(...(data.groups || []).map(renderLibraryGroup));
}

/** 学科方向 chips（横向可滚；←/→ 切换，Home/End 跳到首尾，Enter/Space 选中）。 */
function renderLibraryDisciplines(disciplines) {
  const chips = disciplines.map((discipline) => {
    const chip = el('button', 'library-discipline-chip');
    chip.type = 'button';
    chip.dataset.discipline = discipline.id;
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-label', `${discipline.name || discipline.id}（${discipline.topics.length} 个主题）`);
    const selected = discipline.id === state.libraryDisciplineId;
    chip.setAttribute('aria-selected', selected ? 'true' : 'false');
    chip.tabIndex = selected ? 0 : -1;
    chip.append(el('span', 'library-discipline-name', discipline.name || discipline.id));
    chip.addEventListener('click', () => selectLibraryDiscipline(discipline.id));
    chip.addEventListener('keydown', onLibraryDisciplineKeydown);
    return chip;
  });
  dom.libraryDisciplines.hidden = false;
  dom.libraryDisciplines.replaceChildren(...chips);
  // 重新渲染后横向滚动归零，再把当前选中 chip 滚到完整可见（含圆角与呼吸边距）。
  dom.libraryDisciplines.scrollLeft = 0;
  const active = chips.find((chip) => chip.dataset.discipline === state.libraryDisciplineId);
  revealLibraryDisciplineChip(active);
}

function libraryDisciplineChips() {
  return [...dom.libraryDisciplines.querySelectorAll('.library-discipline-chip')];
}

/**
 * 把 chips 容器内的目标 chip 完整滚入可视区（左右各留 pad 呼吸边距）。
 * 只滚 chips 容器自身，不调用 scrollIntoView（避免把面板/整页一起滚走）。
 */
function revealLibraryDisciplineChip(chip, { pad = 10 } = {}) {
  const container = dom.libraryDisciplines;
  if (!chip || !container) return;
  const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
  const containerRect = container.getBoundingClientRect();
  const chipRect = chip.getBoundingClientRect();
  const leftGap = chipRect.left - containerRect.left;
  const rightGap = containerRect.right - chipRect.right;
  let next = container.scrollLeft;
  if (leftGap < pad) next = container.scrollLeft - (pad - leftGap);
  else if (rightGap < pad) next = container.scrollLeft + (pad - rightGap);
  container.scrollLeft = Math.min(Math.max(0, next), maxScroll);
}

/** 选中学科：更新 chips 状态并只渲染该学科的主题折叠组（不重新请求）。 */
function selectLibraryDiscipline(id, { focus = false } = {}) {
  const disciplines = libraryDisciplinesOf(state.library);
  const discipline = disciplines.find((item) => item.id === id);
  if (!discipline) return;
  state.libraryDisciplineId = discipline.id;
  for (const chip of libraryDisciplineChips()) {
    const selected = chip.dataset.discipline === discipline.id;
    chip.setAttribute('aria-selected', selected ? 'true' : 'false');
    chip.tabIndex = selected ? 0 : -1;
  }
  renderLibraryTopics(disciplines);
  const active = libraryDisciplineChips().find((chip) => chip.dataset.discipline === discipline.id);
  if (active) {
    // 选中 chip 完整可见并留呼吸边距；容器内部滚动，不带动面板/整页。
    revealLibraryDisciplineChip(active);
    if (focus) active.focus({ preventScroll: true });
  }
}

function onLibraryDisciplineKeydown(event) {
  const key = event.key;
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' '].includes(key)) return;
  const chips = libraryDisciplineChips();
  const index = chips.indexOf(event.currentTarget);
  if (index < 0) return;
  event.preventDefault();
  if (key === 'Enter' || key === ' ') {
    selectLibraryDiscipline(chips[index].dataset.discipline, { focus: true });
    return;
  }
  let next = index;
  if (key === 'ArrowRight') next = (index + 1) % chips.length;
  if (key === 'ArrowLeft') next = (index - 1 + chips.length) % chips.length;
  if (key === 'Home') next = 0;
  if (key === 'End') next = chips.length - 1;
  selectLibraryDiscipline(chips[next].dataset.discipline, { focus: true });
}

/** 渲染选中学科的主题折叠组（复用旧组手风琴渲染与条目渲染）。 */
function renderLibraryTopics(disciplines) {
  const selected =
    disciplines.find((discipline) => discipline.id === state.libraryDisciplineId) || disciplines[0];
  state.libraryDisciplineId = selected.id;
  dom.libraryGroups.replaceChildren(
    ...selected.topics.map((topic) =>
      renderLibraryGroup({ id: topic.id, name: topic.name, desc: topic.desc, items: topic.items || [] }),
    ),
  );
}

/** 分组单位：主题组与固定组用「本/篇/份」。 */
function libraryGroupUnit(group) {
  if (group.id === 'worksheets') return '份';
  const items = Array.isArray(group.items) ? group.items : [];
  if (items.length > 0 && items.every((item) => item.kind === 'collection')) return '份';
  if (items.length > 0 && items.every((item) => item.kind === 'doc')) return '篇';
  return '本';
}

/** 固定组内同源聚合条目的总篇数（aggregate:"source" 的 book 展开后是 N 篇原文）。 */
function libraryGroupDocs(group) {
  const items = Array.isArray(group.items) ? group.items : [];
  return items.reduce(
    (total, item) =>
      total +
      (item.kind === 'book' && item.aggregate === 'source' ? item.docCount || (item.chapters || []).length : 1),
    0,
  );
}

function libraryGroupHasAggregate(group) {
  const items = Array.isArray(group.items) ? group.items : [];
  return items.some((item) => item.kind === 'book' && item.aggregate === 'source');
}

function libraryGroupCount(group) {
  const items = Array.isArray(group.items) ? group.items : [];
  if (group.id === 'worksheets') {
    const collection = items.find((item) => item.kind === 'collection');
    return collection?.count || items.length;
  }
  return items.length;
}

function setLibraryGroupOpen(section, open) {
  section.dataset.open = open ? 'true' : 'false';
  const head = section.querySelector('.lib-group-head');
  const list = section.querySelector('.lib-list');
  const caret = head ? head.querySelector('.lib-caret') : null;
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (list) list.hidden = !open;
  if (caret) caret.textContent = open ? '▾' : '▸';
}

function closeLibraryGroups(except) {
  for (const section of dom.libraryGroups.querySelectorAll('.lib-group[data-open="true"]')) {
    if (section !== except) setLibraryGroupOpen(section, false);
  }
}

function toggleLibraryGroup(section) {
  const open = section.dataset.open === 'true';
  closeLibraryGroups(section);
  setLibraryGroupOpen(section, !open);
  if (open) return;
  // 展开后若组头被推出视口，滚到最近可见位置，避免用户找不到刚点开的组
  requestAnimationFrame(() => {
    const head = section.querySelector('.lib-group-head');
    const body = section.closest('.panel-body');
    if (!head || !body) return;
    const headRect = head.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    if (headRect.top < bodyRect.top || headRect.bottom > bodyRect.bottom) {
      head.scrollIntoView({ block: 'nearest' });
    }
  });
}

function renderLibraryGroup(group) {
  const section = el('section', 'lib-group');
  section.dataset.group = group.id;
  section.dataset.open = 'false';

  const head = el('button', 'lib-group-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');
  head.addEventListener('click', () => toggleLibraryGroup(section));

  const titles = el('span', 'lib-group-titles');
  titles.append(el('span', 'lib-group-name', group.name || group.id));
  if (group.desc) titles.append(el('span', 'lib-group-desc', group.desc));

  const side = el('span', 'lib-group-side');
  const metaText = libraryGroupHasAggregate(group)
    ? `${(group.items || []).length} 项 · ${libraryGroupDocs(group)} 篇`
    : `${libraryGroupCount(group)} ${libraryGroupUnit(group)}`;
  side.append(el('span', 'lib-group-meta', metaText));
  const caret = el('span', 'lib-caret', '▸');
  caret.setAttribute('aria-hidden', 'true');
  side.append(caret);
  head.append(titles, side);

  const list = el('ul', 'lib-list');
  list.id = `lib-group-list-${group.id}`;
  list.hidden = true;
  head.setAttribute('aria-controls', list.id);
  for (const item of group.items || []) {
    const node = renderLibraryItem(item);
    if (node) list.append(node);
  }

  section.append(head, list);
  return section;
}

function renderLibraryItem(item) {
  if (!item) return null;
  if (item.kind === 'book') return renderLibraryBook(item);
  if (item.kind === 'collection') return renderLibraryCollection(item);
  return renderLibraryDoc(item);
}

function renderLibraryBook(book) {
  const li = el('li', 'lib-item');
  const button = el('button', 'lib-book');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');

  const main = el('span', 'lib-book-main');
  main.append(el('span', 'lib-book-title', book.title || book.slug));
  const meta = [book.author, book.publisher, book.year].filter(Boolean).join(' · ');
  if (meta) main.append(el('span', 'lib-book-meta', meta));

  const side = el('span', 'lib-book-side');
  if (book.docCount) {
    const chars = formatWan(book.chars);
    const unit = book.aggregate === 'source' ? '篇' : '章';
    side.append(el('span', 'lib-book-count', `${book.docCount} ${unit}${chars ? ` · ${chars}` : ''}`));
  }
  if (book.ocr) side.append(el('span', 'lib-badge', '扫描 OCR'));
  const caret = el('span', 'lib-caret', '▸');
  side.append(caret);
  button.append(main, side);

  const chapters = el('ol', 'lib-chapters');
  chapters.hidden = true;
  for (const chapter of book.chapters || []) {
    const chapterItem = el('li', 'lib-chapter-item');
    const chapterButton = el('button', 'lib-chapter');
    chapterButton.type = 'button';
    chapterButton.append(el('span', 'lib-chapter-title', chapter.title || chapter.docId));
    chapterButton.append(el('span', 'lib-chapter-doc', chapter.docId));
    chapterButton.addEventListener('click', () => openLibraryDoc(chapter.docId, chapter.title, book));
    chapterItem.append(chapterButton);
    chapters.append(chapterItem);
  }

  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    chapters.hidden = !open;
    caret.textContent = open ? '▾' : '▸';
  });

  li.append(button, chapters);
  return li;
}

function renderLibraryDoc(doc) {
  const li = el('li', 'lib-item');
  const button = el('button', 'lib-doc');
  button.type = 'button';
  button.append(el('span', 'lib-doc-title', doc.title || doc.docId));
  const meta = [doc.license, formatWan(doc.chars)].filter(Boolean).join(' · ');
  if (meta) button.append(el('span', 'lib-doc-meta', meta));
  button.addEventListener('click', () => openLibraryDoc(doc.docId, doc.title, doc));
  li.append(button);
  return li;
}

const LIBRARY_SITE_NAMES = {
};

function renderLibraryCollection(collection) {
  const li = el('li', 'lib-item');
  const button = el('button', 'lib-book lib-coll-head');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');

  const main = el('span', 'lib-book-main');
  main.append(el('span', 'lib-book-title', collection.title || collection.id));
  if (collection.note) main.append(el('span', 'lib-book-meta', collection.note));

  const side = el('span', 'lib-book-side');
  side.append(el('span', 'lib-book-count', `${collection.count || 0} 份`));
  const caret = el('span', 'lib-caret', '▸');
  side.append(caret);
  button.append(main, side);

  const body = el('div', 'lib-coll-items');
  body.hidden = true;
  const bySite = new Map();
  for (const sheet of collection.items || []) {
    const site = sheet.site || '其它';
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(sheet);
  }
  for (const [site, sheets] of bySite) {
    const group = el('section', 'lib-site');
    group.dataset.site = site;
    const name = LIBRARY_SITE_NAMES[site] || site;
    group.append(el('h4', 'lib-site-name', `${name}（${sheets.length} 份）`));
    const list = el('ul', 'lib-ws-list');
    for (const sheet of sheets) {
      const item = el('li');
      const sheetButton = el('button', 'lib-ws', sheet.title || sheet.docId);
      sheetButton.type = 'button';
      sheetButton.addEventListener('click', () => openLibraryDoc(sheet.docId, sheet.title, sheet));
      item.append(sheetButton);
      list.append(item);
    }
    group.append(list);
    body.append(group);
  }

  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    caret.textContent = open ? '▾' : '▸';
  });

  li.append(button, body);
  return li;
}

/** 从文档库打开原文：阅读器定位到第一节首段（登录后可返回文档库原位置）。 */
function openLibraryDoc(docId, title, source) {
  if (!docId) return;
  openReader({
    docId,
    title: title || source?.title || docId,
    license: source?.license || '',
    openAtStart: true,
  });
}

/* ==========================================================================
   收藏片段（GET/POST /api/marks、DELETE /api/marks/{id}）
   ========================================================================== */

function updateMarksCounts() {
  const excerpts = state.marks?.excerpts?.length ?? 0;
  const favorites = state.marks?.favorites?.length ?? 0;
  const supported = state.marksSupported !== false;
  dom.marksCount.textContent = supported ? `${excerpts + favorites} 条` : '—';
  dom.marksFavCount.textContent = `${favorites} 条`;
  dom.marksExcCount.textContent = `${excerpts} 条`;
}

/** 取一次 GET /api/marks（默认用缓存；force=true 强制刷新）。 */
async function fetchMarks({ force = false } = {}) {
  if (state.marks && !force) return state.marks;
  try {
    const data = await state.api.getMarks();
    state.marks = {
      excerpts: Array.isArray(data?.excerpts) ? data.excerpts : [],
      favorites: Array.isArray(data?.favorites) ? data.favorites : [],
    };
    state.marksSupported = true;
    updateMarksCounts();
    return state.marks;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) state.marksSupported = false;
    updateMarksCounts();
    throw error;
  }
}

/** 抽屉打开时顺手取一次条数；接口失败不影响抽屉。 */
async function refreshMarksCount() {
  try {
    await fetchMarks();
  } catch {
    updateMarksCounts();
  }
}

function favoriteFor(docId) {
  return state.marks?.favorites?.find((item) => item.docId === docId) || null;
}

function setReaderFavoriteState(isFavorite) {
  if (!dom.favoriteBtn) return;
  const active = Boolean(isFavorite);
  dom.favoriteBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  dom.favoriteBtn.classList.toggle('is-active', active);
  dom.favoriteIcon.textContent = active ? '★' : '☆';
  dom.favoriteBtn.setAttribute('aria-label', active ? '取消收藏' : '收藏');
  const text = dom.favoriteBtn.querySelector('.reader-tool-label');
  if (text) text.textContent = active ? '已收藏' : '收藏';
}

async function refreshReaderFavorite() {
  const docId = state.readerDocId;
  if (!docId) return;
  try {
    await fetchMarks();
    if (state.readerDocId !== docId) return;
    state.readerFavoriteId = favoriteFor(docId)?.id || null;
    setReaderFavoriteState(Boolean(state.readerFavoriteId));
  } catch {
    if (state.readerDocId !== docId) return;
    setReaderFavoriteState(Boolean(favoriteFor(docId)));
  }
}

/** ★ 收藏切换：已收藏 → DELETE；未收藏 → POST favorite。 */
async function toggleFavorite() {
  const docId = state.readerDocId;
  if (!docId) return;
  if (state.marksSupported === false) {
    toast('收藏片段暂不可用');
    return;
  }
  const existing = favoriteFor(docId);
  try {
    if (existing) {
      await state.api.deleteMark(existing.id);
      state.marks.favorites = state.marks.favorites.filter((item) => item.id !== existing.id);
      state.readerFavoriteId = null;
      setReaderFavoriteState(false);
      updateMarksCounts();
      renderMarksIfOpen();
      toast('已取消收藏');
      return;
    }
    const result = await state.api.addMark({ kind: 'favorite', docId });
    const item = result?.item;
    if (item) {
      state.marks.favorites = [item, ...state.marks.favorites.filter((entry) => entry.id !== item.id)];
    } else {
      await fetchMarks({ force: true });
    }
    state.readerFavoriteId = item?.id || favoriteFor(docId)?.id || null;
    setReaderFavoriteState(true);
    updateMarksCounts();
    renderMarksIfOpen();
    toast(result?.duplicated ? '已收藏过' : '已收藏');
  } catch (error) {
    toast(`收藏失败：${humanizeError(error)}`);
  }
}

function currentExcerptTarget() {
  return dom.readerBody.querySelector('.doc-para.is-target') || dom.readerBody.querySelector('.doc-para');
}

/** ✎ 摘录：保存当前高亮段落（无高亮取首段）；para 是文档内全局段号。 */
async function saveExcerpt() {
  const docId = state.readerDocId;
  if (!docId) return;
  if (state.marksSupported === false) {
    toast('收藏片段暂不可用');
    return;
  }
  const target = currentExcerptTarget();
  const section = target ? target.closest('.doc-section') : null;
  const anchor = section?.dataset.anchor || '';
  const para = Number(target?.dataset.para);
  if (!target || !anchor || !Number.isInteger(para)) {
    toast('正文还没加载好');
    return;
  }
  try {
    const result = await state.api.addMark({ kind: 'excerpt', docId, anchor, para });
    const item = result?.item;
    if (item) {
      state.marks.excerpts = [item, ...state.marks.excerpts.filter((entry) => entry.id !== item.id)];
    } else {
      await fetchMarks({ force: true });
    }
    updateMarksCounts();
    renderMarksIfOpen();
    toast(result?.duplicated ? '已摘录过' : '已摘录');
  } catch (error) {
    toast(`摘录失败：${humanizeError(error)}`);
  }
}

async function openMarksPanel() {
  closeDrawer();
  if (!dom.marksPanel.hidden) return;
  state.lastFocus = document.activeElement;
  dom.marksPanel.hidden = false;
  requestAnimationFrame(() => dom.marksPanel.classList.add('is-open'));
  dom.marksBack.focus({ preventScroll: true });
  await loadMarks();
}

function closeMarksPanel() {
  if (dom.marksPanel.hidden) return;
  dom.marksPanel.classList.remove('is-open');
  const hide = () => {
    dom.marksPanel.hidden = true;
  };
  if (prefersReducedMotion()) hide();
  else window.setTimeout(hide, OVERLAY_TRANSITION_MS);
  const restoreFocus = state.lastFocus;
  state.lastFocus = null;
  if (restoreFocus && document.contains(restoreFocus)) {
    requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
  }
}

/* ==========================================================================
   记录面板（导入摘要 + 最近 7 天 + 清空）
   ========================================================================== */
const HEALTH_EMPTY_TEXT =
  '还没有导入记录。按 docs/health-shortcut.md 配置 iOS 快捷指令后，数据会自动出现在这里。';

async function openHealthPanel() {
  closeDrawer();
  if (!dom.healthPanel.hidden) return;
  state.lastFocus = document.activeElement;
  dom.healthPanel.hidden = false;
  requestAnimationFrame(() => dom.healthPanel.classList.add('is-open'));
  dom.healthBack.focus({ preventScroll: true });
  await loadHealth();
}

function closeHealthPanel() {
  if (dom.healthPanel.hidden) return;
  dom.healthPanel.classList.remove('is-open');
  const hide = () => {
    dom.healthPanel.hidden = true;
  };
  if (prefersReducedMotion()) hide();
  else window.setTimeout(hide, OVERLAY_TRANSITION_MS);
  const restoreFocus = state.lastFocus;
  state.lastFocus = null;
  if (restoreFocus && document.contains(restoreFocus)) {
    requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
  }
}

async function loadHealth() {
  dom.healthStatus.hidden = false;
  dom.healthStatus.dataset.state = 'loading';
  dom.healthStatus.textContent = '正在读取记录…';
  dom.healthRetry.hidden = true;
  try {
    const payload = await state.api.getHealth();
    state.health = payload;
    renderHealth(payload);
    dom.healthStatus.hidden = true;
  } catch (error) {
    state.health = null;
    renderHealth(null);
    dom.healthClear.disabled = true;
    dom.healthStatus.hidden = false;
    dom.healthStatus.dataset.state = 'error';
    if (isUnsupported(error)) {
      dom.healthStatus.textContent = '当前后端未启用记录。';
      dom.healthRetry.hidden = true;
    } else {
      dom.healthStatus.textContent = `记录读取失败：${humanizeError(error)}`;
      dom.healthRetry.hidden = false;
    }
  }
}

function renderHealth(payload) {
  const view = healthViewFromPayload(payload);
  dom.healthLastImported.textContent = view.lastImportedLabel;
  dom.healthSummary.replaceChildren();
  const cards = [
    ['步数（日均）', view.summary.steps.label],
    ['睡眠（日均）', view.summary.sleep.label],
    ['静息心率（日均）', view.summary.restingHeartRate.label],
    ['HRV（日均）', view.summary.hrv.label],
    ['体重（最新）', view.summary.weight.label],
    ['运动（7 天）', view.summary.workouts.label],
  ];
  for (const [label, value] of cards) {
    const card = el('div', 'health-card');
    card.append(el('span', 'health-card-label', label));
    card.append(el('span', 'health-card-value', value));
    dom.healthSummary.append(card);
  }
  dom.healthList.replaceChildren();
  for (const day of view.days) {
    const row = el('li', 'health-day');
    row.dataset.date = day.date;
    row.append(el('span', 'health-day-date', day.dateLabel));
    const metrics = el('span', 'health-day-metrics');
    metrics.append(el('span', 'health-day-metric', `步数 ${day.stepsLabel}`));
    metrics.append(el('span', 'health-day-metric', `睡眠 ${day.sleepLabel}`));
    metrics.append(el('span', 'health-day-metric', `静息心率 ${day.restingHeartRateLabel}`));
    metrics.append(el('span', 'health-day-metric', `运动 ${day.workoutLabel}`));
    row.append(metrics);
    dom.healthList.append(row);
  }
  dom.healthSummary.hidden = !view.hasData;
  dom.healthList.hidden = !view.hasData;
  dom.healthEmpty.hidden = view.hasData;
  dom.healthClear.disabled = !view.hasData;
  dom.healthCount.textContent = view.hasData ? `${view.days.length} 天` : '—';
}

async function clearHealthData() {
  if (dom.healthClear.disabled) return;
  const confirmed = window.confirm('清空后已导入的记录会被删除，且无法恢复。确定清空？');
  if (!confirmed) return;
  dom.healthClear.disabled = true;
  try {
    await state.api.clearHealth();
    toast('记录已清空');
    await loadHealth();
  } catch (error) {
    dom.healthClear.disabled = false;
    toast(`清空失败：${humanizeError(error)}`);
  }
}

async function loadMarks() {
  dom.marksStatus.hidden = false;
  dom.marksStatus.dataset.state = 'loading';
  dom.marksStatus.textContent = '正在打开收藏片段…';
  dom.marksRetry.hidden = true;
  try {
    await fetchMarks({ force: true });
    renderMarksPanel();
    dom.marksStatus.hidden = true;
    dom.marksStatus.textContent = '';
    delete dom.marksStatus.dataset.state;
  } catch {
    renderMarksPanel();
    dom.marksStatus.hidden = false;
    dom.marksStatus.dataset.state = 'error';
    dom.marksStatus.textContent = '收藏片段暂不可用';
    dom.marksRetry.hidden = false;
  }
}

function renderMarksIfOpen() {
  if (!dom.marksPanel.hidden) renderMarksPanel();
}

function renderMarksPanel() {
  updateMarksCounts();
  const favorites = state.marks?.favorites || [];
  const excerpts = state.marks?.excerpts || [];
  dom.marksFavList.replaceChildren(...favorites.map(renderFavoriteMark));
  dom.marksExcList.replaceChildren(...excerpts.map(renderExcerptMark));
  dom.marksFavEmpty.hidden = favorites.length > 0;
  dom.marksExcEmpty.hidden = excerpts.length > 0;
}

function openMarkInReader(item, kind) {
  closeMarksPanel();
  if (kind === 'excerpt') {
    openReader({ docId: item.docId, title: item.bookTitle, anchor: item.anchor, para: item.para });
    return;
  }
  openReader({ docId: item.docId, title: item.bookTitle, openAtStart: true });
}

async function deleteMark(item) {
  try {
    await state.api.deleteMark(item.id);
    state.marks.excerpts = state.marks.excerpts.filter((entry) => entry.id !== item.id);
    state.marks.favorites = state.marks.favorites.filter((entry) => entry.id !== item.id);
    updateMarksCounts();
    renderMarksPanel();
    if (state.readerDocId && !favoriteFor(state.readerDocId)) setReaderFavoriteState(false);
    toast('已删除');
  } catch (error) {
    toast(`删除失败：${humanizeError(error)}`);
  }
}

/** 复制纯文本（优先剪贴板 API，失败走 textarea 兜底）；返回是否成功。 */
async function copyToClipboard(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 剪贴板被拒时走下面的兜底 */
  }
  try {
    const area = el('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

async function copyExcerpt(item) {
  const copied = await copyToClipboard(item.text);
  toast(copied ? '已复制' : '复制失败，请长按选择原文');
}

/** 复制一条引用的纯文本（标题 / 摘录 / 来源）。 */
async function copyCitationText(citation) {
  const parts = [];
  const title = citation?.title || citation?.heading || citation?.docId || '';
  if (title) parts.push(String(title));
  const excerpt = typeof citation?.text === 'string' ? citation.text.trim() : '';
  if (excerpt) parts.push(excerpt);
  else if (typeof citation?.anchor === 'string' && citation.anchor.trim()) {
    parts.push(citation.anchor.trim());
  }
  const source = citation?.source === 'web' ? citation?.sourceUrl : citation?.docId;
  if (source) parts.push(String(source));
  const text = parts.length > 0 ? parts.join('\n') : `[${citation?.c}]`;
  const copied = await copyToClipboard(text);
  toast(copied ? '已复制引用' : '复制失败，请长按选择');
}

function renderFavoriteMark(item) {
  const li = el('li', 'marks-item marks-fav');
  const open = el('button', 'marks-fav-open');
  open.type = 'button';
  open.setAttribute('aria-label', `打开《${item.bookTitle || item.docId}》`);
  open.append(el('span', 'marks-fav-title', item.bookTitle || item.docId));
  const meta = formatRelativeTime(item.createdAt);
  if (meta) open.append(el('span', 'marks-meta', `收藏于 ${meta}`));
  open.addEventListener('click', () => openMarkInReader(item, 'favorite'));
  const actions = el('div', 'marks-actions');
  const del = el('button', 'marks-action marks-delete', '删除');
  del.type = 'button';
  del.setAttribute('aria-label', `删除收藏：${item.bookTitle || item.docId}`);
  del.addEventListener('click', () => deleteMark(item));
  actions.append(del);
  li.append(open, actions);
  return li;
}

function renderExcerptMark(item) {
  const li = el('li', 'marks-item marks-exc');
  const open = el('button', 'marks-exc-open');
  open.type = 'button';
  open.setAttribute('aria-label', `打开摘录并定位：${item.bookTitle || item.docId}`);
  open.append(el('blockquote', 'marks-quote', item.text || ''));
  const source = [item.bookTitle, item.sectionHeading].filter(Boolean).join(' · ');
  if (source) open.append(el('span', 'marks-source', source));
  const meta = formatRelativeTime(item.createdAt);
  if (meta) open.append(el('span', 'marks-meta', `摘录于 ${meta}`));
  open.addEventListener('click', () => openMarkInReader(item, 'excerpt'));
  const actions = el('div', 'marks-actions');
  // -F：长摘录默认 3 行 clamp，加「展开/收起」低成本入口（不改变点击卡片打开阅读器的既有路径）。
  if ((item.text || '').length > 70) {
    const more = el('button', 'marks-action marks-more', '展开');
    more.type = 'button';
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', '展开摘录全文');
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      const expanded = li.classList.toggle('is-expanded');
      more.setAttribute('aria-expanded', String(expanded));
      more.textContent = expanded ? '收起' : '展开';
      more.setAttribute('aria-label', expanded ? '收起摘录全文' : '展开摘录全文');
    });
    actions.append(more);
  }
  const copy = el('button', 'marks-action marks-copy', '复制');
  copy.type = 'button';
  copy.setAttribute('aria-label', '复制摘录原文');
  copy.addEventListener('click', () => copyExcerpt(item));
  const del = el('button', 'marks-action marks-delete', '删除');
  del.type = 'button';
  del.setAttribute('aria-label', '删除这条摘录');
  del.addEventListener('click', () => deleteMark(item));
  actions.append(copy, del);
  li.append(open, actions);
  return li;
}

/* ==========================================================================
   自评问卷（列表 → 逐题作答 → 结果；答案与结果只在本页，不保存）
   ========================================================================== */

/** 固定求助资源（与契约 9.3 safetyAdvisory 文案一致）。 */
const SCALE_HELP_RESOURCES = [
  { label: '演示帮助热线', tel: '000' },
  { label: '120 急救', tel: '120' },
  { label: '110 报警', tel: '110' },
  { label: '12355 青少年服务台', tel: '12355' },
];

function setScalesSupported(supported) {
  state.scalesSupported = supported;
  if (dom.scalesEntry) dom.scalesEntry.hidden = supported === false;
}

/** 抽屉入口显示「4 份」；404 时隐藏入口（旧后端没有问卷）。 */
async function refreshScalesCount() {
  if (state.scalesSupported === false) return;
  try {
    const data = await state.api.getScales();
    state.scales = data;
    const scales = Array.isArray(data?.scales) ? data.scales : [];
    const visible = visibleScales(scales, scaleCategories());
    dom.scalesCount.textContent = visible.length > 0 ? `${visible.length} 份` : '—';
    setScalesSupported(true);
  } catch (error) {
    if (isUnsupported(error)) {
      setScalesSupported(false);
      return;
    }
    dom.scalesCount.textContent = '—';
  }
}

async function openScalesPanel() {
  closeDrawer();
  if (!dom.scalesPanel.hidden) return;
  state.lastFocus = document.activeElement;
  dom.scalesPanel.hidden = false;
  requestAnimationFrame(() => dom.scalesPanel.classList.add('is-open'));
  dom.scalesBack.focus({ preventScroll: true });
  resetScalesPanel();
  await loadScales();
}

function closeScalesPanel() {
  if (dom.scalesPanel.hidden) return;
  resetScalesPanel();
  dom.scalesPanel.classList.remove('is-open');
  const hide = () => {
    dom.scalesPanel.hidden = true;
  };
  if (prefersReducedMotion()) hide();
  else window.setTimeout(hide, OVERLAY_TRANSITION_MS);
  const restoreFocus = state.lastFocus;
  state.lastFocus = null;
  if (restoreFocus && document.contains(restoreFocus)) {
    requestAnimationFrame(() => restoreFocus.focus({ preventScroll: true }));
  }
}

/** 离开面板就清掉题目、答案与结果（不写 localStorage / 记忆 / 会话）。 */
function resetScalesPanel() {
  state.scalesCurrent = null;
  state.scalesAnswers = null;
  state.scalesPage = 1;
  state.scalesSex = null;
  state.scalesBusy = false;
  if (dom.scalesForm) {
    dom.scalesForm.replaceChildren();
    dom.scalesForm.hidden = true;
  }
  if (dom.scalesResult) {
    dom.scalesResult.replaceChildren();
    dom.scalesResult.hidden = true;
  }
  if (dom.scalesList) dom.scalesList.hidden = false;
  if (dom.scalesRetry) dom.scalesRetry.hidden = true;
  state.scalesHistory = null;
  state.scalesHistoryCurrent = null;
  state.scalesHistoryBusy = false;
  if (dom.scalesHistory) {
    hideScalesHistory();
    dom.scalesHistoryContent.hidden = true;
    dom.scalesHistoryEmpty.hidden = true;
    dom.scalesHistoryStatus.hidden = true;
  }
  setScalesHistoryEntryVisible(true);
  if (dom.scalesStatus) {
    dom.scalesStatus.hidden = true;
    dom.scalesStatus.textContent = '';
    delete dom.scalesStatus.dataset.state;
  }
}

async function loadScales() {
  dom.scalesStatus.hidden = false;
  dom.scalesStatus.dataset.state = 'loading';
  dom.scalesStatus.textContent = '正在载入问卷…';
  dom.scalesRetry.hidden = true;
  try {
    const data = await state.api.getScales();
    state.scales = data;
    const scales = Array.isArray(data?.scales) ? data.scales : [];
    const visible = visibleScales(scales, scaleCategories());
    dom.scalesCount.textContent = visible.length > 0 ? `${visible.length} 份` : '—';
    setScalesSupported(true);
    renderScalesList(scales);
    dom.scalesStatus.hidden = true;
    dom.scalesStatus.textContent = '';
    delete dom.scalesStatus.dataset.state;
  } catch (error) {
    renderScalesList([]);
    dom.scalesStatus.hidden = false;
    dom.scalesStatus.dataset.state = 'error';
    dom.scalesStatus.textContent = isUnsupported(error) ? '问卷暂不可用' : '问卷暂不可用，请稍后重试';
    dom.scalesRetry.hidden = false;
  }
}

/** 历史入口只在「问卷列表」视图出现（答题 / 结果页不露出，避免丢失作答）。 */
function setScalesHistoryEntryVisible(visible) {
  if (dom.scalesHistoryEntry) dom.scalesHistoryEntry.hidden = !visible;
}

/* ---------------- 问卷历史（趋势图 + 明细删除 + 清空） ---------------- */

const SCALE_HISTORY_EMPTY_TEXT = '还没有记录。完成一次自评后，这里会显示趋势。';
const SCALE_CHART_MOBILE_HEIGHT = 220;
const SCALE_CHART_DESKTOP_HEIGHT = 250;
const SCALE_CHART_PADDING = { top: 18, right: 18, bottom: 34, left: 42 };
const SVG_NS = 'http://www.w3.org/2000/svg';
let scaleChartResizeTimer = 0;

function hideScalesHistory() {
  if (!dom.scalesHistory) return;
  dom.scalesHistory.hidden = true;
  hideScaleChartTip();
  if (dom.scalesHistoryConfirm) dom.scalesHistoryConfirm.hidden = true;
}

/** 从列表进入历史视图：隐藏列表/表单/结果，加载历史。 */
async function openScalesHistory() {
  if (dom.scalesPanel.hidden || state.scalesHistoryBusy) return;
  state.scalesHistoryCurrent = null;
  dom.scalesHistory.hidden = false;
  dom.scalesList.hidden = true;
  dom.scalesForm.hidden = true;
  dom.scalesResult.hidden = true;
  dom.scalesRetry.hidden = true;
  dom.scalesHistoryConfirm.hidden = true;
  await loadScalesHistory();
}

function closeScalesHistory() {
  hideScalesHistory();
  dom.scalesList.hidden = false;
  setScalesHistoryEntryVisible(true);
  if (state.scales?.scales?.length) renderScalesList(state.scales.scales);
  dom.scalesHistoryEntry.focus({ preventScroll: true });
}

async function loadScalesHistory() {
  if (!state.api) return;
  state.scalesHistoryBusy = true;
  dom.scalesHistoryStatus.hidden = false;
  dom.scalesHistoryStatus.dataset.state = 'loading';
  dom.scalesHistoryStatus.textContent = '正在载入历史数据…';
  dom.scalesHistoryRetry.hidden = true;
  dom.scalesHistoryContent.hidden = true;
  dom.scalesHistoryEmpty.hidden = true;
  try {
    const payload = await state.api.getScalesHistory({ limit: 100 });
    const view = buildScaleHistoryView(payload);
    state.scalesHistory = view;
    if (!view.hasData) {
      dom.scalesHistoryStatus.hidden = true;
      dom.scalesHistoryStatus.textContent = '';
      delete dom.scalesHistoryStatus.dataset.state;
      dom.scalesHistoryEmpty.textContent = SCALE_HISTORY_EMPTY_TEXT;
      dom.scalesHistoryEmpty.hidden = false;
      dom.scalesHistoryContent.hidden = true;
      // 清空后不保留上一次的图表/明细 DOM（隐藏容器里的旧数据不应被读屏或样式残留感知）。
      dom.scalesHistoryChips.replaceChildren();
      dom.scalesHistoryList.replaceChildren();
      dom.scalesHistoryCount.textContent = '';
      dom.scaleChartTitle.textContent = '';
      dom.scaleChartNote.textContent = '';
      dom.scaleChart.replaceChildren();
      hideScaleChartTip();
      return;
    }
    const ids = view.scales.map((item) => item.scaleId);
    if (!state.scalesHistoryCurrent || !ids.includes(state.scalesHistoryCurrent)) {
      state.scalesHistoryCurrent = view.scales[0].scaleId;
    }
    dom.scalesHistoryStatus.hidden = true;
    dom.scalesHistoryStatus.textContent = '';
    delete dom.scalesHistoryStatus.dataset.state;
    dom.scalesHistoryEmpty.hidden = true;
    dom.scalesHistoryContent.hidden = false;
    renderScalesHistory(view);
  } catch (error) {
    state.scalesHistory = null;
    dom.scalesHistoryContent.hidden = true;
    dom.scalesHistoryEmpty.hidden = true;
    dom.scalesHistoryStatus.hidden = false;
    dom.scalesHistoryStatus.dataset.state = 'error';
    dom.scalesHistoryStatus.textContent = isUnsupported(error)
      ? '当前后端未启用问卷历史。'
      : '历史数据载入失败，请稍后重试';
    dom.scalesHistoryRetry.hidden = false;
  } finally {
    state.scalesHistoryBusy = false;
  }
}

function renderScalesHistory(view) {
  const current =
    view.scales.find((item) => item.scaleId === state.scalesHistoryCurrent) || view.scales[0];
  if (!current) return;
  state.scalesHistoryCurrent = current.scaleId;
  renderScalesHistoryChips(view, current);
  renderScaleChart(buildScaleTrend(current));
  dom.scaleChartTitle.textContent = `${current.name} · 共 ${current.count} 次`;
  const note = buildScaleTrend(current).note;
  dom.scaleChartNote.textContent = note || '';
  renderScalesHistoryList(current);
  dom.scalesHistoryConfirm.hidden = true;
}

function renderScalesHistoryChips(view, current) {
  dom.scalesHistoryChips.replaceChildren();
  for (const scale of view.scales) {
    const chip = el('button', 'scale-history-chip');
    chip.type = 'button';
    chip.dataset.scaleId = scale.scaleId;
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(scale.scaleId === current.scaleId));
    chip.append(el('span', 'scale-history-chip-name', scale.name));
    chip.append(el('span', 'scale-history-chip-count', `${scale.count} 次`));
    chip.addEventListener('click', () => {
      if (state.scalesHistoryCurrent === scale.scaleId || !state.scalesHistory) return;
      state.scalesHistoryCurrent = scale.scaleId;
      hideScaleChartTip();
      renderScalesHistory(state.scalesHistory);
      const active = dom.scalesHistoryChips.querySelector(
        `.scale-history-chip[data-scale-id="${scale.scaleId}"]`,
      );
      if (active) active.focus({ preventScroll: true });
    });
    dom.scalesHistoryChips.append(chip);
  }
}

function renderScalesHistoryList(scale) {
  dom.scalesHistoryList.replaceChildren();
  const entries = Array.isArray(scale.entries) ? [...scale.entries].reverse() : [];
  dom.scalesHistoryCount.textContent = `${scale.count} 条`;
  for (const entry of entries) {
    const li = el('li', 'scales-history-item');
    li.dataset.entryId = entry.id;
    const main = el('div', 'scales-history-item-main');
    main.append(el('span', 'scales-history-date', entry.dateTimeLabel || entry.dateLabel || '—'));
    const scoreLabel = entry.scoreLabel || '总分';
    const scoreText =
      entry.score === null
        ? `${scoreLabel} —`
        : entry.maxScore
          ? `${scoreLabel} ${entry.score}/${entry.maxScore}`
          : `${scoreLabel} ${entry.score}`;
    main.append(el('span', 'scales-history-score', scoreText));
    if (entry.bandLabel) main.append(el('span', 'scales-history-band', entry.bandLabel));
    const del = el('button', 'scales-history-delete', '删除');
    del.type = 'button';
    del.setAttribute('aria-label', `删除 ${entry.dateTimeLabel || entry.dateLabel || ''} 的记录`);
    del.addEventListener('click', () => deleteScaleHistoryEntry(entry.id, del));
    li.append(main, del);
    dom.scalesHistoryList.append(li);
  }
}

async function deleteScaleHistoryEntry(entryId, button) {
  if (!entryId || state.scalesHistoryBusy) return;
  state.scalesHistoryBusy = true;
  if (button) button.disabled = true;
  try {
    await state.api.deleteScaleHistoryEntry(entryId);
    toast('已删除这条记录');
    state.scalesHistoryBusy = false;
    await loadScalesHistory();
  } catch (error) {
    state.scalesHistoryBusy = false;
    if (button) button.disabled = false;
    toast(isUnsupported(error) ? '历史数据暂不可用' : '删除失败，请稍后重试');
  }
}

function requestClearScalesHistory() {
  if (!state.scalesHistory?.hasData) return;
  dom.scalesHistoryConfirm.hidden = false;
  dom.scalesHistoryConfirmClear.focus({ preventScroll: true });
}

function cancelClearScalesHistory() {
  dom.scalesHistoryConfirm.hidden = true;
  dom.scalesHistoryClear.focus({ preventScroll: true });
}

async function confirmClearScalesHistory() {
  if (state.scalesHistoryBusy) return;
  state.scalesHistoryBusy = true;
  dom.scalesHistoryConfirmClear.disabled = true;
  let removed = 0;
  try {
    const result = await state.api.clearScaleHistory();
    removed = Number.isFinite(Number(result?.removed)) ? Number(result.removed) : 0;
    toast(removed > 0 ? `已清空 ${removed} 条记录` : '还没有记录');
  } catch (error) {
    dom.scalesHistoryConfirmClear.disabled = false;
    state.scalesHistoryBusy = false;
    toast(isUnsupported(error) ? '历史数据暂不可用' : '清空失败，请稍后重试');
    return;
  }
  dom.scalesHistoryConfirmClear.disabled = false;
  state.scalesHistoryBusy = false;
  dom.scalesHistoryConfirm.hidden = true;
  state.scalesHistory = null;
  await loadScalesHistory();
}

/* ---------------- 纯 SVG 折线图（无图表库；宽度自适应 + 点按显示数据） ---------------- */

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function scaleChartHeight() {
  return window.matchMedia('(min-width: 760px)').matches
    ? SCALE_CHART_DESKTOP_HEIGHT
    : SCALE_CHART_MOBILE_HEIGHT;
}

function hideScaleChartTip() {
  if (!dom.scaleChartTip) return;
  dom.scaleChartTip.hidden = true;
  dom.scaleChartTip.textContent = '';
  dom.scaleChartTip.style.left = '';
  dom.scaleChartTip.style.top = '';
}

function showScaleChartTip(point, x, y, width) {
  const tip = dom.scaleChartTip;
  const parts = [`${point.dateLabel} ${point.scoreLabel || '总分'} ${point.score}`];
  if (point.maxScore) parts[0] += `/${point.maxScore}`;
  if (point.bandLabel) parts.push(point.bandLabel);
  tip.textContent = parts.join(' · ');
  tip.hidden = false;
  const left = Math.min(Math.max(4, x - 70), Math.max(4, width - 150));
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(0, y - 40)}px`;
}

/** 折线图：网格 + 坐标 + 面积 + 折线 + 数据点（缺失分数断开，单点标数值）。 */
function renderScaleChart(trend) {
  const svg = dom.scaleChart;
  const width = Math.max(240, Math.round(svg.clientWidth || svg.parentElement?.clientWidth || 320));
  const height = scaleChartHeight();
  const padding = SCALE_CHART_PADDING;
  const innerWidth = Math.max(60, width - padding.left - padding.right);
  const innerHeight = Math.max(60, height - padding.top - padding.bottom);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.height = `${height}px`;
  svg.replaceChildren();
  hideScaleChartTip();

  const points = Array.isArray(trend?.points) ? trend.points : [];
  const count = points.length;
  if (count === 0) return;
  const yMax = Math.max(1, Number(trend.yMax) || Number(trend.maxScore) || 1);
  const baseline = padding.top + innerHeight;
  const xOf = (index) =>
    padding.left + (count === 1 ? innerWidth / 2 : (innerWidth * index) / (count - 1));
  const yOf = (score) =>
    padding.top + innerHeight - (Math.max(0, Math.min(score, yMax)) / yMax) * innerHeight;

  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const value = (yMax * i) / ticks;
    const y = yOf(value);
    svg.append(
      svgEl('line', {
        x1: padding.left,
        y1: y,
        x2: padding.left + innerWidth,
        y2: y,
        class: 'scale-chart-grid',
      }),
    );
    svg.append(
      svgEl(
        'text',
        { x: padding.left - 8, y: y + 3.5, class: 'scale-chart-tick', 'text-anchor': 'end' },
        String(Math.round(value)),
      ),
    );
  }
  svg.append(
    svgEl('line', {
      x1: padding.left,
      y1: baseline,
      x2: padding.left + innerWidth,
      y2: baseline,
      class: 'scale-chart-axis',
    }),
  );

  // 缺失分数不连线：先把可绘制的连续段切出来。
  const runs = [];
  let run = [];
  points.forEach((point, index) => {
    if (point.score === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ ...point, index, x: xOf(index), y: yOf(point.score) });
  });
  if (run.length) runs.push(run);

  for (const segment of runs) {
    if (segment.length < 2) continue;
    const top = segment
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
      .join(' ');
    const first = segment[0];
    const last = segment[segment.length - 1];
    const area = `${top} L${last.x.toFixed(1)},${baseline.toFixed(1)} L${first.x.toFixed(1)},${baseline.toFixed(1)} Z`;
    svg.append(svgEl('path', { d: area, class: 'scale-chart-area' }));
    svg.append(svgEl('path', { d: top, class: 'scale-chart-line', fill: 'none' }));
  }

  points.forEach((point, index) => {
    if (point.score === null) return;
    const x = xOf(index);
    const y = yOf(point.score);
    svg.append(svgEl('circle', { cx: x, cy: y, r: 3.2, class: 'scale-chart-dot' }));
    const hit = svgEl('circle', { cx: x, cy: y, r: 16, class: 'scale-chart-hit' });
    hit.setAttribute('tabindex', '0');
    hit.setAttribute('role', 'button');
    const label = `${point.dateLabel} ${point.scoreLabel || '总分'} ${point.score}${
      point.maxScore ? ` / ${point.maxScore}` : ''
    }${point.bandLabel ? `，${point.bandLabel}` : ''}`;
    hit.setAttribute('aria-label', label);
    const show = () => showScaleChartTip(point, x, y, width);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('click', show);
    hit.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        show();
      }
    });
    svg.append(hit);
    if (count === 1) {
      svg.append(
        svgEl(
          'text',
          { x, y: y - 10, class: 'scale-chart-value', 'text-anchor': 'middle' },
          String(point.score),
        ),
      );
    }
  });

  const labelEvery = innerWidth / count < 46 ? 2 : 1;
  points.forEach((point, index) => {
    if (index % labelEvery !== 0 && index !== count - 1) return;
    svg.append(
      svgEl(
        'text',
        {
          x: xOf(index),
          y: padding.top + innerHeight + 20,
          class: 'scale-chart-xlabel',
          'text-anchor': 'middle',
        },
        point.dateLabel,
      ),
    );
  });
}

/** 宽度变化（旋转 / 桌面缩放）时重绘当前图，保持自适应。 */
function scheduleScaleChartRedraw() {
  const view = state.scalesHistory;
  if (!view || !dom.scalesHistory || dom.scalesHistory.hidden) return;
  if (dom.scalesHistoryContent.hidden) return;
  const scale = view.scales.find((item) => item.scaleId === state.scalesHistoryCurrent);
  if (!scale) return;
  clearTimeout(scaleChartResizeTimer);
  scaleChartResizeTimer = window.setTimeout(() => {
    if (!dom.scalesHistory.hidden) renderScaleChart(buildScaleTrend(scale));
  }, 120);
}

/** 大题量问卷一页最多 15 题；≤15 题不分页。 */
const SCALE_PAGE_SIZE = 15;

/**
 * 本地私有问卷包说明：只在列表中确实出现 private:true 的表时展示。
 * 私有表题面来自本机私有文件，不随软件分发；软件本身不收录受版权题面。
 */
const SCALE_PRIVATE_NOTE =
  '本地问卷：题面来自本机私有文件，仅本机可见，不随软件分发；请确认你有权使用该题面。';

/** 是否为本地私有问卷（仅私有包加载的表带 private:true，内置表无此字段）。 */
function isPrivateScale(scale) {
  return Boolean(scale) && scale.private === true;
}

/** v2 常模问卷（私有包里的 kind:'norm' 表，计分与常模换算全部由服务端完成）。 */
function isNormScale(scale) {
  return Boolean(scale) && scale.private === true && scale.kind === 'norm';
}

/** 常模分类型的中文文案（T 分 / 标准十分）。 */
const SCALE_NORM_LABELS = { T: 'T 分', sten: '标准分（1–10）' };
const SCALE_NORM_CHIP = '常模换算';
const SCALE_SEX_LABELS = { male: '男', female: '女' };
const SCALE_NORM_DISCLAIMER =
  '常模换算仅用于自我了解，不构成诊断，也不替代医生或专业人士的专业评估。';

/** 常模分类型的中文说明（表格表头与结果摘要共用）。 */
function normTypeLabel(normType) {
  return SCALE_NORM_LABELS[normType] || '常模分';
}

/**
 * 过滤出真正要渲染的问卷：内置表保持既有行为（含「其他问卷」兜底），
 * 私有表的 categoryId 若不在后端 categories 内则防御性跳过不渲染。
 * 旧后端无分类信息时（categories 为空）平铺全部，与现状一致。
 */
function visibleScales(scales, categories) {
  if (!Array.isArray(scales)) return [];
  const known = new Set((categories || []).map((category) => category.id));
  return scales.filter((scale) => {
    if (!scale || typeof scale !== 'object') return false;
    if (!isPrivateScale(scale)) return true;
    if (known.size === 0) return true;
    return known.has(scale.categoryId);
  });
}

function scalePageSize(scale) {
  const items = Number(scale?.items) || 0;
  return items > SCALE_PAGE_SIZE ? SCALE_PAGE_SIZE : Math.max(1, items);
}

function scalePageCount(scale) {
  const items = Number(scale?.items) || 0;
  return Math.max(1, Math.ceil(items / scalePageSize(scale)));
}

function scalePageBounds(scale, page) {
  const pages = scalePageCount(scale);
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const size = scalePageSize(scale);
  const start = (current - 1) * size + 1;
  const end = Math.min(current * size, Number(scale?.items) || 0);
  return { page: current, pages, start, end };
}

/** 后端返回的分类（旧后端没有 categories → 返回空数组，列表降级平铺）。 */
function scaleCategories() {
  const categories = state.scales?.categories;
  if (!Array.isArray(categories)) return [];
  return categories.filter((category) => category && typeof category.id === 'string');
}

function renderScaleItem(scale) {
  const item = el('button', 'scale-item');
  item.type = 'button';
  item.dataset.scaleId = scale.id;
  const main = el('span', 'scale-item-main');
  const name = el('span', 'scale-item-name', scale.shortName || scale.name || scale.id);
  if (isPrivateScale(scale)) {
    // 名称旁一个克制的小标记；不改变内置表的 DOM 结构。
    const title = el('span', 'scale-item-title');
    title.append(name, el('span', 'scale-private-chip', '本地'));
    if (isNormScale(scale)) title.append(el('span', 'scale-norm-chip', SCALE_NORM_CHIP));
    main.append(title);
  } else {
    main.append(name);
  }
  if (scale.shortName && scale.name) main.append(el('span', 'scale-item-sub', scale.name));
  if (scale.purpose) main.append(el('span', 'scale-item-purpose', scale.purpose));
  const side = el('span', 'scale-item-side');
  const minutes = Math.max(1, Math.ceil((scale.items || 1) / 2));
  side.append(el('span', 'scale-item-meta', `${scale.items} 题 · 约 ${minutes} 分钟`));
  side.append(el('span', 'scale-caret', '▸'));
  item.append(main, side);
  item.addEventListener('click', () => openScaleForm(scale.id));
  return item;
}

function renderScaleCategory(category, scales) {
  const section = el('section', 'scale-category');
  section.dataset.categoryId = category.id;
  const head = el('div', 'scale-category-head');
  head.append(el('h3', 'scale-category-name', category.name || category.id));
  if (category.desc) head.append(el('p', 'scale-category-desc', category.desc));
  section.append(head);
  const items = el('div', 'scale-category-items');
  for (const scale of scales) items.append(renderScaleItem(scale));
  section.append(items);
  return section;
}

function renderScalesList(scales) {
  dom.scalesResult.hidden = true;
  dom.scalesForm.hidden = true;
  dom.scalesList.hidden = false;
  dom.scalesList.replaceChildren();
  const categories = scaleCategories();
  const visible = visibleScales(scales, categories);
  // 私有问卷说明：没有私有表时不渲染任何标记/说明（：无私有包与现状完全一致）。
  if (visible.some(isPrivateScale)) {
    dom.scalesList.append(el('p', 'scales-private-note', SCALE_PRIVATE_NOTE));
  }
  if (!visible.length) return;
  if (categories.length === 0) {
    // 旧后端（契约）：没有分类信息时保持平铺，不让用户看到空分组。
    for (const scale of visible) dom.scalesList.append(renderScaleItem(scale));
    return;
  }
  const byCategory = new Map(categories.map((category) => [category.id, []]));
  const uncategorized = [];
  for (const scale of visible) {
    if (byCategory.has(scale.categoryId)) byCategory.get(scale.categoryId).push(scale);
    else uncategorized.push(scale);
  }
  for (const category of categories) {
    const items = byCategory.get(category.id);
    if (!items || items.length === 0) continue; // 空分类不渲染
    dom.scalesList.append(renderScaleCategory(category, items));
  }
  if (uncategorized.length > 0) {
    dom.scalesList.append(renderScaleCategory({ id: 'other', name: '其他问卷', desc: '' }, uncategorized));
  }
}

function scrollScaleFormToTop() {
  const body = dom.scalesForm.parentElement;
  if (body) body.scrollTop = 0;
}

function clearScaleStatus() {
  if (!dom.scalesStatus) return;
  dom.scalesStatus.hidden = true;
  dom.scalesStatus.textContent = '';
  delete dom.scalesStatus.dataset.state;
}

function hideScaleFormWarning() {
  const warning = dom.scalesForm.querySelector('#scaleFormWarning');
  if (!warning) return;
  warning.hidden = true;
  warning.textContent = '';
}

function showScaleWarning(text) {
  dom.scalesStatus.hidden = false;
  dom.scalesStatus.dataset.state = 'warning';
  dom.scalesStatus.textContent = text;
  // 长表单滚到中段时顶部提示看不见：同一句提示也放在表单底部的分页区。
  const warning = dom.scalesForm.hidden ? null : dom.scalesForm.querySelector('#scaleFormWarning');
  if (warning) {
    warning.textContent = text;
    warning.hidden = false;
  }
}

function focusScaleQuestion(index) {
  const fieldset = dom.scalesForm.querySelector(`.scale-question[data-index="${index}"]`);
  if (!fieldset) return;
  fieldset.scrollIntoView({ block: 'center' });
  const input = fieldset.querySelector('input');
  if (input) input.focus({ preventScroll: true });
}

/** 翻到某一页：重渲染表单、回到顶部、焦点落到本页第一题（键盘可连续作答）。 */
function showScalePage(page) {
  const scale = state.scalesCurrent;
  if (!scale) return;
  const bounds = scalePageBounds(scale, page);
  state.scalesPage = bounds.page;
  dom.scalesForm.replaceChildren(renderScaleForm(scale));
  scrollScaleFormToTop();
  updateScaleProgress();
  const firstInput = dom.scalesForm.querySelector('.scale-question input');
  if (firstInput) firstInput.focus({ preventScroll: true });
}

function openScaleForm(scaleId) {
  const scale = (state.scales?.scales || []).find((item) => item.id === scaleId);
  if (!scale) {
    toast('问卷暂不可用');
    return;
  }
  state.scalesCurrent = scale;
  state.scalesAnswers = {};
  state.scalesPage = 1;
  state.scalesSex = null;
  dom.scalesList.hidden = true;
  setScalesHistoryEntryVisible(false);
  clearScaleStatus();
  dom.scalesResult.hidden = true;
  dom.scalesResult.replaceChildren();
  dom.scalesRetry.hidden = true;
  dom.scalesForm.hidden = false;
  if (isNormScale(scale) && scale.requiresSex) {
    // 常模分按性别取表：先选口径再开始作答（选择只在内存，不写会话/记忆/本地存储）。
    dom.scalesForm.replaceChildren(renderScaleSexChoice(scale));
    scrollScaleFormToTop();
  } else {
    dom.scalesForm.replaceChildren(renderScaleForm(scale));
    scrollScaleFormToTop();
    updateScaleProgress();
  }
}

/** 常模问卷开始前的性别口径选择（不保存到任何地方）。 */
function renderScaleSexChoice(scale) {
  const frag = document.createDocumentFragment();

  const head = el('div', 'scale-form-head');
  const back = el('button', 'scale-form-back', '‹ 返回问卷列表');
  back.type = 'button';
  back.addEventListener('click', showScalesList);
  head.append(back);
  head.append(el('p', 'scale-form-title', scale.shortName || scale.name));
  head.append(el('p', 'scale-form-desc', `${scale.purpose || ''} · 共 ${scale.items} 题`));
  frag.append(head);

  const section = el('section', 'scale-sex');
  section.append(el('h3', 'scale-sex-title', '选择常模口径'));
  section.append(
    el(
      'p',
      'scale-sex-note',
      '该问卷按性别使用不同常模。性别只用于本次常模换算，不写进会话、记忆或本地存储，关闭面板即丢弃。',
    ),
  );
  const options = el('div', 'scale-sex-options');
  const buttons = [];
  for (const [value, label] of [
    ['male', '男'],
    ['female', '女'],
  ]) {
    const button = el('button', 'scale-sex-btn', label);
    button.type = 'button';
    button.dataset.sex = value;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      state.scalesSex = value;
      for (const item of buttons) {
        const active = item.dataset.sex === value;
        item.classList.toggle('is-selected', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      start.disabled = false;
      hideScaleFormWarning();
    });
    buttons.push(button);
    options.append(button);
  }
  section.append(options);
  section.append(el('p', 'scale-sex-hint', `常模分：${normTypeLabel(scale.normType)}`));
  if (scale.normNote) section.append(el('p', 'scale-norm-hint', scale.normNote));
  frag.append(section);

  const start = el('button', 'scale-submit scale-sex-start', '开始作答');
  start.type = 'button';
  start.id = 'scaleSexStart';
  start.disabled = true;
  start.addEventListener('click', () => {
    if (!state.scalesSex) return;
    dom.scalesForm.replaceChildren(renderScaleForm(scale));
    scrollScaleFormToTop();
    updateScaleProgress();
    const first = dom.scalesForm.querySelector('.scale-question input');
    if (first) first.focus();
  });
  frag.append(start);

  return frag;
}

function renderScaleForm(scale) {
  const frag = document.createDocumentFragment();
  const bounds = scalePageBounds(scale, state.scalesPage);
  const pages = bounds.pages;

  const head = el('div', 'scale-form-head');
  const back = el('button', 'scale-form-back', '‹ 返回问卷列表');
  back.type = 'button';
  back.addEventListener('click', showScalesList);
  head.append(back);
  head.append(el('p', 'scale-form-title', scale.shortName || scale.name));
  const paginationHint = pages > 1 ? ` · 分 ${pages} 页，每页 ${scalePageSize(scale)} 题` : '';
  head.append(
    el(
      'p',
      'scale-form-desc',
      `${scale.purpose || ''} · ${scale.timeframe || ''} · 共 ${scale.items} 题${paginationHint}`,
    ),
  );
  head.append(el('p', 'scale-form-note', '答案只保存在本页，返回列表或关闭面板即丢弃，不会保存。'));
  if (isNormScale(scale)) {
    const bits = [`常模：${normTypeLabel(scale.normType)}`];
    if (scale.requiresSex && state.scalesSex) bits.push(`口径：${SCALE_SEX_LABELS[state.scalesSex] || state.scalesSex}`);
    if (scale.allowOmit) bits.push('可答「无法回答」');
    if (scale.normSource) bits.push(`来源：${scale.normSource}`);
    head.append(el('p', 'scale-form-norm', bits.join(' · ')));
  }
  frag.append(head);

  const questions = el('div', 'scale-questions');
  for (let index = bounds.start; index <= bounds.end; index += 1) {
    const fieldset = el('fieldset', 'scale-question');
    fieldset.dataset.index = String(index);
    const legend = el('legend', 'scale-legend');
    legend.append(el('span', 'scale-number', `${index}`));
    legend.append(el('span', 'scale-text', scale.itemsText[index - 1] || ''));
    fieldset.append(legend);
    const options = el('div', 'scale-options');
    const answered = state.scalesAnswers?.[String(index)];
    for (const option of scale.options || []) {
      const label = el('label', 'scale-option');
      const input = document.createElement('input');
      const omit = option.value === null;
      input.type = 'radio';
      input.id = `scale-q-${index}-o${omit ? 'omit' : option.value}`;
      input.name = `scale-q-${index}`;
      input.value = omit ? '' : String(option.value);
      input.checked =
        answered !== undefined &&
        (omit ? answered === null : Number(answered) === Number(option.value));
      if (omit) label.classList.add('scale-option-omit');
      input.addEventListener('change', () => {
        if (!state.scalesAnswers) return;
        state.scalesAnswers[String(index)] = omit ? null : Number(option.value);
        hideScaleFormWarning();
        updateScaleProgress();
      });
      label.append(input, el('span', 'scale-option-label', option.label || String(option.value)));
      options.append(label);
    }
    fieldset.append(options);
    questions.append(fieldset);
  }
  frag.append(questions);

  const foot = el('div', 'scale-form-foot');
  if (pages > 1) foot.classList.add('is-sticky');
  const progress = el('p', 'scale-progress', '');
  progress.id = 'scaleProgress';
  progress.setAttribute('aria-live', 'polite');
  const warning = el('p', 'scale-form-warning', '');
  warning.id = 'scaleFormWarning';
  warning.setAttribute('role', 'alert');
  warning.hidden = true;
  foot.append(progress, warning);

  const pager = el('div', 'scale-pager');
  if (pages > 1) {
    const prev = el('button', 'scale-pager-btn scale-prev', '‹ 上一页');
    prev.type = 'button';
    prev.disabled = bounds.page <= 1;
    prev.addEventListener('click', () => goScalePage(-1));
    pager.append(prev);
  }
  if (pages > 1 && bounds.page < pages) {
    const next = el('button', 'scale-pager-btn scale-next', '下一页 ›');
    next.type = 'button';
    next.addEventListener('click', () => goScalePage(1));
    pager.append(next);
  } else {
    const submit = el('button', 'scale-submit', '提交并查看结果');
    submit.type = 'button';
    submit.id = 'scaleSubmit';
    submit.addEventListener('click', submitScaleAnswers);
    pager.append(submit);
  }
  foot.append(pager);
  frag.append(foot);

  return frag;
}

/** 分页校验：下一页要求当前页答完；上一页不校验（答案已在内存）。 */
function goScalePage(direction) {
  const scale = state.scalesCurrent;
  if (!scale) return;
  const bounds = scalePageBounds(scale, state.scalesPage);
  if (direction > 0 && !scale.allowOmit) {
    const missing = scalePageMissing(scale, bounds.page);
    if (missing.length > 0) {
      showScaleWarning(`第 ${bounds.page} 页还有 ${missing.length} 题未作答`);
      focusScaleQuestion(missing[0]);
      return;
    }
  }
  const target = Math.min(Math.max(1, bounds.page + direction), bounds.pages);
  if (target === bounds.page) return;
  showScalePage(target);
}

function scalePageMissing(scale, page) {
  const bounds = scalePageBounds(scale, page);
  const missing = [];
  for (let index = bounds.start; index <= bounds.end; index += 1) {
    if (state.scalesAnswers?.[String(index)] === undefined) missing.push(index);
  }
  return missing;
}

function scaleAnsweredCount() {
  return Object.keys(state.scalesAnswers || {}).length;
}

function updateScaleProgress() {
  const scale = state.scalesCurrent;
  if (!scale) return;
  const progress = dom.scalesForm.querySelector('#scaleProgress');
  if (!progress) return;
  const bounds = scalePageBounds(scale, state.scalesPage);
  let answered = scaleAnsweredCount();
  let text = bounds.pages > 1
    ? `第 ${bounds.page}/${bounds.pages} 页 · 已答 ${answered}/${scale.items} 题`
    : `已答 ${answered} / ${scale.items} 题`;
  if (scale.allowOmit) {
    // allowOmit：null 是「无法回答」（计入已答），未点的题不计入；进度单独列无法回答数。
    const omitted = Object.values(state.scalesAnswers || {}).filter((value) => value === null).length;
    answered -= omitted;
    text = bounds.pages > 1
      ? `第 ${bounds.page}/${bounds.pages} 页 · 已答 ${answered}/${scale.items} 题 · 无法回答 ${omitted} 题`
      : `已答 ${answered} / ${scale.items} 题 · 无法回答 ${omitted} 题`;
  }
  progress.textContent = text;
  progress.dataset.state = !scale.allowOmit && answered >= scale.items ? 'ready' : 'pending';
}

async function submitScaleAnswers() {
  const scale = state.scalesCurrent;
  if (!scale || state.scalesBusy) return;
  if (scale.allowOmit) {
    const answered = scaleAnsweredCount();
    if (answered === 0) {
      showScaleWarning('至少作答 1 题再提交');
      focusScaleQuestion(scalePageBounds(scale, 1).start);
      return;
    }
  }
  const missing = [];
  if (!scale.allowOmit) {
    for (let index = 1; index <= scale.items; index += 1) {
      if (state.scalesAnswers?.[String(index)] === undefined) missing.push(index);
    }
  }
  if (missing.length > 0) {
    // 没答的题可能在别的页：先翻到第一道缺题所在页，再滚到那道题。
    const firstPage = scalePageBounds(scale, Math.ceil(missing[0] / scalePageSize(scale))).page;
    if (scalePageCount(scale) > 1 && firstPage !== scalePageBounds(scale, state.scalesPage).page) {
      state.scalesPage = firstPage;
      dom.scalesForm.replaceChildren(renderScaleForm(scale));
      scrollScaleFormToTop();
      updateScaleProgress();
    }
    showScaleWarning(`还有 ${missing.length} 题未作答`);
    focusScaleQuestion(missing[0]);
    return;
  }
  const submit = dom.scalesForm.querySelector('#scaleSubmit');
  state.scalesBusy = true;
  if (submit) {
    submit.disabled = true;
    submit.textContent = '正在计算…';
  }
  try {
    const payload = { scaleId: scale.id, answers: state.scalesAnswers };
    if (isNormScale(scale) && scale.requiresSex && state.scalesSex) payload.sex = state.scalesSex;
    const data = await state.api.scoreScale(payload);
    // 新的自评可能已写入历史（saved=true），下次打开历史时重新拉取。
    state.scalesHistory = null;
    renderScaleResult(data.result, scale);
  } catch (error) {
    dom.scalesStatus.hidden = false;
    dom.scalesStatus.dataset.state = 'error';
    if (error instanceof ApiError && error.status === 400) {
      dom.scalesStatus.textContent = '提交未成功，请检查是否有未答或异常的题目';
    } else {
      dom.scalesStatus.textContent = '问卷暂不可用，请稍后重试';
    }
  } finally {
    state.scalesBusy = false;
    if (submit) {
      submit.disabled = false;
      submit.textContent = '提交并查看结果';
    }
  }
}

function renderScaleFactors(result) {
  if (!Array.isArray(result.factors) || result.factors.length === 0) return null;
  const section = el('section', 'scale-factors');
  section.append(el('h3', 'scale-section-title', '因子分'));
  const list = el('div', 'scale-factor-list');
  for (const factor of result.factors) {
    const row = el('div', 'scale-factor');
    row.dataset.factorId = factor.id || '';
    const head = el('div', 'scale-factor-head');
    head.append(el('span', 'scale-factor-name', factor.name || factor.id || '因子'));
    head.append(el('span', 'scale-factor-score', `${factor.score} / ${factor.maxScore}`));
    row.append(head);
    const ratio = factor.maxScore > 0 ? Math.min(1, Math.max(0, factor.score / factor.maxScore)) : 0;
    const bar = el('div', 'scale-factor-bar');
    const fill = el('div', 'scale-factor-fill');
    fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.append(fill);
    row.append(bar);
    list.append(row);
  }
  section.append(list);
  section.append(el('p', 'scale-factor-note', '因子分只用于看不同维度的相对高低，不能单独作为诊断依据。'));
  return section;
}

/** 问卷来源块（v1 与 v2 结果共用）。 */
function renderScaleSources(result) {
  const sources = el('section', 'scale-sources');
  sources.append(el('h3', 'scale-section-title', '问卷来源'));
  for (const source of result.sources || []) {
    const line = el('div', 'scale-source');
    line.append(el('span', 'scale-source-name', source.name || ''));
    if (source.license) line.append(el('span', 'scale-source-license', source.license));
    const safeUrl = safeExternalUrl(source.url);
    if (safeUrl) {
      const link = el('a', 'scale-source-link', '原文 ↗');
      link.href = safeUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      line.append(link);
    }
    sources.append(line);
  }
  return sources;
}

/** 求助热线块（v1 与 v2 结果共用）。 */
function renderScaleHelp() {
  const help = el('section', 'scale-help');
  help.append(el('h3', 'scale-section-title', '如果现在就需要人陪'));
  const list = el('ul', 'scale-help-list');
  for (const item of SCALE_HELP_RESOURCES) {
    const li = el('li');
    const link = el('a', 'scale-help-link', item.label);
    link.href = `tel:${item.tel}`;
    li.append(link);
    list.append(li);
  }
  help.append(list);
  help.append(el('p', 'scale-help-note', '把这份感觉告诉一个信任的人，也很有用。'));
  return help;
}

/** 结果页底部动作（再测一次 / 返回列表，v1 与 v2 共用）。 */
function renderScaleActions(scale) {
  const actions = el('div', 'scale-result-actions');
  const retest = el('button', 'scale-result-btn', '再测一次');
  retest.type = 'button';
  retest.addEventListener('click', () => openScaleForm(scale.id));
  const back = el('button', 'scale-result-btn scale-result-back', '返回问卷列表');
  back.type = 'button';
  back.addEventListener('click', showScalesList);
  actions.append(retest, back);
  return actions;
}

/** 是否为 v2 常模结果（按 scale.kind 或结果字段判定，兼容旧后端返回的 v1 结果）。 */
function isNormResult(result, scale) {
  if (isNormScale(scale)) return true;
  return Boolean(
    result &&
      result.normType !== undefined &&
      Array.isArray(result.factors) &&
      result.factors.some((factor) => factor && factor.normScore !== undefined),
  );
}

/** 常模因子分表格（因子名 / 原始分 / 常模分；extras 复用同一表格结构）。 */
function renderNormFactorTable(items, normType, className) {
  const table = el('table', `scale-norm-table ${className || ''}`.trim());
  const head = el('tr');
  head.append(el('th', 'scale-norm-name', '因子'));
  head.append(el('th', 'scale-norm-raw', '原始分'));
  head.append(el('th', 'scale-norm-score', normTypeLabel(normType)));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const factor of items) {
    const row = el('tr', 'scale-norm-row');
    row.dataset.factorId = factor.id || '';
    row.append(el('td', 'scale-norm-name', factor.name || factor.id || '因子'));
    row.append(el('td', 'scale-norm-raw', String(factor.rawScore ?? '')));
    const missing = factor.normScore === null || factor.normScore === undefined;
    const scoreCell = el('td', 'scale-norm-score', missing ? '—' : String(factor.normScore));
    if (missing) scoreCell.classList.add('is-missing');
    row.append(scoreCell);
    tbody.append(row);
  }
  table.append(thead, tbody);
  return table;
}

/** v2 常模问卷结果页：常模来源/口径 → 因子常模分表 → extras → 免责声明 → 来源/热线/动作。 */
function renderNormScaleResult(result, scale) {
  const frag = document.createDocumentFragment();

  if (result.safetyAdvisory) {
    const safety = el('section', 'scale-safety');
    safety.setAttribute('role', 'alert');
    safety.append(el('h3', 'scale-safety-title', '先照顾好此刻的自己'));
    safety.append(el('p', 'scale-safety-text', result.safetyAdvisory));
    frag.append(safety);
  }

  const head = el('section', 'scale-norm-head');
  const meta = el('div', 'scale-norm-meta');
  const addRow = (label, value, className) => {
    const row = el('div', `scale-norm-row ${className || ''}`.trim());
    row.append(el('span', 'scale-norm-key', label));
    row.append(el('span', 'scale-norm-val', value));
    meta.append(row);
  };
  addRow('常模来源', result.normSource || scale.normSource || '—', 'scale-norm-source');
  if (result.normNote || scale.normNote) {
    addRow('常模说明', result.normNote || scale.normNote, 'scale-norm-note');
  }
  const sexLabel = result.sex ? SCALE_SEX_LABELS[result.sex] || result.sex : '';
  addRow('常模口径', `${normTypeLabel(result.normType || scale.normType)}${sexLabel ? ` · ${sexLabel}` : ''}`);
  if (result.omitCount > 0) {
    addRow('无法回答', `${result.omitCount} 题（不计入因子分）`, 'scale-omit-note');
  }
  head.append(meta);
  frag.append(head);

  const factors = Array.isArray(result.factors) ? result.factors : [];
  if (factors.length > 0) {
    const section = el('section', 'scale-norm-factors');
    section.append(el('h3', 'scale-section-title', '常模分'));
    section.append(renderNormFactorTable(factors, result.normType || scale.normType, 'scale-norm-factors-table'));
    section.append(
      el('p', 'scale-factor-note', '原始分按本问卷常模换算；常模分只用于看相对位置，不能单独作为诊断依据。'),
    );
    frag.append(section);
  }

  const extras = Array.isArray(result.extras) ? result.extras : [];
  if (extras.length > 0) {
    const section = el('section', 'scale-norm-extras');
    section.append(el('h3', 'scale-section-title', '附加指标'));
    section.append(renderNormFactorTable(extras, result.normType || scale.normType, 'scale-norm-extras-table'));
    frag.append(section);
  }

  if ([...factors, ...extras].some((item) => item && (item.normScore === null || item.normScore === undefined))) {
    frag.append(el('p', 'scale-norm-missing-note', '部分分数缺常模，仅展示原始分。'));
  }
  frag.append(el('p', 'scale-result-disclaimer', SCALE_NORM_DISCLAIMER));
  frag.append(renderScaleSources(result));
  frag.append(renderScaleHelp());
  frag.append(renderScaleActions(scale));
  return frag;
}

function renderScaleResult(result, scale) {
  if (!result) return;
  setScalesHistoryEntryVisible(false);
  dom.scalesForm.hidden = true;
  clearScaleStatus();
  dom.scalesResult.hidden = false;

  // v2 常模问卷：结果页是「因子常模分表」，与 v1 的总分/档位完全不同的版式。
  if (isNormResult(result, scale)) {
    dom.scalesResult.replaceChildren(renderNormScaleResult(result, scale));
    dom.scalesResult.parentElement.scrollTop = 0;
    dom.scalesResult.scrollIntoView({ block: 'start' });
    return;
  }

  const frag = document.createDocumentFragment();

  // 安全提示放在结果最上方；文案不吓人，给具体行动与热线。
  if (result.safetyAdvisory) {
    const safety = el('section', 'scale-safety');
    safety.setAttribute('role', 'alert');
    safety.append(el('h3', 'scale-safety-title', '先照顾好此刻的自己'));
    safety.append(el('p', 'scale-safety-text', result.safetyAdvisory));
    frag.append(safety);
  }

  const scoreBox = el('div', 'scale-score');
  scoreBox.append(el('span', 'scale-score-number', String(result.score)));
  scoreBox.append(el('span', 'scale-score-max', `/ ${result.maxScore}`));
  frag.append(scoreBox);
  // kind='factor' 时 band 为 null：只渲染总分与因子分，不渲染空档位。
  if (result.band) {
    frag.append(el('p', 'scale-band', result.band.label || ''));
    if (result.band.note) frag.append(el('p', 'scale-note', result.band.note));
  }
  const factors = renderScaleFactors(result);
  if (factors) frag.append(factors);
  frag.append(
    el(
      'p',
      'scale-result-disclaimer',
      '筛查结果不是诊断：分数只提示近一段时间的状态，不能说明你「是什么样的人」，也不能替代医生或专业人士的专业评估。',
    ),
  );

  frag.append(renderScaleSources(result));
  frag.append(renderScaleHelp());
  frag.append(renderScaleActions(scale));

  dom.scalesResult.replaceChildren(frag);
  dom.scalesResult.parentElement.scrollTop = 0;
  dom.scalesResult.scrollIntoView({ block: 'start' });
}

function showScalesList() {
  state.scalesCurrent = null;
  state.scalesAnswers = null;
  state.scalesPage = 1;
  state.scalesSex = null;
  dom.scalesForm.replaceChildren();
  dom.scalesForm.hidden = true;
  dom.scalesResult.replaceChildren();
  dom.scalesResult.hidden = true;
  hideScalesHistory();
  setScalesHistoryEntryVisible(true);
  clearScaleStatus();
  dom.scalesRetry.hidden = true;
  if (state.scales?.scales?.length) renderScalesList(state.scales.scales);
  else loadScales();
}

/* ==========================================================================
   事件绑定
   ========================================================================== */

function hasDraggedFiles(event) {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes('Files') : true;
}

function bindEvents() {
  // 只有用户主动滚动才更新「跟随最新」意图；触摸/滚轮/指针/滚动按键都算。
  for (const type of ['touchstart', 'touchmove', 'wheel', 'pointerdown']) {
    dom.screen.addEventListener(type, markUserScrollIntent, { passive: true });
  }
  document.addEventListener('keydown', markScrollKeyIntent, { passive: true });
  dom.screen.addEventListener('scroll', handleScreenScroll, { passive: true });
  dom.jump.addEventListener('click', jumpToLatest);

  dom.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage(dom.input.value);
  });

  // —— 附件草稿区：按钮 → 隐藏 file input；粘贴图片；桌面拖拽 ——
  dom.attachBtn.addEventListener('click', () => {
    if (state.streaming) {
      toast('等这轮回答结束再添加附件。');
      return;
    }
    dom.attachInput.click();
  });
  dom.attachInput.addEventListener('change', () => {
    addDraftFiles('chat', dom.attachInput.files);
    dom.attachInput.value = '';
  });
  dom.composerBar.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files || []).filter((file) =>
      String(file.type || '').startsWith('image/'),
    );
    if (files.length === 0) return;
    event.preventDefault();
    addDraftFiles('chat', files);
  });
  let dragDepth = 0;
  const setDragOver = (active) => dom.composerBar.classList.toggle('is-dragover', active);
  dom.composerBar.addEventListener('dragenter', (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragOver(true);
  });
  dom.composerBar.addEventListener('dragover', (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  dom.composerBar.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragOver(false);
  });
  dom.composerBar.addEventListener('drop', (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragOver(false);
    addDraftFiles('chat', event.dataTransfer.files);
  });

  // 记忆面板附件（≤1 个）
  dom.memoryAttachBtn.addEventListener('click', () => {
    if (state.v3 === false) return;
    dom.memoryAttachInput.click();
  });
  dom.memoryAttachInput.addEventListener('change', () => {
    addDraftFiles('memory', dom.memoryAttachInput.files);
    dom.memoryAttachInput.value = '';
  });

  // 不把焦点交给发送按钮：iOS 上点按钮会 blur textarea，键盘收起再弹起会跳。
  dom.send.addEventListener('pointerdown', (event) => {
    event.preventDefault();
  });

  dom.input.addEventListener('input', () => {
    autoGrowInput();
    updateCharCount();
    updateSendState();
  });

  dom.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return; // 输入法组词中
    event.preventDefault();
    sendMessage(dom.input.value);
  });

  dom.effortChip.addEventListener('click', () => toggleEffortSheet());
  for (const button of dom.effortOptions) {
    button.addEventListener('click', () => {
      setEffort(button.dataset.effort);
      openEffortSheet(false);
      dom.effortChip.focus({ preventScroll: true });
    });
  }

  dom.drawerToggle.addEventListener('click', () => {
    if (dom.drawer.hidden) openDrawer();
    else closeDrawer();
  });
  dom.drawerClose.addEventListener('click', closeDrawer);
  dom.drawerScrim.addEventListener('click', closeDrawer);
  dom.newChatBtn.addEventListener('click', startNewChat);
  dom.memoryEntry.addEventListener('click', openMemoryPanel);
  dom.libraryEntry.addEventListener('click', openLibraryPanel);
  dom.marksEntry.addEventListener('click', openMarksPanel);
  dom.marksBack.addEventListener('click', closeMarksPanel);
  dom.marksClose.addEventListener('click', closeMarksPanel);
  dom.marksRetry.addEventListener('click', loadMarks);
  dom.scalesEntry.addEventListener('click', openScalesPanel);
  dom.scalesBack.addEventListener('click', closeScalesPanel);
  dom.scalesClose.addEventListener('click', closeScalesPanel);
  dom.scalesRetry.addEventListener('click', loadScales);
  dom.scalesHistoryEntry.addEventListener('click', openScalesHistory);
  dom.scalesHistoryBack.addEventListener('click', closeScalesHistory);
  dom.scalesHistoryRetry.addEventListener('click', loadScalesHistory);
  dom.scalesHistoryClear.addEventListener('click', requestClearScalesHistory);
  dom.scalesHistoryConfirmCancel.addEventListener('click', cancelClearScalesHistory);
  dom.scalesHistoryConfirmClear.addEventListener('click', confirmClearScalesHistory);
  dom.scalesHistoryChips.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const chips = [...dom.scalesHistoryChips.querySelectorAll('.scale-history-chip')];
    const index = chips.indexOf(document.activeElement);
    if (index < 0 || chips.length === 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = chips[(index + step + chips.length) % chips.length];
    next.focus({ preventScroll: true });
    next.click();
  });
  dom.imageViewerScrim.addEventListener('click', closeImageViewer);
  dom.imageViewerClose.addEventListener('click', closeImageViewer);
  window.addEventListener('resize', scheduleScaleChartRedraw, { passive: true });
  dom.healthEntry.addEventListener('click', openHealthPanel);
  dom.healthBack.addEventListener('click', closeHealthPanel);
  dom.healthClose.addEventListener('click', closeHealthPanel);
  dom.healthRetry.addEventListener('click', loadHealth);
  dom.healthClear.addEventListener('click', clearHealthData);
  // 多用户入口（按钮默认 hidden，AUTH=on 登录后才可用）。
  if (dom.accountEntry) dom.accountEntry.addEventListener('click', () => goToPage('/account.html'));
  if (dom.feedbackEntry) dom.feedbackEntry.addEventListener('click', () => goToPage('/feedback.html'));
  if (dom.adminEntry) dom.adminEntry.addEventListener('click', () => goToPage('/admin.html'));
  dom.favoriteBtn.addEventListener('click', toggleFavorite);
  dom.excerptBtn.addEventListener('click', saveExcerpt);
  dom.libraryBack.addEventListener('click', closeLibraryPanel);
  dom.libraryClose.addEventListener('click', closeLibraryPanel);
  dom.libraryRetry.addEventListener('click', loadLibrary);
  dom.memoryChip.addEventListener('click', openMemoryPanel);
  dom.webSearchChip.addEventListener('click', toggleWebSearch);
  dom.memoryBack.addEventListener('click', closeMemoryPanel);
  dom.memoryClear.addEventListener('click', clearMemories);
  dom.memoryToggle.addEventListener('change', () => {
    setMemory(dom.memoryToggle.checked ? 'on' : 'off');
  });
  dom.memoryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addMemory(dom.memoryInput.value);
  });

  dom.readerClose.addEventListener('click', closeReader);

  // 离线提示条（online/offline 事件驱动；不阻塞输入）。
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);
  updateOfflineBanner();

  // 回页时恢复后台生成的结果（visibilitychange/pageshow/focus 幂等触发）。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resumeBackgroundGeneration();
    } else {
      pauseBackgroundClock();
    }
  });
  window.addEventListener('pageshow', () => resumeBackgroundGeneration());
  window.addEventListener('focus', () => resumeBackgroundGeneration());
  window.addEventListener('pagehide', () => {
    // 一旦离页，后续流中断按「后台继续生成」处理（发送/成功收尾后会重置）。
    state.pageHidden = true;
  });
  window.addEventListener('online', () => {
    if (!state.backgroundPending) return;
    resumeBackgroundClock();
    scheduleBackgroundPoll(0);
  });
  window.addEventListener('offline', () => pauseBackgroundClock());

  document.addEventListener('click', (event) => {
    if (dom.effortSheet.hidden) return;
    const target = event.target;
    if (
      target instanceof Node &&
      !dom.effortSheet.contains(target) &&
      !dom.effortChip.contains(target)
    ) {
      openEffortSheet(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    // 同意弹层是必答门禁，Esc 不关闭（只能同意或暂不同意退出）。
    if (dom.consentModal && !dom.consentModal.hidden) {
      if (event.key === 'Escape') event.preventDefault();
      return;
    }
    if (event.key !== 'Escape') return;
    if (!dom.imageViewer.hidden) {
      event.preventDefault();
      closeImageViewer();
    } else if (!dom.reader.hidden) {
      event.preventDefault();
      closeReader();
    } else if (!dom.marksPanel.hidden) {
      event.preventDefault();
      closeMarksPanel();
    } else if (!dom.scalesPanel.hidden) {
      event.preventDefault();
      if (!dom.scalesHistory.hidden) closeScalesHistory();
      else closeScalesPanel();
    } else if (!dom.healthPanel.hidden) {
      event.preventDefault();
      closeHealthPanel();
    } else if (!dom.libraryPanel.hidden) {
      event.preventDefault();
      closeLibraryPanel();
    } else if (!dom.memoryPanel.hidden) {
      event.preventDefault();
      closeMemoryPanel();
    } else if (!dom.drawer.hidden) {
      event.preventDefault();
      closeDrawer();
    } else if (!dom.effortSheet.hidden) {
      event.preventDefault();
      openEffortSheet(false);
      dom.effortChip.focus({ preventScroll: true });
    }
  });

  keepFocusIn(dom.reader);
  keepFocusIn(dom.drawer);
  keepFocusIn(dom.consentModal);
  keepFocusIn(dom.memoryPanel);
  keepFocusIn(dom.libraryPanel);
  keepFocusIn(dom.marksPanel);
  keepFocusIn(dom.scalesPanel);
  keepFocusIn(dom.healthPanel);
  keepFocusIn(dom.imageViewer);
}

/** 焦点圈：浮层打开时 Tab 不跑到背景层。 */
function keepFocusIn(container) {
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || container.hidden) return;
    const focusables = [
      ...container.querySelectorAll('button, a[href], input, textarea, [tabindex]:not([tabindex="-1"])'),
    ].filter((node) => !node.disabled && node.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

/* ==========================================================================
   启动
   ========================================================================== */

function setupComposerHeight() {
  const update = () => {
    const height = dom.composerBar.offsetHeight;
    if (height > 0) document.documentElement.style.setProperty('--composer-h', `${height}px`);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(dom.composerBar);
  window.addEventListener('resize', update, { passive: true });
  update();
}

/**
 * iOS 26.1 standalone 回归兜底：已添加到主屏幕时 env(safe-area-inset-top) 可能解析为 0，
 * 头部会被状态栏盖住。这里只加类名（CSS 中给头部 px 兜底），浏览器标签页模式不受影响。
 */
function setupSafeAreaFallback() {
  const root = document.documentElement;
  const standaloneQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;

  const update = () => {
    const standalone = Boolean(
      (standaloneQuery && standaloneQuery.matches) || window.navigator.standalone === true,
    );
    const safe = readSafeArea(document);
    root.classList.toggle('is-standalone', standalone);
    root.classList.toggle(
      'safe-top-zero',
      needsSafeTopFallback({ standalone, safeTop: safe.safeTop }),
    );
  };

  update();
  window.addEventListener('pageshow', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  window.addEventListener('orientationchange', update, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', update, { passive: true });
  }
}

/**
 * 键盘/视口 resize 的意图保护：resize 开始前记住 wasPinned，
 * resize 期间（含布局重排引发的 scroll 事件）不改变 pin 意图，
 * resize 结束后 rAF×2 重新贴底（wasPinned）或只刷新按钮，避免误报「新内容」。
 */
function setupViewport() {
  const diag = isDiagMode(window);
  const captureResizeIntent = () => {
    if (performance.now() >= resizeGuardUntil) wasPinnedBeforeResize = pinnedToBottom;
    resizeGuardUntil = performance.now() + RESIZE_INTENT_GUARD_MS;
  };
  window.addEventListener('resize', captureResizeIntent, { passive: true });
  window.addEventListener('orientationchange', captureResizeIntent, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', captureResizeIntent, { passive: true });
    window.visualViewport.addEventListener('scroll', captureResizeIntent, { passive: true });
  }
  initViewport({
    debug: diag,
    onResize: () => {
      resizeGuardUntil = Math.max(resizeGuardUntil, performance.now() + RESIZE_INTENT_GUARD_MS);
      const wasPinned = wasPinnedBeforeResize;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (wasPinned) {
            pinnedToBottom = true;
            unreadCount = 0;
            scrollToBottom();
          }
          updateJumpButton();
        });
      });
    },
  });
  if (diag) initViewportDiag();
  setupSafeAreaFallback();
}

/* ==========================================================================
   登录态（多用户）
   - AUTH=off / 旧后端 404 / 网络错误：静默保持单用户行为（入口不显示、不跳转）。
   - AUTH=on 且未登录（401）：跳登录页并带上当前路径。
   ========================================================================== */

/** 站内跳转（抽屉入口用；整页导航，页面模块各自初始化）。 */
function goToPage(path) {
  window.location.assign(path);
}

/** 按登录态开关抽屉入口；仅 auth:'on' 且拿到 user 时显示。 */
function applyAuthUi() {
  const auth = state.auth && typeof state.auth === 'object' ? state.auth : {};
  const user = auth.user && typeof auth.user === 'object' ? auth.user : null;
  if (auth.mode !== 'on' || !user) return;
  const displayName = typeof user.displayName === 'string' ? user.displayName.trim() : '';
  const username = typeof user.username === 'string' ? user.username : '';
  if (dom.accountEntry) dom.accountEntry.hidden = false;
  if (dom.feedbackEntry) dom.feedbackEntry.hidden = false;
  if (dom.adminEntry) dom.adminEntry.hidden = user.role !== 'admin';
  if (dom.accountName) {
    dom.accountName.textContent = displayName || username || '已登录';
    if (username) dom.accountName.title = `@${username}`;
  }
}

/**
 * 启动时探测登录态；必须在 detectV3() 之前调用（否则 AUTH=on 未登录会先发无意义请求）。
 * @returns {Promise<boolean>} false=已跳转登录页，boot 应立即停止。
 */
async function initAuth() {
  if (!state.api) return true;
  try {
    const payload = await state.api.getAuthMe();
    const mode = payload?.auth === 'on' ? 'on' : 'off';
    state.auth = { mode, user: mode === 'on' && payload?.user ? payload.user : null };
    applyAuthUi();
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // 只有 AUTH=on 的后端才会对 /api/auth/me 回 401；AUTH=off 恒 200。
      if (!window.location.pathname.startsWith('/login')) {
        window.location.replace(loginUrlFor(window.location));
      }
      return false;
    }
    // 旧后端（404）/ 服务不可达：保持旧单用户行为，不打扰用户。
    state.auth = { mode: 'off', user: null };
    const accountEntry = dom.accountEntry;
    if (accountEntry) accountEntry.hidden = true;
    return true;
  }
}

/* ==========================================================================
   离线提示条 + 首登同意门禁
   - 离线条：navigator.onLine + online/offline 事件，只提示、不阻塞输入；
   - 同意：AUTH=on 且 user.consent 缺失或 current=false 时弹层必答；
     同意 → POST /api/me/consent {version}；暂不同意 → 退出登录回登录页。
   ========================================================================== */

const CONSENT_VERSION = '2026-11-01';

function updateOfflineBanner() {
  if (!dom.offlineBanner) return;
  dom.offlineBanner.hidden = navigator.onLine !== false;
}

function consentPending() {
  const auth = state.auth && typeof state.auth === 'object' ? state.auth : {};
  const user = auth.user && typeof auth.user === 'object' ? auth.user : null;
  if (auth.mode !== 'on' || !user) return false;
  const consent = user.consent;
  return !consent || consent.current !== true;
}

function setConsentError(message) {
  if (!dom.consentError) return;
  dom.consentError.textContent = message || '';
  dom.consentError.hidden = !message;
}

function hideConsentModal() {
  if (!dom.consentModal) return;
  dom.consentModal.hidden = true;
  document.body.classList.remove('is-consent-open');
}

/**
 * 弹层等待用户决策（关闭/tab 前必答）：
 * @returns {Promise<boolean>} true=已同意可继续 boot；false=已退出登录/即将跳转。
 */
function waitForConsent() {
  if (!dom.consentModal) return Promise.resolve(true);
  return new Promise((resolve) => {
    const lock = (busy) => {
      if (dom.consentAgree) dom.consentAgree.disabled = busy;
      if (dom.consentDecline) dom.consentDecline.disabled = busy;
    };
    const cleanup = () => {
      if (dom.consentAgree) dom.consentAgree.removeEventListener('click', onAgree);
      if (dom.consentDecline) dom.consentDecline.removeEventListener('click', onDecline);
    };
    async function onAgree() {
      setConsentError('');
      lock(true);
      try {
        await state.api.request('/api/me/consent', {
          method: 'POST',
          body: { version: CONSENT_VERSION },
        });
        const user = state.auth?.user;
        if (user) {
          user.consent = { version: CONSENT_VERSION, at: new Date().toISOString(), current: true };
        }
        hideConsentModal();
        cleanup();
        resolve(true);
      } catch (error) {
        lock(false);
        setConsentError(humanizeError(error) || '确认失败，请稍后重试。');
      }
    }
    async function onDecline() {
      lock(true);
      try {
        await state.api.logout();
      } catch {
        /* 已过期也继续退出 */
      }
      cleanup();
      window.location.replace('/login.html');
      resolve(false);
    }
    setConsentError('');
    dom.consentModal.hidden = false;
    document.body.classList.add('is-consent-open');
    lock(false);
    if (dom.consentAgree) dom.consentAgree.addEventListener('click', onAgree);
    if (dom.consentDecline) dom.consentDecline.addEventListener('click', onDecline);
    if (dom.consentAgree) dom.consentAgree.focus({ preventScroll: true });
  });
}

async function boot() {
  state.api = createApi({ fetchImpl: (...args) => window.fetch(...args) });
  state.effort = loadEffort(getStorage());
  setEffort(state.effort, { persist: false });
  setMemory(readKey(STORAGE.memory) === 'off' ? 'off' : 'on', { persist: false });
  updateStatusChips();

  const params = new URLSearchParams(window.location.search);
  state.demo = params.get('demo') === '1';

  // 先确认登录态（AUTH=off 时静默继续）；401 会跳登录页并终止启动。
  const authReady = await initAuth();
  if (!authReady) return;

  // 首登同意门禁（AUTH=off / 旧后端 / 无 user 时直接跳过，旧行为不变）。
  if (consentPending()) {
    const consented = await waitForConsent();
    if (!consented) return;
  }

  const v3 = await detectV3();
  state.v3 = v3;
  dom.app.dataset.v3 = String(v3);

  // 联网开关按设备恢复；health.webSearch 决定 chip 显隐（旧后端/缺失 → 隐藏）。
  setWebSearch(readKey(STORAGE.webSearch) === 'on' ? 'on' : 'off', { persist: false });
  await loadWebSearchCapability();

  if (state.demo) {
    // 截图/测试模式：从空会话开始，自动发一条固定消息（DATA-CONTRACT 5）。
    // 只强制本次发送用 high，不覆盖用户已保存的 effort 偏好。
    setEffort('high', { persist: false });
    clearScreen();
    showEmpty();
    updateConversationTitle('新对话');
    updateStatusChips();
    window.setTimeout(() => sendMessage(DEMO_MESSAGE), 320);
    state.booted = true;
    return;
  }

  if (state.v3 !== false) {
    await refreshConversations();
    const stored = readKey(STORAGE.conversationId);
    if (stored && state.conversations.some((conversation) => conversation.id === stored)) {
      try {
        const detail = await state.api.getConversation(stored);
        state.conversationId = stored;
        updateConversationTitle(conversationTitle(detail.conversation));
        updateStatusChips();
        if (detail.messages.length > 0) {
          hideEmpty();
          for (const message of detail.messages) appendHistoryMessage(message);
          resetFollow();
        } else {
          showEmpty();
        }
        await refreshConversations();
        state.booted = true;
        return;
      } catch (error) {
        if (isUnsupported(error)) {
          degradeToV1('后端未启用会话历史，已降级为本地会话。');
        } else {
          toast(`会话恢复失败：${humanizeError(error)}`);
        }
      }
    }
    saveConversationId(null);
    clearScreen();
    showEmpty();
    updateStatusChips();
    await refreshConversations();
    state.booted = true;
    return;
  }

  // v1 降级：沿用旧的 sessionId 恢复；没有就开一个空终端。
  state.sessionId = readKey(LEGACY_SESSION_KEY);
  degradeToV1('后端未启用会话历史，已降级为本地会话。');
  state.v3 = false;
  if (state.sessionId) await restoreLegacySession();
  else showEmpty();
  state.booted = true;
}

async function restoreLegacySession() {
  try {
    const response = await fetch(`/api/session/${encodeURIComponent(state.sessionId)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return;
    const data = await response.json();
    const turns = Array.isArray(data.turns) ? data.turns : [];
    if (turns.length === 0) return;
    hideEmpty();
    for (const turn of turns) {
      if (turn.role === 'user') {
        appendHistoryMessage({ role: 'user', text: String(turn.content || ''), createdAt: turn.ts });
      } else if (turn.role === 'assistant') {
        appendHistoryMessage({ role: 'assistant', text: String(turn.content || ''), createdAt: turn.ts });
      }
    }
    resetFollow();
  } catch {
    /* 没有历史就从空终端开始 */
  }
}

async function init() {
  bindEvents();
  updateOfflineBanner();
  setupViewport();
  setupComposerHeight();
  autoGrowInput();
  updateCharCount();
  updateSendState();
  setRunState('idle');
  updateTitleFallback();
  try {
    await boot();
    // 启动完成后恢复上一轮的后台生成（demo 截图模式/降级模式不参与）。
    if (state.booted && !state.demo && state.v3 !== false) resumeBackgroundGeneration();
  } catch (error) {
    // 启动失败也不能白屏：至少保留终端界面与错误提示。
    state.v3 = false;
    degradeToV1(`启动失败：${humanizeError(error)}`);
    showEmpty();
  }
}

function updateTitleFallback() {
  if (!dom.convTitle.textContent.trim()) updateConversationTitle('新对话');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
