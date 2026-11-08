// Chat Terminal 管理后台脚本
// 约束：零依赖、无内联脚本（CSP）、所有服务端文本一律 textContent 渲染（不拼 HTML）。
//
// 后端契约见 docs/briefs/m44-interface-contract.md 4/8：
//   GET  /api/auth/me                      会话与 CSRF 令牌
//   GET  /api/admin/overview?days=30       概览（today/series 含官方口径与联网次数）
//   GET  /api/admin/users?query=&status=&limit=&offset=  用户列表（含 total 分页）
//   PATCH /api/admin/users/:id             状态 / 配额
//   POST /api/admin/users/:id/reset-password
//   GET  /api/admin/feedback?status=       反馈列表
//   PATCH /api/admin/feedback/:id          状态 / 回复
//   GET  /api/admin/invites?include=       邀请码列表
//   POST /api/admin/invites                新建邀请码
//   PATCH /api/admin/invites/:code         禁用 / 备注 / 有效期
//   DELETE /api/admin/invites/:code        禁用邀请码
//   GET  /api/admin/audit?limit=&cursor=   审计日志（游标分页）
//   GET  /api/admin/system                 系统状态（只读）
//   POST /api/admin/maintenance/sweep-attachments  清理过期附件
//   GET  /api/admin/settings               服务设置
//   PATCH /api/admin/settings              默认配额 / BYOK 总开关

const CSRF_COOKIE = 'csrf';
const CSRF_HEADER = 'x-csrf-token';
const LOGIN_PATH = '/login.html';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN');

const state = {
  me: null,
  csrf: '',
  overview: null,
  users: [],
  usersTotal: 0,
  usersLimit: 20,
  usersOffset: 0,
  feedback: [],
  settings: null,
  invites: [],
  inviteInclude: 'active',
  inviteEditorCode: '',
  audit: [],
  auditNextCursor: null,
  auditCursors: [null],
  auditPage: 0,
  system: null,
  pendingConfirm: null,
  editingQuotaId: '',
};

let noticeTimer = 0;
let resizeTimer = 0;
let searchTimer = 0;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function svgNode(tag, attributes, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function readCookie(name) {
  const prefix = name + '=';
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return '';
}

function displayNameOf(user) {
  if (!user) return '该用户';
  return user.displayName || user.username || '该用户';
}

function formatInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return NUMBER_FORMATTER.format(Math.round(number));
}

function formatCompact(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) {
    return (number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1) + 'M';
  }
  if (number >= 10_000) return Math.round(number / 1000) + 'K';
  if (number >= 1000) return (number / 1000).toFixed(1) + 'K';
  return String(Math.round(number));
}

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number >= 100) return '$' + number.toFixed(0);
  if (number >= 1) return '$' + number.toFixed(2);
  return '$' + number.toFixed(3);
}

function formatUsdTick(value) {
  const number = Number(value) || 0;
  if (number >= 10) return '$' + number.toFixed(0);
  return '$' + number.toFixed(2);
}

function formatPercent(rate) {
  const number = Number(rate);
  if (!Number.isFinite(number)) return '—';
  return (number * 100).toFixed(1).replace(/\.0$/, '') + '%';
}

function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = number;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const digits = scaled >= 100 || unit === 0 ? 0 : 1;
  return scaled.toFixed(digits) + ' ' + units[unit];
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return days + ' 天 ' + hours + ' 小时';
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
  return minutes + ' 分 ' + (total % 60) + ' 秒';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateTime(iso) {
  if (!iso) return '时间未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return (
    date.getFullYear() +
    '-' +
    pad2(date.getMonth() + 1) +
    '-' +
    pad2(date.getDate()) +
    ' ' +
    pad2(date.getHours()) +
    ':' +
    pad2(date.getMinutes())
  );
}

function formatDayLabel(date) {
  const text = String(date || '');
  return text.length >= 10 ? text.slice(5) : text;
}

// ---------------------------------------------------------------------------
// 提示条
// ---------------------------------------------------------------------------

function showError(message) {
  const node = $('adminError');
  node.textContent = message;
  node.hidden = false;
}

function hideError() {
  const node = $('adminError');
  node.hidden = true;
  node.textContent = '';
}

function showNotice(message) {
  const node = $('adminNotice');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    node.hidden = true;
    node.textContent = '';
  }, 7000);
}

function renderSectionError(container, title, error) {
  const message = error && error.message ? error.message : '请稍后重试。';
  container.textContent = '';
  const status = el('p', 'admin-status', title + '：' + message);
  status.setAttribute('data-state', 'error');
  container.appendChild(status);
}

// ---------------------------------------------------------------------------
// HTTP：自带轻量封装（不依赖 api.js）
//   同源 cookie、非安全方法带双提交 CSRF 头、401 统一回登录页。
// ---------------------------------------------------------------------------

class AdminHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AdminHttpError';
    this.status = status;
    this.code = code;
  }
}

function redirectToLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(LOGIN_PATH + '?next=' + next);
}

async function api(path, options) {
  const opts = options || {};
  const method = opts.method || 'GET';
  const headers = { accept: 'application/json' };
  const body = opts.body;
  if (body !== undefined) headers['content-type'] = 'application/json';

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const token = state.csrf || readCookie(CSRF_COOKIE);
    if (!token) {
      throw new AdminHttpError(403, 'FORBIDDEN', '缺少 CSRF 令牌，请刷新页面后重试。');
    }
    headers[CSRF_HEADER] = token;
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AdminHttpError(0, 'NETWORK', '网络异常，请稍后重试。');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 401) {
    redirectToLogin();
    throw new AdminHttpError(401, 'UNAUTHORIZED', '登录状态已失效，正在返回登录页。');
  }

  if (!response.ok) {
    const code = payload && payload.error && payload.error.code ? payload.error.code : 'HTTP_' + response.status;
    const message =
      payload && payload.error && payload.error.message
        ? payload.error.message
        : '请求失败（' + response.status + '），请稍后重试。';
    throw new AdminHttpError(response.status, code, message);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// 概览：统计卡 + 计数摘要 + 两条 SVG 折线图
// ---------------------------------------------------------------------------

const STAT_DEFS = [
  { key: 'requests', label: '今日请求', format: formatInt, hint: '全部用户' },
  { key: 'tokens', label: '今日 tokens', format: formatInt, hint: '含缓存读写' },
  { key: 'costUsd', label: '估算消费', format: formatUsd, hint: '估算值' },
  { key: 'cacheHitRate', label: '缓存命中率', format: formatPercent, hint: '今日' },
  { key: 'webSearchRequests', label: '联网检索', format: formatInt, hint: '今日' },
  { key: 'activeUsers', label: '活跃用户', format: formatInt, hint: '今日有请求' },
];

// 概览 series / today 可能带 bySource（official | byok 拆分）。
// 官方图表与统计只读 bySource.official，字段缺失时回落到旧总量字段。
function officialValue(row, key) {
  if (!row || typeof row !== 'object') return undefined;
  const bySource = row.bySource && typeof row.bySource === 'object' ? row.bySource : null;
  const official = bySource && bySource.official ? bySource.official : null;
  if (official && Number.isFinite(Number(official[key]))) return Number(official[key]);
  return row[key];
}

// 缓存命中率这类比例字段允许为 null（当天无输入），必须与 0 区分开：
// null 表示「没有可计算的数据」，折线跳过该点而不是画到 0。
function officialNumber(row, key) {
  const value = officialValue(row, key);
  if (value === null || value === undefined || value === '') return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function renderStats(today) {
  const container = $('statCards');
  container.textContent = '';
  for (const def of STAT_DEFS) {
    const card = el('div', 'admin-stat');
    card.setAttribute('data-stat', def.key);
    card.appendChild(el('span', 'admin-stat-label', def.label));
    const raw = today ? officialValue(today, def.key) : 0;
    const value = el('span', 'admin-stat-value', def.format(raw === undefined ? 0 : raw));
    card.appendChild(value);
    card.appendChild(el('span', 'admin-stat-hint', def.hint));
    container.appendChild(card);
  }
}

function renderSummary(payload) {
  const list = $('overviewSummary');
  list.textContent = '';
  const users = payload && payload.users ? payload.users : {};
  const feedback = payload && payload.feedback ? payload.feedback : {};
  const today = payload && payload.today ? payload.today : {};
  const webSearch = officialValue(today, 'webSearchRequests');
  const chips = [
    '用户 ' + formatInt(users.total),
    '正常 ' + formatInt(users.active),
    '已封禁 ' + formatInt(users.banned),
    '今日联网 ' + formatInt(webSearch === undefined ? 0 : webSearch) + ' 次',
    '待处理反馈 ' + formatInt(feedback.open) + ' / ' + formatInt(feedback.total),
  ];
  for (const text of chips) {
    list.appendChild(el('li', undefined, text));
  }
}

function chartGeometry(svg) {
  const rect = svg.getBoundingClientRect();
  const width = Math.max(240, Math.round(rect.width || 320));
  const height = Math.max(150, Math.round(rect.height || 190));
  return { width, height, pad: { top: 16, right: 12, bottom: 26, left: 46 } };
}

function niceCeil(value) {
  const number = Number(value) || 0;
  if (number <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(number)));
  const normalized = number / power;
  for (const candidate of [1, 2, 2.5, 5, 10]) {
    if (normalized <= candidate) return candidate * power;
  }
  return 10 * power;
}

function renderChartEmpty(svg, message, hint) {
  const geometry = chartGeometry(svg);
  svg.textContent = '';
  svg.setAttribute('viewBox', '0 0 ' + geometry.width + ' ' + geometry.height);
  svg.setAttribute('data-empty', 'true');
  const centerY = Math.round(geometry.height / 2);
  svg.appendChild(
    svgNode('line', {
      x1: geometry.pad.left,
      y1: centerY,
      x2: geometry.width - geometry.pad.right,
      y2: centerY,
      class: 'admin-chart-empty-line',
    }),
  );
  svg.appendChild(
    svgNode(
      'text',
      { x: geometry.width / 2, y: centerY - 8, 'text-anchor': 'middle', class: 'admin-chart-empty' },
      message,
    ),
  );
  svg.appendChild(
    svgNode(
      'text',
      { x: geometry.width / 2, y: centerY + 14, 'text-anchor': 'middle', class: 'admin-chart-empty' },
      hint,
    ),
  );
}

function renderLineChart(svg, series, valueOf, options) {
  const opts = options || {};
  const rows = (Array.isArray(series) ? series : []).filter(
    (row) => row && Number.isFinite(Number(valueOf(row))),
  );
  if (rows.length === 0) {
    renderChartEmpty(svg, opts.emptyText || '还没有数据', opts.emptyHint || '产生用量后会显示折线');
    return;
  }

  const geometry = chartGeometry(svg);
  const pad = geometry.pad;
  const innerWidth = geometry.width - pad.left - pad.right;
  const innerHeight = geometry.height - pad.top - pad.bottom;
  const values = rows.map((row) => Number(valueOf(row)));
  const yMax = opts.yMax ? Number(opts.yMax) : niceCeil(Math.max.apply(null, values));
  const xAt = (index) =>
    pad.left + (rows.length === 1 ? innerWidth / 2 : (innerWidth * index) / (rows.length - 1));
  const yAt = (value) => pad.top + innerHeight - (innerHeight * value) / yMax;

  svg.textContent = '';
  svg.setAttribute('viewBox', '0 0 ' + geometry.width + ' ' + geometry.height);
  svg.removeAttribute('data-empty');

  // 横向网格 + y 轴刻度
  for (let step = 0; step <= 4; step += 1) {
    const value = (yMax * step) / 4;
    const y = yAt(value);
    svg.appendChild(
      svgNode('line', {
        x1: pad.left,
        y1: y,
        x2: geometry.width - pad.right,
        y2: y,
        class: step === 0 ? 'admin-chart-axis' : 'admin-chart-grid',
      }),
    );
    svg.appendChild(
      svgNode(
        'text',
        { x: pad.left - 8, y: y + 3.5, 'text-anchor': 'end', class: 'admin-chart-tick' },
        opts.tickFormat ? opts.tickFormat(value) : formatCompact(value),
      ),
    );
  }

  // x 轴日期标签：首 / 中 / 尾
  const labelIndexes =
    rows.length <= 2
      ? rows.map((row, index) => index)
      : [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
  for (const index of labelIndexes) {
    const anchor = index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle';
    svg.appendChild(
      svgNode(
        'text',
        {
          x: xAt(index),
          y: geometry.height - 8,
          'text-anchor': anchor,
          class: 'admin-chart-tick',
        },
        formatDayLabel(rows[index].date),
      ),
    );
  }

  // 面积 + 折线（手写 polyline）
  const linePoints = rows
    .map((row, index) => xAt(index).toFixed(1) + ',' + yAt(values[index]).toFixed(1))
    .join(' ');
  const areaPath =
    'M ' + xAt(0).toFixed(1) + ' ' + yAt(values[0]).toFixed(1) +
    rows.map((row, index) => ' L ' + xAt(index).toFixed(1) + ' ' + yAt(values[index]).toFixed(1)).join('') +
    ' L ' + xAt(rows.length - 1).toFixed(1) + ' ' + (pad.top + innerHeight).toFixed(1) +
    ' L ' + xAt(0).toFixed(1) + ' ' + (pad.top + innerHeight).toFixed(1) + ' Z';

  svg.appendChild(svgNode('path', { d: areaPath, class: 'admin-chart-area' }));
  svg.appendChild(svgNode('polyline', { points: linePoints, class: 'admin-chart-line' }));
  svg.appendChild(
    svgNode('circle', {
      cx: xAt(rows.length - 1).toFixed(1),
      cy: yAt(values[values.length - 1]).toFixed(1),
      r: 4.5,
      class: 'admin-chart-dot',
    }),
  );
}

function renderCharts(series) {
  const rows = Array.isArray(series) ? series : [];
  renderLineChart($('chartTokens'), rows, (row) => officialValue(row, 'tokens'), {
    emptyText: '近 30 天还没有 tokens 记录',
    emptyHint: '有对话用量后这里会显示折线',
    tickFormat: formatCompact,
  });
  renderLineChart($('chartCost'), rows, (row) => officialValue(row, 'costUsd'), {
    emptyText: '近 30 天还没有消费记录',
    emptyHint: '有对话用量后这里会显示折线',
    tickFormat: formatUsdTick,
  });
  // 缓存命中率折线，只读官方口径；null 表示当天没有可计算数据，跳过该点。
  renderLineChart($('chartCache'), rows, (row) => officialNumber(row, 'cacheHitRate'), {
    emptyText: '近 30 天还没有缓存命中率记录',
    emptyHint: '有官方模型用量后这里会显示折线',
    tickFormat: (value) => formatPercent(value),
    yMax: 1,
  });
}

function renderOverview(payload) {
  renderStats(payload && payload.today ? payload.today : {});
  renderSummary(payload || {});
  renderCharts(payload && Array.isArray(payload.series) ? payload.series : []);
}

async function loadOverview() {
  const container = $('statCards');
  container.setAttribute('aria-busy', 'true');
  try {
    const payload = await api('/api/admin/overview?days=30');
    state.overview = payload;
    renderOverview(payload);
    hideError();
  } catch (error) {
    if (error.status === 401) return;
    renderSectionError(container, '概览加载失败', error);
    renderChartEmpty($('chartTokens'), '概览暂不可用', '重新加载页面后再试');
    renderChartEmpty($('chartCost'), '概览暂不可用', '重新加载页面后再试');
    renderChartEmpty($('chartCache'), '概览暂不可用', '重新加载页面后再试');
  } finally {
    container.setAttribute('aria-busy', 'false');
  }
}

function scheduleChartResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.overview) renderCharts(state.overview.series);
  }, 160);
}

// ---------------------------------------------------------------------------
// 用户：筛选 / 表格 / 封禁解封 / 重置密码 / 配额
// ---------------------------------------------------------------------------

function badge(text, variant, title) {
  const node = el('span', 'admin-badge ' + variant, text);
  if (title) node.title = title;
  return node;
}

function roleBadge(role) {
  return role === 'admin' ? badge('管理员', 'is-admin') : badge('用户', 'is-quiet');
}

function statusBadge(status) {
  return status === 'banned' ? badge('已封禁', 'is-banned') : badge('正常', 'is-active');
}

// 模型来源按用户行的 byok 标记渲染；无 byok 字段的旧数据回落「官方」。
function modelSourceBadge(user) {
  const byok = user && user.byok && typeof user.byok === 'object' ? user.byok : null;
  if (byok && byok.configured === true) {
    const providerId = byok.providerId ? String(byok.providerId) : '自定义';
    const detail = [byok.providerLabel, byok.model]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' · ');
    return badge('自定义（' + providerId + '）', 'is-custom', detail || providerId);
  }
  return badge('官方', 'is-official');
}

function feedbackStatusBadge(status) {
  return status === 'resolved' ? badge('已处理', 'is-resolved') : badge('待处理', 'is-open');
}

function tableCell(content, className) {
  const cell = el('td', className);
  if (content instanceof Node) cell.appendChild(content);
  else if (content === undefined || content === null || content === '') cell.textContent = '—';
  else cell.textContent = String(content);
  return cell;
}

function actionButton(label, action, userId) {
  const button = el('button', 'admin-btn admin-btn-quiet', label);
  button.type = 'button';
  button.setAttribute('data-action', action);
  button.setAttribute('data-user-id', userId);
  return button;
}

function renderUsers() {
  const wrap = $('usersTable');
  wrap.textContent = '';
  const users = state.users;
  if (users.length === 0) {
    const empty = el('p', 'admin-status', '没有符合条件的用户。换个关键词或状态再试试。');
    wrap.appendChild(empty);
    return;
  }

  const table = el('table', 'admin-table');
  const thead = el('thead');
  const headRow = el('tr');
  const columns = [
    '用户名',
    '昵称',
    '角色',
    '状态',
    '模型来源',
    '30 天 tokens',
    '30 天消费',
    '操作',
  ];
  for (const label of columns) {
    const th = el('th', undefined, label);
    th.setAttribute('scope', 'col');
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const user of users) {
    const row = el('tr');
    row.setAttribute('data-user-id', user.id);
    row.appendChild(tableCell(user.username, 'admin-cell-name'));
    row.appendChild(tableCell(user.displayName || '—'));
    row.appendChild(tableCell(roleBadge(user.role)));
    row.appendChild(tableCell(statusBadge(user.status)));

    row.appendChild(tableCell(modelSourceBadge(user)));

    const usage = user.usage30d || {};
    row.appendChild(tableCell(el('span', 'admin-cell-num', formatInt(usage.tokens)), 'admin-cell-num'));
    row.appendChild(tableCell(el('span', 'admin-cell-num', formatUsd(usage.costUsd)), 'admin-cell-num'));

    const actions = el('div', 'admin-actions');
    const isSelf = state.me && user.id === state.me.id;
    if (user.status === 'banned') {
      actions.appendChild(actionButton('解封', 'unban', user.id));
    } else {
      const ban = actionButton('封禁', 'ban', user.id);
      if (isSelf) {
        ban.disabled = true;
        ban.title = '不能封禁自己的账号';
      }
      actions.appendChild(ban);
    }
    actions.appendChild(actionButton('重置密码', 'reset-password', user.id));
    actions.appendChild(actionButton('配额', 'quota', user.id));
    row.appendChild(tableCell(actions, 'admin-cell-actions'));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

function usersQuery() {
  const params = new URLSearchParams();
  const query = $('userSearch').value.trim();
  const status = $('userStatus').value;
  if (query) params.set('query', query);
  if (status) params.set('status', status);
  params.set('limit', String(state.usersLimit));
  params.set('offset', String(state.usersOffset));
  return '?' + params.toString();
}

function renderUsersPagination() {
  const bar = $('usersPagination');
  const info = $('usersPageInfo');
  const prev = $('usersPrev');
  const next = $('usersNext');
  const size = $('usersPageSize');
  if (size) size.value = String(state.usersLimit);
  const total = state.usersTotal;
  const offset = state.usersOffset;
  const shown = state.users.length;
  if (!Number.isFinite(total) || total <= 0) {
    bar.hidden = true;
    info.textContent = '';
    prev.disabled = true;
    next.disabled = true;
    return;
  }
  bar.hidden = false;
  const from = shown === 0 ? 0 : offset + 1;
  const to = offset + shown;
  info.textContent = '第 ' + from + '–' + to + ' 条 / 共 ' + formatInt(total) + ' 位用户';
  prev.disabled = offset <= 0;
  next.disabled = offset + shown >= total;
}

async function loadUsers() {
  const wrap = $('usersTable');
  wrap.setAttribute('aria-busy', 'true');
  try {
    const payload = await api('/api/admin/users' + usersQuery());
    state.users = Array.isArray(payload && payload.users) ? payload.users : [];
    state.usersTotal = Number.isFinite(Number(payload && payload.total))
      ? Number(payload.total)
      : state.users.length;
    // 操作或筛选后当前页可能为空：回退一页再取，避免停在空白页。
    if (state.users.length === 0 && state.usersOffset > 0) {
      state.usersOffset = Math.max(0, state.usersOffset - state.usersLimit);
      await loadUsers();
      return;
    }
    renderUsers();
    renderUsersPagination();
  } catch (error) {
    if (error.status === 401) return;
    renderSectionError(wrap, '用户列表加载失败', error);
  } finally {
    wrap.setAttribute('aria-busy', 'false');
  }
}

function closeUserConfirm() {
  state.pendingConfirm = null;
  const bar = $('userConfirm');
  bar.hidden = true;
  $('userConfirmText').textContent = '';
}

function openUserConfirm(user, action) {
  state.pendingConfirm = { user, action };
  closeQuotaEditor();
  const name = displayNameOf(user) + '（' + user.username + '）';
  let text = '';
  if (action === 'ban') text = '确认封禁 ' + name + '？封禁后该用户无法继续登录并使用对话。';
  else if (action === 'unban') text = '确认解封 ' + name + '？解封后该用户可以继续使用。';
  else if (action === 'reset-password') text = '确认为 ' + name + ' 生成新的临时密码？原密码会立即失效。';
  else return;
  $('userConfirmText').textContent = text;
  $('userConfirmOk').textContent = action === 'reset-password' ? '生成临时密码' : '确认操作';
  $('userConfirm').hidden = false;
}

function userActionErrorMessage(error, user) {
  const name = displayNameOf(user);
  if (error.code === 'LAST_ADMIN') {
    return '操作未执行：至少需要保留一名可用的管理员。';
  }
  if (error.code === 'SELF_FORBIDDEN') {
    return '操作未执行：不能封禁或降级自己的账号。';
  }
  return name + ' 的操作没有完成：' + error.message;
}

async function runPendingUserAction() {
  const pending = state.pendingConfirm;
  if (!pending) return;
  const user = pending.user;
  const action = pending.action;
  const idPath = '/api/admin/users/' + encodeURIComponent(user.id);
  const button = $('userConfirmOk');
  button.disabled = true;
  try {
    if (action === 'ban') {
      await api(idPath, { method: 'PATCH', body: { status: 'banned' } });
    } else if (action === 'unban') {
      await api(idPath, { method: 'PATCH', body: { status: 'active' } });
    } else if (action === 'reset-password') {
      const payload = await api(idPath + '/reset-password', { method: 'POST', body: {} });
      closeUserConfirm();
      const temp = payload && payload.tempPassword ? payload.tempPassword : '未返回';
      showNotice('已重置 ' + displayNameOf(user) + ' 的密码，临时密码：' + temp + '（只显示这一次）');
      hideError();
      await Promise.all([loadUsers(), loadOverview()]);
      return;
    }
    closeUserConfirm();
    hideError();
    showNotice(
      action === 'ban'
        ? '已封禁 ' + displayNameOf(user) + '。'
        : '已解封 ' + displayNameOf(user) + '。',
    );
    await Promise.all([loadUsers(), loadOverview()]);
  } catch (error) {
    if (error.status === 401) return;
    showError(userActionErrorMessage(error, user));
  } finally {
    button.disabled = false;
  }
}

function closeQuotaEditor() {
  state.editingQuotaId = '';
  const editor = $('quotaEditor');
  editor.hidden = true;
  $('quotaTarget').textContent = '';
  $('quotaDay').value = '';
  $('quotaMonth').value = '';
}

function openQuotaEditor(user) {
  closeUserConfirm();
  state.editingQuotaId = user.id;
  $('quotaTarget').textContent =
    '正在编辑 ' + displayNameOf(user) + '（' + user.username + '）的配额；两处都留空表示不限额。';
  const quota = user.quota && typeof user.quota === 'object' ? user.quota : null;
  $('quotaDay').value = quota && Number.isInteger(quota.dayTokens) ? String(quota.dayTokens) : '';
  $('quotaMonth').value =
    quota && Number.isInteger(quota.monthTokens) ? String(quota.monthTokens) : '';
  $('quotaEditor').hidden = false;
}

async function saveQuota() {
  const user = state.users.find((candidate) => candidate.id === state.editingQuotaId);
  if (!user) return;
  const dayRaw = $('quotaDay').value.trim();
  const monthRaw = $('quotaMonth').value.trim();
  if ((dayRaw === '') !== (monthRaw === '')) {
    showError('配额没有保存：请同时填写日配额与月配额，或两处都留空表示不限额。');
    return;
  }
  let quota = null;
  if (dayRaw !== '') {
    const dayTokens = Number(dayRaw);
    const monthTokens = Number(monthRaw);
    if (
      !Number.isInteger(dayTokens) ||
      dayTokens < 0 ||
      !Number.isInteger(monthTokens) ||
      monthTokens < 0
    ) {
      showError('配额没有保存：日配额与月配额都需要是非负整数（单位 tokens）。');
      return;
    }
    quota = { dayTokens: dayTokens, monthTokens: monthTokens };
  }
  const button = $('quotaSave');
  button.disabled = true;
  try {
    await api('/api/admin/users/' + encodeURIComponent(user.id), {
      method: 'PATCH',
      body: { quota: quota },
    });
    closeQuotaEditor();
    hideError();
    showNotice('已更新 ' + displayNameOf(user) + ' 的配额。');
    await loadUsers();
  } catch (error) {
    if (error.status === 401) return;
    showError('配额没有保存：' + error.message);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 反馈
// ---------------------------------------------------------------------------

function feedbackItem(entry) {
  const item = el('article', 'admin-feedback-item');
  item.setAttribute('data-feedback-id', entry.id || '');

  const head = el('div', 'admin-feedback-head');
  head.appendChild(el('span', 'admin-feedback-user', entry.username || '未知用户'));
  const time = el('time', 'admin-feedback-time', formatDateTime(entry.createdAt));
  if (entry.createdAt) time.setAttribute('datetime', String(entry.createdAt));
  head.appendChild(time);
  head.appendChild(feedbackStatusBadge(entry.status));
  item.appendChild(head);

  // 反馈正文来自用户，永远按纯文本渲染（XSS 边界）。
  const body = el('p', 'admin-feedback-body');
  body.textContent = entry.body === undefined || entry.body === null ? '' : String(entry.body);
  item.appendChild(body);

  const meta = el('div', 'admin-feedback-meta');
  meta.appendChild(
    el('span', undefined, entry.conversationId ? '关联会话 ' + entry.conversationId : '未关联会话'),
  );
  meta.appendChild(el('span', undefined, entry.allowContext ? '允许读取上下文' : '未允许读取上下文'));
  item.appendChild(meta);

  if (entry.reply) {
    const reply = el('blockquote', 'admin-feedback-reply');
    reply.textContent = String(entry.reply);
    item.appendChild(reply);
  }

  const actions = el('div', 'admin-feedback-actions');
  const textarea = el('textarea', 'admin-textarea');
  textarea.setAttribute('data-reply-input', '');
  textarea.setAttribute('maxlength', '2000');
  textarea.setAttribute('placeholder', '写下给用户的回复（可留空）');
  textarea.setAttribute('aria-label', '回复 ' + (entry.username || '该用户') + ' 的反馈');
  actions.appendChild(textarea);

  const replyButton = el('button', 'admin-btn admin-btn-quiet', '保存回复');
  replyButton.type = 'button';
  replyButton.setAttribute('data-feedback-action', 'reply');
  actions.appendChild(replyButton);

  if (entry.status === 'resolved') {
    const reopenButton = el('button', 'admin-btn admin-btn-quiet', '重新打开');
    reopenButton.type = 'button';
    reopenButton.setAttribute('data-feedback-action', 'reopen');
    actions.appendChild(reopenButton);
  } else {
    const closeButton = el('button', 'admin-btn admin-btn-solid', '标记已处理');
    closeButton.type = 'button';
    closeButton.setAttribute('data-feedback-action', 'close');
    actions.appendChild(closeButton);
  }
  item.appendChild(actions);
  return item;
}

function renderFeedback() {
  const list = $('feedbackList');
  list.textContent = '';
  if (!state.feedback.length) {
    list.appendChild(
      el('p', 'admin-status', '当前筛选下没有反馈。切换状态或稍后刷新再看看。'),
    );
    return;
  }
  for (const entry of state.feedback) list.appendChild(feedbackItem(entry));
}

async function loadFeedback() {
  const list = $('feedbackList');
  const status = $('feedbackStatus').value;
  const search = status ? '?status=' + encodeURIComponent(status) : '';
  list.setAttribute('aria-busy', 'true');
  try {
    const payload = await api('/api/admin/feedback' + search);
    state.feedback = Array.isArray(payload && payload.feedback) ? payload.feedback : [];
    renderFeedback();
  } catch (error) {
    if (error.status === 401) return;
    renderSectionError(list, '反馈列表加载失败', error);
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

async function runFeedbackAction(entry, action, reply, button) {
  if (!entry || !entry.id) return;
  const patch = {};
  let notice = '';
  if (action === 'reply') {
    if (!reply) {
      showError('回复没有保存：回复内容不能为空。');
      return;
    }
    patch.reply = reply;
    notice = '回复已保存。';
  } else if (action === 'close') {
    patch.status = 'resolved';
    if (reply) patch.reply = reply;
    notice = '该反馈已标记为已处理。';
  } else if (action === 'reopen') {
    patch.status = 'open';
    if (reply) patch.reply = reply;
    notice = '该反馈已重新打开。';
  } else {
    return;
  }

  if (button) button.disabled = true;
  try {
    await api('/api/admin/feedback/' + encodeURIComponent(entry.id), {
      method: 'PATCH',
      body: patch,
    });
    hideError();
    showNotice(notice);
    await Promise.all([loadFeedback(), loadOverview()]);
  } catch (error) {
    if (error.status === 401) return;
    showError('反馈更新没有完成：' + error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function readDefaultQuota(settings) {
  const value = settings ? settings.defaultQuota : null;
  if (value && typeof value === 'object') {
    return {
      dayTokens: Number.isInteger(value.dayTokens) ? value.dayTokens : '',
      monthTokens: Number.isInteger(value.monthTokens) ? value.monthTokens : '',
    };
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return { dayTokens: value, monthTokens: '' };
  }
  const quota = settings ? settings.quota : null;
  if (quota && typeof quota === 'object') {
    return {
      dayTokens: Number.isInteger(quota.dayTokens) ? quota.dayTokens : '',
      monthTokens: Number.isInteger(quota.monthTokens) ? quota.monthTokens : '',
    };
  }
  return { dayTokens: '', monthTokens: '' };
}

function settingsCard(title, options) {
  const card = el('section', 'admin-card ' + (options && options.className ? options.className : ''));
  const head = el('div', 'admin-card-head');
  head.appendChild(el('h3', 'admin-card-title', title));
  if (options && options.badge) head.appendChild(options.badge);
  card.appendChild(head);
  if (options && options.note) card.appendChild(el('p', 'admin-card-note', options.note));
  return card;
}

function byokNoteText(enabled) {
  return enabled
    ? 'BYOK 已开启：用户可在「账号」页配置自己的模型密钥；关闭后所有用户立即回到官方模型。'
    : 'BYOK 暂未启用：所有对话使用官方模型与官方额度；开启后用户可在「账号」页配置自己的模型密钥。';
}

// 开关状态以服务端返回为准；这里同步徽标 / 开关文字 / 说明，避免整卡重渲染丢焦点。
function updateByokCard(enabled) {
  const badgeNode = $('byokBadge');
  if (badgeNode) {
    badgeNode.textContent = enabled ? '已启用' : '未启用';
    badgeNode.className = 'admin-badge ' + (enabled ? 'is-active' : 'is-official');
  }
  const switchText = document.querySelector('#settingsPanel .admin-switch-text');
  if (switchText) switchText.textContent = enabled ? '已开启' : '已关闭';
  const note = $('byokToggleNote');
  if (note) note.textContent = byokNoteText(enabled);
}

function renderSettings() {
  const panel = $('settingsPanel');
  panel.textContent = '';
  const settings = state.settings;
  if (!settings) {
    panel.appendChild(el('p', 'admin-status', '设置暂时不可用。稍后刷新再看看。'));
    return;
  }

  // BYOK 总开关（可交互；PATCH /api/admin/settings {byokEnabled}）
  const byokEnabled = settings.byokEnabled === true;
  const byokBadge = byokEnabled ? badge('已启用', 'is-active') : badge('未启用', 'is-official');
  byokBadge.id = 'byokBadge';
  const byokCard = settingsCard('BYOK', { className: 'admin-card-byok', badge: byokBadge });

  const toggleRow = el('div', 'admin-toggle-row');
  const switchLabel = el('label', 'admin-switch');
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.id = 'byokToggle';
  toggleInput.className = 'admin-switch-input';
  toggleInput.checked = byokEnabled;
  toggleInput.setAttribute('role', 'switch');
  toggleInput.setAttribute('aria-label', 'BYOK 总开关');
  toggleInput.setAttribute('aria-describedby', 'byokToggleNote');
  const switchTrack = el('span', 'admin-switch-track');
  switchTrack.setAttribute('aria-hidden', 'true');
  const switchText = el('span', 'admin-switch-text', byokEnabled ? '已开启' : '已关闭');
  switchLabel.appendChild(toggleInput);
  switchLabel.appendChild(switchTrack);
  switchLabel.appendChild(switchText);
  toggleRow.appendChild(switchLabel);
  byokCard.appendChild(toggleRow);

  const byokNote = el('p', 'admin-card-note');
  byokNote.id = 'byokToggleNote';
  byokNote.textContent = byokNoteText(byokEnabled);
  byokCard.appendChild(byokNote);
  panel.appendChild(byokCard);

  // 默认配额（可编辑，保存 #saveQuota）
  const defaults = readDefaultQuota(settings);
  const quotaCard = settingsCard('默认配额', {
    note: '新用户注册时获得这组额度；管理员账号始终不限额。',
  });
  const form = el('div', 'admin-form');
  const dayField = el('label', 'admin-field');
  dayField.appendChild(el('span', 'admin-label', '日配额 tokens'));
  const dayInput = el('input', 'admin-input admin-input-number');
  dayInput.type = 'number';
  dayInput.id = 'defaultQuotaDay';
  dayInput.min = '0';
  dayInput.step = '10000';
  dayInput.inputMode = 'numeric';
  dayInput.value = String(defaults.dayTokens);
  dayField.appendChild(dayInput);
  form.appendChild(dayField);

  const monthField = el('label', 'admin-field');
  monthField.appendChild(el('span', 'admin-label', '月配额 tokens'));
  const monthInput = el('input', 'admin-input admin-input-number');
  monthInput.type = 'number';
  monthInput.id = 'defaultQuotaMonth';
  monthInput.min = '0';
  monthInput.step = '10000';
  monthInput.inputMode = 'numeric';
  monthInput.value = String(defaults.monthTokens);
  monthField.appendChild(monthInput);
  form.appendChild(monthField);

  const saveButton = el('button', 'admin-btn admin-btn-solid', '保存默认配额');
  saveButton.type = 'button';
  saveButton.id = 'saveQuota';
  form.appendChild(saveButton);
  quotaCard.appendChild(form);
  panel.appendChild(quotaCard);

  // 模型白名单（只读）
  const models = Array.isArray(settings.allowedModels) ? settings.allowedModels : [];
  const modelsCard = settingsCard('模型白名单', {
    note: '只读：白名单由部署配置固定，管理页不提供修改入口。',
  });
  const modelList = el('ul', 'admin-token-list');
  if (models.length === 0) {
    modelList.appendChild(el('li', undefined, '未配置模型'));
  } else {
    for (const model of models) modelList.appendChild(el('li', undefined, String(model)));
  }
  modelsCard.appendChild(modelList);
  panel.appendChild(modelsCard);

  // 限流
  const rateLimit = settings.rateLimit && typeof settings.rateLimit === 'object' ? settings.rateLimit : {};
  const limitCard = settingsCard('限流', { note: '由服务端配置控制，管理页只读展示。' });
  const limitList = el('dl', 'admin-kv-list');
  const limitRows = [
    ['每分钟请求', Number.isInteger(rateLimit.perMinute) ? formatInt(rateLimit.perMinute) + ' 次' : '未设置'],
    ['并发请求', Number.isInteger(rateLimit.concurrency) ? formatInt(rateLimit.concurrency) + ' 个' : '未设置'],
    [
      '每人每日联网检索',
      Number.isInteger(settings.webSearchPerUserPerDay)
        ? formatInt(settings.webSearchPerUserPerDay) + ' 次'
        : '未设置',
    ],
  ];
  for (const row of limitRows) {
    const line = el('div', 'admin-kv');
    line.appendChild(el('dt', undefined, row[0]));
    line.appendChild(el('dd', undefined, row[1]));
    limitList.appendChild(line);
  }
  limitCard.appendChild(limitList);
  panel.appendChild(limitCard);

  // 价格口径（估算）
  const priceCard = settingsCard('价格口径', {
    badge: badge('估算', 'is-official'),
  });
  const priceLine = el('p', 'admin-price-line');
  priceLine.appendChild(el('span', undefined, '价格版本'));
  priceLine.appendChild(el('span', undefined, String(settings.priceVersion || '未标注')));
  priceCard.appendChild(priceLine);
  priceCard.appendChild(
    el(
      'p',
      'admin-card-note',
      '消费金额 = tokens 用量 × 该版本价目表单价，用于运营参考，不等同于账单金额。',
    ),
  );
  panel.appendChild(priceCard);

  // 峰谷策略 / BYOK 校验 / 附件保留等运行策略（只读；缺字段时回落系统状态）
  const effective = state.system && state.system.effective ? state.system.effective : {};
  const readEffective = (key) => {
    if (settings[key] !== undefined && settings[key] !== null) return settings[key];
    if (effective[key] !== undefined && effective[key] !== null) return effective[key];
    return undefined;
  };
  const peakPolicy = readEffective('peakModelPolicy');
  const peakModel = readEffective('peakModel');
  const peakHours = readEffective('peakHoursUtc') || readEffective('peakHours');
  const byokCheck = readEffective('byokCheckEnabled');
  const byokModels = readEffective('byokAllowedModels') || (effective.allowlists && effective.allowlists.models);
  const byokHosts = readEffective('byokAllowedHosts') || (effective.allowlists && effective.allowlists.hosts);
  const retention = readEffective('attachmentRetentionDays');
  const listText = (value) => (Array.isArray(value) && value.length > 0 ? value.join('、') : '未限制');
  const peakHoursText =
    typeof peakHours === 'string' && peakHours
      ? peakHours
      : Array.isArray(peakHours) && peakHours.length > 0
        ? peakHours.join(', ')
        : '未配置';
  const policyCard = settingsCard('峰谷与保留', {
    note: '由部署配置固定，管理页只读展示；峰谷策略只影响官方模型调用。',
  });
  const policyList = el('dl', 'admin-kv-list');
  const policyRows = [
    ['峰谷策略', peakPolicy === 'auto' ? '启用' : peakPolicy === 'off' ? '关闭' : '未配置'],
    ['峰段模型', peakPolicy === 'auto' && peakModel ? String(peakModel) : peakPolicy === 'off' ? '未启用' : '—'],
    ['峰段小时（UTC）', peakHoursText],
    ['BYOK 密钥校验', byokCheck === true ? '开启' : byokCheck === false ? '关闭' : '未配置'],
    ['BYOK 允许模型', listText(byokModels)],
    ['BYOK 允许域名', listText(byokHosts)],
    [
      '附件保留',
      Number.isInteger(retention) && retention > 0
        ? retention + ' 天'
        : retention === 0
          ? '不清理'
          : '未配置',
    ],
  ];
  for (const row of policyRows) {
    const line = el('div', 'admin-kv');
    line.appendChild(el('dt', undefined, row[0]));
    line.appendChild(el('dd', undefined, row[1]));
    policyList.appendChild(line);
  }
  policyCard.appendChild(policyList);
  panel.appendChild(policyCard);
}

async function loadSettings() {
  const panel = $('settingsPanel');
  panel.setAttribute('aria-busy', 'true');
  try {
    const payload = await api('/api/admin/settings');
    state.settings = payload && payload.settings ? payload.settings : null;
    renderSettings();
  } catch (error) {
    if (error.status === 401) return;
    renderSectionError(panel, '设置加载失败', error);
  } finally {
    panel.setAttribute('aria-busy', 'false');
  }
}

async function saveDefaultQuota() {
  const dayRaw = $('defaultQuotaDay') ? $('defaultQuotaDay').value.trim() : '';
  const monthRaw = $('defaultQuotaMonth') ? $('defaultQuotaMonth').value.trim() : '';
  if (dayRaw === '' || monthRaw === '') {
    showError('默认配额没有保存：请同时填写日配额与月配额（单位 tokens）。');
    return;
  }
  const dayTokens = Number(dayRaw);
  const monthTokens = Number(monthRaw);
  if (
    !Number.isInteger(dayTokens) ||
    dayTokens < 0 ||
    !Number.isInteger(monthTokens) ||
    monthTokens < 0
  ) {
    showError('默认配额没有保存：两项都需要是非负整数（单位 tokens）。');
    return;
  }
  const button = $('saveQuota');
  if (button) button.disabled = true;
  try {
    const payload = await api('/api/admin/settings', {
      method: 'PATCH',
      body: { defaultQuota: { dayTokens: dayTokens, monthTokens: monthTokens } },
    });
    state.settings = payload && payload.settings ? payload.settings : state.settings;
    hideError();
    renderSettings();
    showNotice('默认配额已保存。');
  } catch (error) {
    if (error.status === 401) return;
    showError('默认配额没有保存：' + error.message);
  } finally {
    const current = $('saveQuota');
    if (current) current.disabled = false;
  }
}

async function saveByokToggle(input) {
  if (!state.settings || !input) return;
  const previous = state.settings.byokEnabled === true;
  const next = input.checked === true;
  const card = input.closest('.admin-card');
  input.disabled = true;
  if (card) card.setAttribute('data-busy', 'true');
  try {
    const payload = await api('/api/admin/settings', {
      method: 'PATCH',
      body: { byokEnabled: next },
    });
    state.settings = payload && payload.settings ? payload.settings : { ...state.settings, byokEnabled: next };
    const effective = state.settings.byokEnabled === true;
    input.checked = effective;
    updateByokCard(effective);
    hideError();
    showNotice(
      effective
        ? 'BYOK 总开关已开启：用户可在账号页配置自定义模型。'
        : 'BYOK 总开关已关闭：所有用户即时回到官方模型。',
    );
  } catch (error) {
    if (error.status === 401) return;
    // 失败回滚：开关与徽标/说明恢复到切换前的状态，避免界面与服务端不一致。
    input.checked = previous;
    updateByokCard(previous);
    showError('BYOK 开关没有保存：' + error.message);
  } finally {
    input.disabled = false;
    if (card) card.removeAttribute('data-busy');
  }
}

// ---------------------------------------------------------------------------
// 邀请码：列表 / 新建 / 禁用 / 启用 / 备注
// ---------------------------------------------------------------------------

function inviteStateBadge(invite) {
  if (invite.disabled === true) return badge('已禁用', 'is-banned');
  const expiresAt = invite.expiresAt ? Date.parse(invite.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt < Date.now()) return badge('已过期', 'is-quiet');
  const uses = Number(invite.uses) || 0;
  const maxUses = Number(invite.maxUses) || 0;
  if (maxUses > 0 && uses >= maxUses) return badge('已用尽', 'is-quiet');
  return badge('可用', 'is-active');
}

function inviteActionButton(label, action, code, danger) {
  const classes = danger
    ? 'admin-btn admin-btn-quiet admin-btn-danger'
    : 'admin-btn admin-btn-quiet';
  const button = el('button', classes, label);
  button.type = 'button';
  button.setAttribute('data-invite-action', action);
  button.setAttribute('data-invite-code', code);
  return button;
}

function inviteItem(invite) {
  const item = el('article', 'admin-invite-item');
  item.setAttribute('data-invite-code', invite.code);

  const head = el('div', 'admin-invite-head');
  head.appendChild(el('strong', 'admin-invite-code', invite.code));
  head.appendChild(roleBadge(invite.role === 'admin' ? 'admin' : 'user'));
  head.appendChild(inviteStateBadge(invite));
  item.appendChild(head);

  const meta = el('div', 'admin-invite-meta');
  const uses = Number(invite.uses) || 0;
  const maxUses = Number(invite.maxUses) || 0;
  meta.appendChild(el('span', undefined, '已用 ' + uses + ' / ' + maxUses + ' 次'));
  meta.appendChild(el('span', undefined, '过期 ' + formatDateTime(invite.expiresAt)));
  if (invite.lastUsedAt) {
    meta.appendChild(el('span', undefined, '最近使用 ' + formatDateTime(invite.lastUsedAt)));
  }
  item.appendChild(meta);

  const note = el('p', 'admin-invite-note');
  // 备注来自管理员输入，必须按纯文本渲染（XSS 边界）。
  note.textContent = invite.note ? String(invite.note) : '无备注';
  item.appendChild(note);

  const actions = el('div', 'admin-invite-actions');
  if (invite.disabled === true) {
    actions.appendChild(inviteActionButton('启用', 'enable', invite.code, false));
  } else {
    actions.appendChild(inviteActionButton('禁用', 'disable', invite.code, true));
  }
  actions.appendChild(inviteActionButton('备注', 'note', invite.code, false));
  item.appendChild(actions);

  const editor = el('div', 'admin-invite-editor');
  editor.hidden = state.inviteEditorCode !== invite.code;
  const input = el('input', 'admin-input');
  input.type = 'text';
  input.maxLength = 200;
  input.placeholder = '例如：给设计团队';
  input.value = invite.note ? String(invite.note) : '';
  input.setAttribute('aria-label', '邀请码备注');
  input.setAttribute('data-invite-note-input', 'true');
  editor.appendChild(input);
  editor.appendChild(inviteActionButton('保存备注', 'save-note', invite.code, false));
  editor.appendChild(inviteActionButton('取消', 'cancel-note', invite.code, false));
  item.appendChild(editor);
  return item;
}

function renderInvites() {
  const list = $('invitesList');
  list.textContent = '';
  const invites = Array.isArray(state.invites) ? state.invites : [];
  if (invites.length === 0) {
    list.appendChild(
      el('p', 'admin-status', '当前筛选下没有邀请码。新建一个，或切换到「全部（含已禁用）」再看看。'),
    );
    return;
  }
  for (const invite of invites) list.appendChild(inviteItem(invite));
}

async function loadInvites() {
  const list = $('invitesList');
  list.setAttribute('aria-busy', 'true');
  try {
    const payload = await api('/api/admin/invites?include=' + encodeURIComponent(state.inviteInclude));
    state.invites = Array.isArray(payload && payload.invites) ? payload.invites : [];
    renderInvites();
  } catch (error) {
    if (error.status === 401) return;
    renderSectionError(list, '邀请码加载失败', error);
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

function inviteErrorMessage(error) {
  if (error.code === 'INVITE_NOT_FOUND') return '邀请码不存在或已被删除。';
  if (error.code === 'INVALID_INPUT') return '输入内容不合法，请检查后再试。';
  return error.message;
}

async function createInvite() {
  const roleSelect = $('inviteRole');
  const maxUsesInput = $('inviteMaxUses');
  const expiresInput = $('inviteExpiresDays');
  const noteInput = $('inviteNote');
  const role = roleSelect && roleSelect.value === 'admin' ? 'admin' : 'user';
  const maxUses = Number(maxUsesInput ? maxUsesInput.value : '');
  const expiresInDays = Number(expiresInput ? expiresInput.value : '');
  const note = noteInput ? noteInput.value.trim() : '';
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 20) {
    showError('邀请码没有创建：可用次数需要是 1–20 的整数。');
    return;
  }
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    showError('邀请码没有创建：有效期需要是 1–90 天。');
    return;
  }
  const button = $('inviteCreate');
  if (button) button.disabled = true;
  try {
    const body = { role: role, maxUses: maxUses, expiresInDays: expiresInDays };
    if (note) body.note = note;
    const payload = await api('/api/admin/invites', { method: 'POST', body: body });
    const code = payload && payload.invite ? payload.invite.code : '';
    if (noteInput) noteInput.value = '';
    hideError();
    await loadInvites();
    showNotice('邀请码已创建：' + (code || '已生成') + '。');
  } catch (error) {
    if (error.status === 401) return;
    showError('邀请码没有创建：' + inviteErrorMessage(error));
  } finally {
    if ($('inviteCreate')) $('inviteCreate').disabled = false;
  }
}

async function patchInvite(code, body) {
  try {
    const payload = await api('/api/admin/invites/' + encodeURIComponent(code), {
      method: 'PATCH',
      body: body,
    });
    hideError();
    return payload && payload.invite ? payload.invite : null;
  } catch (error) {
    if (error.status === 401) return null;
    showError('邀请码没有保存：' + inviteErrorMessage(error));
    return null;
  }
}

async function disableInvite(code) {
  try {
    await api('/api/admin/invites/' + encodeURIComponent(code), { method: 'DELETE' });
    hideError();
    await loadInvites();
    showNotice('邀请码已禁用。');
  } catch (error) {
    if (error.status === 401) return;
    showError('邀请码没有禁用：' + inviteErrorMessage(error));
  }
}

async function enableInvite(code) {
  const invite = await patchInvite(code, { disabled: false });
  if (!invite) return;
  await loadInvites();
  showNotice('邀请码已启用。');
}

async function saveInviteNote(code) {
  const item = document.querySelector('[data-invite-code="' + code + '"]');
  const input = item ? item.querySelector('input[data-invite-note-input]') : null;
  if (!input) return;
  const note = input.value.trim();
  const invite = await patchInvite(code, { note: note === '' ? null : note });
  if (!invite) return;
  state.inviteEditorCode = '';
  await loadInvites();
  showNotice('邀请码备注已保存。');
}

// ---------------------------------------------------------------------------
// 审计日志：时间倒序、游标分页、动作中文映射
// ---------------------------------------------------------------------------

const AUDIT_ACTION_LABELS = {
  'invite.create': '新建邀请码',
  'invite.update': '修改邀请码',
  'user.update': '更新用户',
  'user.reset_password': '重置密码',
  'settings.update': '更新设置',
  'feedback.update': '处理反馈',
  'maintenance.attachments_sweep': '清理附件',
};

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || String(action || '未知操作');
}

function auditItem(entry) {
  const item = el('article', 'admin-audit-item');
  item.setAttribute('data-audit-id', entry.id);

  const head = el('div', 'admin-audit-head');
  head.appendChild(el('time', 'admin-audit-time', formatDateTime(entry.ts)));
  head.appendChild(badge(auditActionLabel(entry.action), 'is-quiet'));
  head.appendChild(el('span', 'admin-audit-actor', '操作者：' + (entry.actorUsername || entry.actorId || '未知')));
  item.appendChild(head);

  const meta = el('p', 'admin-audit-meta');
  meta.textContent =
    '目标：' + (entry.targetType || '—') + (entry.targetId ? ' / ' + entry.targetId : '');
  item.appendChild(meta);

  const detail = el('p', 'admin-audit-detail');
  detail.textContent = entry.detail ? String(entry.detail) : '无详情';
  item.appendChild(detail);
  return item;
}

function renderAuditPagination() {
  const bar = $('auditPagination');
  const info = $('auditPageInfo');
  if (state.audit.length === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  info.textContent = '第 ' + (state.auditPage + 1) + ' 页 · 每页 20 条';
  $('auditPrev').disabled = state.auditPage <= 0;
  $('auditNext').disabled = !state.auditNextCursor;
}

function renderAudit() {
  const list = $('auditList');
  list.textContent = '';
  const entries = Array.isArray(state.audit) ? state.audit : [];
  if (entries.length === 0) {
    list.appendChild(el('p', 'admin-status', '当前没有审计记录。'));
  } else {
    for (const entry of entries) list.appendChild(auditItem(entry));
  }
  renderAuditPagination();
}

async function loadAudit(cursor) {
  const list = $('auditList');
  list.setAttribute('aria-busy', 'true');
  try {
    const params = new URLSearchParams();
    params.set('limit', '20');
    if (cursor) params.set('cursor', cursor);
    const payload = await api('/api/admin/audit?' + params.toString());
    state.audit = Array.isArray(payload && payload.entries) ? payload.entries : [];
    state.auditNextCursor = payload && payload.nextCursor ? String(payload.nextCursor) : null;
    renderAudit();
  } catch (error) {
    if (error.status === 401) return;
    renderSectionError(list, '审计日志加载失败', error);
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

async function auditNextPage() {
  if (!state.auditNextCursor) return;
  state.auditPage += 1;
  state.auditCursors[state.auditPage] = state.auditNextCursor;
  await loadAudit(state.auditNextCursor);
}

async function auditPrevPage() {
  if (state.auditPage <= 0) return;
  state.auditPage -= 1;
  await loadAudit(state.auditCursors[state.auditPage] || null);
}

// ---------------------------------------------------------------------------
// 系统状态：只读运行信息，失败降级显示「不可用」
// ---------------------------------------------------------------------------

function systemField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback || '不可用';
  return String(value);
}

function systemKvList(rows) {
  const list = el('dl', 'admin-kv-list');
  for (const row of rows) {
    const line = el('div', 'admin-kv');
    line.appendChild(el('dt', undefined, row[0]));
    line.appendChild(el('dd', undefined, row[1]));
    list.appendChild(line);
  }
  return list;
}

function systemCard(title, children) {
  const card = el('section', 'admin-system-card');
  card.appendChild(el('h3', 'admin-system-title', title));
  for (const child of children) card.appendChild(child);
  return card;
}

function listOrNone(value) {
  return Array.isArray(value) && value.length > 0 ? value.join('、') : '未限制';
}

function renderSystem() {
  const panel = $('systemPanel');
  panel.textContent = '';
  const system = state.system;
  if (!system || typeof system !== 'object') {
    panel.appendChild(el('p', 'admin-status', '系统状态不可用：暂时读不到运行时信息。'));
    return;
  }
  const disk = system.disk && typeof system.disk === 'object' ? system.disk : null;
  const memory = system.memory && typeof system.memory === 'object' ? system.memory : {};
  const data = system.data && typeof system.data === 'object' ? system.data : {};
  const backup = system.backup && typeof system.backup === 'object' ? system.backup : null;
  const effective = system.effective && typeof system.effective === 'object' ? system.effective : {};

  // 版本与运行时
  const uptimeSec = Number(system.uptimeSec);
  panel.appendChild(
    systemCard('版本与运行时', [
      systemKvList([
        ['版本', systemField(system.version)],
        ['Node', systemField(system.node)],
        ['平台', systemField(system.platform)],
        ['已运行', Number.isFinite(uptimeSec) ? formatDuration(uptimeSec) : '不可用'],
        ['启动时间', system.startedAt ? formatDateTime(system.startedAt) : '不可用'],
      ]),
    ]),
  );

  // 磁盘（原生 progress，零内联样式；statfs 失败时不可用）
  const diskChildren = [];
  if (!disk) {
    diskChildren.push(el('p', 'admin-card-note', '磁盘信息不可用（statfs 读取失败）。'));
  } else {
    const usedPercent = Number(disk.usedPercent);
    const meter = el('progress', 'admin-meter');
    meter.max = 100;
    meter.value = Number.isFinite(usedPercent) ? Math.min(100, Math.max(0, usedPercent)) : 0;
    meter.setAttribute('aria-label', '磁盘使用率');
    diskChildren.push(meter);
    const caption = el('p', 'admin-meter-caption');
    caption.textContent =
      '已用 ' +
      formatBytes(disk.usedBytes) +
      ' / ' +
      formatBytes(disk.totalBytes) +
      '（' +
      (Number.isFinite(usedPercent) ? usedPercent.toFixed(1) : '—') +
      '%），剩余 ' +
      formatBytes(disk.freeBytes);
    diskChildren.push(caption);
  }
  panel.appendChild(systemCard('磁盘', diskChildren));

  // 内存
  panel.appendChild(
    systemCard('内存', [
      systemKvList([
        ['RSS', Number.isFinite(Number(memory.rss)) ? formatBytes(memory.rss) : '不可用'],
        ['堆已用', Number.isFinite(Number(memory.heapUsed)) ? formatBytes(memory.heapUsed) : '不可用'],
        ['堆总量', Number.isFinite(Number(memory.heapTotal)) ? formatBytes(memory.heapTotal) : '不可用'],
      ]),
    ]),
  );

  // 数据目录
  panel.appendChild(
    systemCard('数据目录', [
      systemKvList([
        ['目录大小', Number.isFinite(Number(data.dirBytes)) ? formatBytes(data.dirBytes) : '不可用'],
        ['文件数', Number.isFinite(Number(data.files)) ? formatInt(data.files) : '不可用'],
        ['用户数', Number.isFinite(Number(data.userCount)) ? formatInt(data.userCount) : '不可用'],
      ]),
    ]),
  );

  // 最近备份：后端 backup 恒为对象，未配置时 dir 为空、lastAt/lastPath 为 null。
  const backupConfigured = Boolean(backup && (backup.dir || backup.lastAt || backup.lastPath));
  panel.appendChild(
    systemCard('最近备份', [
      backupConfigured
        ? systemKvList([
            ['目录', systemField(backup.dir)],
            ['最近备份', backup.lastAt ? formatDateTime(backup.lastAt) : '未配置'],
            ['路径', backup.lastPath ? String(backup.lastPath) : '未配置'],
            ['备份份数', Number.isFinite(Number(backup.entries)) ? formatInt(backup.entries) : '—'],
          ])
        : el('p', 'admin-card-note', '未配置备份目录：配置后这里会显示最近备份。'),
    ]),
  );

  // 生效配置
  const peakPolicy = effective.peakPolicy;
  const peakHours =
    Array.isArray(effective.peakHours) && effective.peakHours.length > 0
      ? effective.peakHours.join(', ')
      : '未配置';
  const retention = effective.attachmentRetentionDays;
  panel.appendChild(
    systemCard('生效配置', [
      systemKvList([
        ['模型', systemField(effective.model)],
        ['峰谷策略', peakPolicy === 'auto' ? '启用' : peakPolicy === 'off' ? '关闭' : '未配置'],
        ['峰段模型', peakPolicy === 'auto' ? systemField(effective.peakModel) : '未启用'],
        ['峰段小时（UTC）', peakHours],
        [
          'BYOK 校验',
          effective.byokCheckEnabled === true
            ? '开启'
            : effective.byokCheckEnabled === false
              ? '关闭'
              : '未配置',
        ],
        ['BYOK 允许模型', listOrNone(effective.allowlists && effective.allowlists.models)],
        ['BYOK 允许域名', listOrNone(effective.allowlists && effective.allowlists.hosts)],
        [
          '联网日上限',
          Number.isInteger(effective.webSearchPerUserPerDay)
            ? formatInt(effective.webSearchPerUserPerDay) + ' 次'
            : '不可用',
        ],
        [
          '附件保留',
          Number.isInteger(retention) && retention > 0
            ? retention + ' 天'
            : retention === 0
              ? '不清理'
              : '不可用',
        ],
      ]),
    ]),
  );
}

async function loadSystem() {
  const panel = $('systemPanel');
  panel.setAttribute('aria-busy', 'true');
  try {
    const payload = await api('/api/admin/system');
    state.system = payload && typeof payload === 'object' ? payload : null;
    renderSystem();
    // 设置区的「峰谷与保留」卡会回落到系统状态里的生效配置，加载到后补渲染一次。
    if (state.settings) renderSettings();
  } catch (error) {
    if (error.status === 401) return;
    state.system = null;
    renderSectionError(panel, '系统状态不可用', error);
  } finally {
    panel.removeAttribute('aria-busy');
  }
}

async function sweepAttachments() {
  const button = $('sweepAttachments');
  if (button) button.disabled = true;
  try {
    const payload = await api('/api/admin/maintenance/sweep-attachments', {
      method: 'POST',
      body: {},
    });
    hideError();
    const removed = Number(payload && payload.removed);
    const bytes = Number(payload && payload.bytes);
    showNotice(
      '已清理 ' + formatInt(Number.isFinite(removed) ? removed : 0) + ' 个过期附件' +
        (Number.isFinite(bytes) ? '（' + formatBytes(bytes) + '）' : '') +
        '。',
    );
  } catch (error) {
    if (error.status === 401) return;
    if (error.code === 'MAINTENANCE_DISABLED') {
      showError('清理没有执行：附件保留策略未启用。');
    } else {
      showError('清理没有执行：' + error.message);
    }
  } finally {
    if ($('sweepAttachments')) $('sweepAttachments').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 事件绑定与启动
// ---------------------------------------------------------------------------

function bindEvents() {
  $('logoutBtn').addEventListener('click', async () => {
    $('logoutBtn').disabled = true;
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // 退出失败也回到登录页，避免停留在管理员界面。
    }
    location.replace(LOGIN_PATH);
  });

  $('userSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.usersOffset = 0;
      loadUsers();
    }, 260);
  });

  $('userStatus').addEventListener('change', () => {
    state.usersOffset = 0;
    loadUsers();
  });

  $('usersRefresh').addEventListener('click', () => {
    loadUsers();
  });

  $('usersPageSize').addEventListener('change', (event) => {
    const size = Number(event.target instanceof HTMLSelectElement ? event.target.value : 20);
    state.usersLimit = size === 50 ? 50 : 20;
    state.usersOffset = 0;
    loadUsers();
  });

  $('usersPrev').addEventListener('click', () => {
    if (state.usersOffset <= 0) return;
    state.usersOffset = Math.max(0, state.usersOffset - state.usersLimit);
    loadUsers();
  });

  $('usersNext').addEventListener('click', () => {
    if (state.usersOffset + state.users.length >= state.usersTotal) return;
    state.usersOffset += state.usersLimit;
    loadUsers();
  });

  $('usersTable').addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (!button) return;
    const userId = button.getAttribute('data-user-id');
    const action = button.getAttribute('data-action');
    const user = state.users.find((candidate) => candidate.id === userId);
    if (!user) return;
    if (action === 'quota') openQuotaEditor(user);
    else openUserConfirm(user, action);
  });

  $('userConfirmOk').addEventListener('click', () => {
    runPendingUserAction();
  });

  $('userConfirmCancel').addEventListener('click', () => {
    closeUserConfirm();
  });

  $('quotaSave').addEventListener('click', () => {
    saveQuota();
  });

  $('quotaCancel').addEventListener('click', () => {
    closeQuotaEditor();
  });

  $('feedbackStatus').addEventListener('change', () => {
    loadFeedback();
  });

  $('feedbackRefresh').addEventListener('click', () => {
    loadFeedback();
  });

  $('feedbackList').addEventListener('click', (event) => {
    const button =
      event.target instanceof Element ? event.target.closest('button[data-feedback-action]') : null;
    if (!button) return;
    const item = button.closest('[data-feedback-id]');
    if (!item) return;
    const feedbackId = item.getAttribute('data-feedback-id');
    const entry = state.feedback.find((candidate) => candidate.id === feedbackId);
    if (!entry) return;
    const textarea = item.querySelector('textarea[data-reply-input]');
    const reply = textarea ? textarea.value.trim() : '';
    runFeedbackAction(entry, button.getAttribute('data-feedback-action'), reply, button);
  });

  $('settingsPanel').addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('#saveQuota') : null;
    if (!button) return;
    saveDefaultQuota();
  });

  $('settingsPanel').addEventListener('change', (event) => {
    const input =
      event.target instanceof HTMLInputElement && event.target.id === 'byokToggle'
        ? event.target
        : null;
    if (!input) return;
    saveByokToggle(input);
  });

  // 邀请码
  $('inviteInclude').addEventListener('change', (event) => {
    state.inviteInclude = event.target instanceof HTMLSelectElement && event.target.value === 'all'
      ? 'all'
      : 'active';
    loadInvites();
  });

  $('invitesRefresh').addEventListener('click', () => {
    loadInvites();
  });

  $('inviteCreate').addEventListener('click', () => {
    createInvite();
  });

  $('invitesList').addEventListener('click', (event) => {
    const button =
      event.target instanceof Element ? event.target.closest('button[data-invite-action]') : null;
    if (!button) return;
    const action = button.getAttribute('data-invite-action');
    const code = button.getAttribute('data-invite-code');
    if (!code) return;
    if (action === 'disable') disableInvite(code);
    else if (action === 'enable') enableInvite(code);
    else if (action === 'note') {
      state.inviteEditorCode = state.inviteEditorCode === code ? '' : code;
      renderInvites();
    } else if (action === 'cancel-note') {
      state.inviteEditorCode = '';
      renderInvites();
    } else if (action === 'save-note') {
      saveInviteNote(code);
    }
  });

  // 审计日志
  $('auditRefresh').addEventListener('click', () => {
    state.auditPage = 0;
    state.auditCursors = [null];
    loadAudit(null);
  });

  $('auditPrev').addEventListener('click', () => {
    auditPrevPage();
  });

  $('auditNext').addEventListener('click', () => {
    auditNextPage();
  });

  // 系统状态
  $('systemRefresh').addEventListener('click', () => {
    loadSystem();
  });

  $('sweepAttachments').addEventListener('click', () => {
    sweepAttachments();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeUserConfirm();
    closeQuotaEditor();
  });

  window.addEventListener('resize', scheduleChartResize);
}

async function boot() {
  bindEvents();
  try {
    const me = await api('/api/auth/me');
    if (!me || me.auth !== 'on' || !me.user) {
      redirectToLogin();
      return;
    }
    if (me.user.role !== 'admin') {
      // 非管理员不留在后台：回到主界面（登录页只服务未登录场景）。
      location.replace('/');
      return;
    }
    state.me = me.user;
    state.csrf = me.csrf || readCookie(CSRF_COOKIE) || '';
    $('adminUser').textContent = me.user.displayName || me.user.username || '管理员';
    await Promise.allSettled([
      loadOverview(),
      loadUsers(),
      loadFeedback(),
      loadSettings(),
      loadInvites(),
      loadAudit(null),
      loadSystem(),
    ]);
  } catch (error) {
    if (error && error.status === 401) return;
    const message = error && error.message ? error.message : '无法验证登录状态，请刷新页面重试。';
    showError('管理后台没有加载完成：' + message);
    $('adminUser').textContent = '未登录';
    renderSectionError($('statCards'), '概览加载失败', error);
    renderSectionError($('usersTable'), '用户列表加载失败', error);
    renderSectionError($('feedbackList'), '反馈列表加载失败', error);
    renderSectionError($('invitesList'), '邀请码加载失败', error);
    renderSectionError($('auditList'), '审计日志加载失败', error);
    renderSectionError($('systemPanel'), '系统状态不可用', error);
    renderSectionError($('settingsPanel'), '设置加载失败', error);
  }
}

boot();
