// account.js — 账号页：昵称 / 密码 / 用量 / 我的反馈（AUTH=on 多用户）。
//
// - AUTH=off：回首页（不展示账号功能，旧单用户行为不变）；
// - AUTH=on 未登录：跳登录页并保留当前路径；
// - 用户数据只用 textContent / DOM 节点渲染，不拼 innerHTML。

import { ApiError, createApi, formatRelativeTime, loginUrlFor } from './api.js';

const api = createApi({ fetchImpl: (...args) => window.fetch(...args) });
const $ = (id) => document.getElementById(id);

const dom = {
  accountError: $('accountError'),
  accountUsername: $('accountUsername'),
  accountRole: $('accountRole'),
  profileForm: $('profileForm'),
  displayName: $('displayName'),
  saveProfile: $('saveProfile'),
  profileStatus: $('profileStatus'),
  passwordForm: $('passwordForm'),
  oldPassword: $('oldPassword'),
  newPassword: $('newPassword'),
  savePassword: $('savePassword'),
  passwordStatus: $('passwordStatus'),
  logoutBtn: $('logoutBtn'),
  usageStats: $('usageStats'),
  feedbackList: $('feedbackList'),
  // 自定义模型（BYOK）卡片
  byokCard: $('byokCard'),
  byokStatus: $('byokStatus'),
  byokForm: $('byokForm'),
  byokProvider: $('byokProvider'),
  byokModel: $('byokModel'),
  byokBaseUrlField: $('byokBaseUrlField'),
  byokBaseUrl: $('byokBaseUrl'),
  byokApiKey: $('byokApiKey'),
  byokSave: $('byokSave'),
  byokCheck: $('byokCheck'),
  byokDelete: $('byokDelete'),
  byokHint: $('byokHint'),
  byokCheckResult: $('byokCheckResult'),
  byokError: $('byokError'),
  // 数据与账号（导出 / 注销）
  dataStatus: $('dataStatus'),
  exportDataBtn: $('exportDataBtn'),
  deletePassword: $('deletePassword'),
  deleteUsername: $('deleteUsername'),
  deleteError: $('deleteError'),
  deleteAccountBtn: $('deleteAccountBtn'),
};

/** 当前登录用户（注销确认时校验用户名）。 */
let currentUser = null;

const ROLE_LABELS = { admin: '管理员', user: '成员' };

// 自定义模型（BYOK）错误码 → 中文文案（契约 9）。
const BYOK_ERROR_LABELS = {
  BYOK_DISABLED: '自定义模型已由管理员关闭。',
  BYOK_URL_INVALID: 'Base URL 必须是合法的 https 地址。',
  BYOK_KEY_INVALID: 'API key 不正确或已失效（需 8–512 个字符）。',
  INVALID_PROVIDER: '请选择有效的厂商。',
  INVALID_MODEL: '模型名格式不正确（仅字母、数字与 . _ : / -）。',
  INVALID_INPUT: '填写内容不合法，请检查后重试。',
  BYOK_ENDPOINT_INVALID: '接口地址不可用，请检查 Base URL。',
  BYOK_CHECK_TIMEOUT: '连接测试超时，请稍后重试。',
  BYOK_TIMEOUT: '连接测试超时，请稍后重试。',
  BYOK_CHECK_RATE_LIMITED: '测试太频繁，请稍后再试。',
  BYOK_CHECK_FAILED: '连接测试失败，请检查配置。',
  BYOK_NOT_CONFIGURED: '请先保存配置再测试连接。',
  UNAUTHORIZED: '登录已失效，请重新登录。',
  NETWORK: '网络中断或服务未启动。',
};
const BYOK_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;

/** 账号页 BYOK 卡的本地状态（key 从不落本地存储，也不回显）。 */
const byokState = {
  enabled: false,
  configured: false,
  presets: [],
  provider: '',
  model: '',
};

function formatInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString('zh-CN') : '—';
}

function formatCost(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(4)}` : '—';
}

function formatRate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : '—';
}

function showError(message) {
  if (!dom.accountError) return;
  dom.accountError.textContent = message || '';
  dom.accountError.hidden = !message;
}

function showStatus(node, message) {
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.dataset.busy = busy ? 'true' : 'false';
}

/** 错误文案：契约错误码 → 中文提示（不直接展示服务端英文 message）。 */
function errorText(error, fallback) {
  if (!(error instanceof ApiError)) return fallback;
  const labels = {
    INVALID_INPUT: '填写内容不合法，请检查后重试。',
    INVALID_PASSWORD: `当前密码不正确。`,
    UNAUTHORIZED: '登录已失效，请重新登录。',
    NETWORK: '网络中断或服务未启动。',
  };
  return labels[error.code] || fallback;
}

/* ==========================================================================
   自定义模型（BYOK）
   - GET /api/me/byok 初始化；PUT 保存；POST /api/me/byok/check 探活；DELETE 删除。
   - API key 只从输入框单向提交，不写浏览器本地存储 / console / URL，保存成功后立即清空。
   - 渲染一律 textContent / createElement，服务端返回的 label、keyHint 均不可注入 HTML。
   ========================================================================== */

function byokErrorText(error, fallback) {
  if (!(error instanceof ApiError)) return fallback;
  return BYOK_ERROR_LABELS[error.code] || fallback;
}

function setByokError(message) {
  if (!dom.byokError) return;
  dom.byokError.textContent = message || '';
  dom.byokError.hidden = !message;
}

function setByokCheckResult(message) {
  if (!dom.byokCheckResult) return;
  dom.byokCheckResult.textContent = message || '';
  dom.byokCheckResult.hidden = !message;
}

function isHttpsUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function renderProviderOptions(presets) {
  if (!dom.byokProvider) return;
  const fragment = document.createDocumentFragment();
  for (const preset of presets) {
    if (!preset || typeof preset.id !== 'string' || !preset.id) continue;
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = String(preset.label || preset.id);
    fragment.append(option);
  }
  dom.byokProvider.replaceChildren(fragment);
}

/** 切厂商：custom 显示 Base URL，其余隐藏；模型 input placeholder = preset.modelHint。 */
function applyByokPreset(providerId) {
  const preset = byokState.presets.find((item) => item.id === providerId) || null;
  byokState.provider = preset ? preset.id : '';
  const custom = preset?.requiresBaseUrl === true;
  if (dom.byokBaseUrlField) dom.byokBaseUrlField.hidden = !custom;
  if (!custom && dom.byokBaseUrl) dom.byokBaseUrl.value = '';
  if (dom.byokModel) {
    const hint = typeof preset?.modelHint === 'string' && preset.modelHint ? preset.modelHint : '';
    dom.byokModel.placeholder = hint || '模型名，例如 gpt-4o-mini';
  }
}

function setByokControlsDisabled(disabled) {
  for (const node of [dom.byokProvider, dom.byokModel, dom.byokBaseUrl, dom.byokApiKey]) {
    if (node) node.disabled = disabled;
  }
  if (dom.byokSave) dom.byokSave.disabled = disabled;
  if (dom.byokCheck) dom.byokCheck.disabled = disabled || !byokState.configured;
  if (dom.byokDelete) dom.byokDelete.disabled = !byokState.configured;
}

/** 用 GET/PUT/DELETE 的响应渲染整张卡（响应含 {byok, presets}）。 */
function renderByok(payload) {
  if (!dom.byokCard) return;
  const view = payload && typeof payload.byok === 'object' && payload.byok ? payload.byok : {};
  const presets = Array.isArray(payload?.presets) ? payload.presets : [];
  if (presets.length > 0) byokState.presets = presets;
  byokState.enabled = view.enabled === true;
  byokState.configured = view.configured === true;

  dom.byokCard.hidden = false;
  renderProviderOptions(byokState.presets);
  const configuredProvider =
    view.provider && typeof view.provider.id === 'string' ? view.provider.id : '';
  applyByokPreset(configuredProvider || byokState.presets[0]?.id || '');
  if (dom.byokProvider) dom.byokProvider.value = byokState.provider;
  if (dom.byokModel) dom.byokModel.value = typeof view.model === 'string' ? view.model : '';
  if (dom.byokApiKey) dom.byokApiKey.value = '';
  if (dom.byokBaseUrl) dom.byokBaseUrl.value = '';
  setByokCheckResult('');

  if (dom.byokStatus) {
    if (!byokState.enabled) {
      dom.byokStatus.textContent = '自定义模型已由管理员关闭。';
    } else if (byokState.configured) {
      const label =
        view.provider && typeof view.provider.label === 'string'
          ? view.provider.label
          : byokState.provider;
      dom.byokStatus.textContent = `已启用：${label} · ${String(view.model || '')}`;
    } else {
      dom.byokStatus.textContent = '未配置';
    }
  }
  if (dom.byokHint) {
    const keyHint = typeof view.keyHint === 'string' ? view.keyHint : '';
    dom.byokHint.textContent = byokState.configured && keyHint ? `已保存：${keyHint}` : '';
    dom.byokHint.hidden = !dom.byokHint.textContent;
  }
  if (dom.byokDelete) dom.byokDelete.hidden = !byokState.configured;
  setByokControlsDisabled(!byokState.enabled);
}

async function loadByok() {
  if (!dom.byokCard) return;
  try {
    renderByok(await api.request('/api/me/byok'));
  } catch (error) {
    // AUTH=off / 旧后端（404）或登录失效：整张卡优雅隐藏（旧行为不变）。
    if (error instanceof ApiError && (error.status === 404 || error.status === 401)) {
      dom.byokCard.hidden = true;
      return;
    }
    dom.byokCard.hidden = false;
    if (dom.byokStatus) dom.byokStatus.textContent = '自定义模型配置暂不可用。';
    setByokControlsDisabled(true);
    setByokError(byokErrorText(error, '自定义模型配置加载失败，请稍后重试。'));
  }
}

function onByokProviderChange() {
  applyByokPreset(dom.byokProvider ? dom.byokProvider.value : '');
  setByokError('');
  setByokCheckResult('');
}

async function onSubmitByok(event) {
  event.preventDefault();
  setByokError('');
  setByokCheckResult('');
  if (!byokState.enabled) {
    setByokError(BYOK_ERROR_LABELS.BYOK_DISABLED);
    return;
  }
  const providerId = dom.byokProvider ? dom.byokProvider.value : '';
  const preset = byokState.presets.find((item) => item.id === providerId) || null;
  const model = dom.byokModel ? dom.byokModel.value.trim() : '';
  const apiKey = dom.byokApiKey ? dom.byokApiKey.value : '';
  const baseUrl = dom.byokBaseUrl ? dom.byokBaseUrl.value.trim() : '';
  if (!preset) {
    setByokError(BYOK_ERROR_LABELS.INVALID_PROVIDER);
    return;
  }
  if (!BYOK_MODEL_PATTERN.test(model)) {
    setByokError(BYOK_ERROR_LABELS.INVALID_MODEL);
    return;
  }
  const keyLength = Array.from(apiKey).length;
  if (keyLength < 8 || keyLength > 512) {
    setByokError(BYOK_ERROR_LABELS.BYOK_KEY_INVALID);
    return;
  }
  if (preset.requiresBaseUrl === true && !isHttpsUrl(baseUrl)) {
    setByokError(BYOK_ERROR_LABELS.BYOK_URL_INVALID);
    return;
  }
  const body = { provider: preset.id, model, apiKey };
  if (preset.requiresBaseUrl === true) body.baseUrl = baseUrl;
  setBusy(dom.byokSave, true);
  if (dom.byokCheck) dom.byokCheck.disabled = true;
  try {
    renderByok(await api.request('/api/me/byok', { method: 'PUT', body }));
    if (dom.byokApiKey) dom.byokApiKey.value = '';
    if (dom.byokBaseUrl) dom.byokBaseUrl.value = '';
  } catch (error) {
    setByokError(byokErrorText(error, '保存失败，请稍后重试。'));
  } finally {
    if (dom.byokSave && dom.byokSave.dataset.busy === 'true') setBusy(dom.byokSave, false);
    if (dom.byokCheck) dom.byokCheck.disabled = !byokState.enabled || !byokState.configured;
  }
}

async function onByokCheck() {
  setByokError('');
  setByokCheckResult('');
  if (!byokState.configured) {
    setByokError('请先保存配置再测试连接。');
    return;
  }
  setBusy(dom.byokCheck, true);
  try {
    const result = await api.request('/api/me/byok/check', { method: 'POST' });
    if (result && result.ok === true) {
      const count = Number(result.modelCount);
      const latency = Number(result.latencyMs);
      const parts = [];
      if (Number.isFinite(count)) parts.push(`${formatInt(count)} 个模型`);
      if (Number.isFinite(latency)) parts.push(`耗时 ${formatInt(latency)}ms`);
      setByokCheckResult(`连接成功${parts.length > 0 ? `（${parts.join('，')}）` : ''}。`);
    } else {
      const code = typeof result?.errorCode === 'string' ? result.errorCode : '';
      setByokError(BYOK_ERROR_LABELS[code] || BYOK_ERROR_LABELS.BYOK_CHECK_FAILED);
    }
  } catch (error) {
    setByokError(byokErrorText(error, BYOK_ERROR_LABELS.BYOK_CHECK_FAILED));
  } finally {
    if (dom.byokCheck && dom.byokCheck.dataset.busy === 'true') setBusy(dom.byokCheck, false);
    if (dom.byokCheck) dom.byokCheck.disabled = !byokState.enabled || !byokState.configured;
  }
}

async function onByokDelete() {
  setByokError('');
  setByokCheckResult('');
  if (!byokState.configured) return;
  const confirmed = window.confirm('确定删除自定义模型配置吗？删除后对话将回到官方模型。');
  if (!confirmed) return;
  setBusy(dom.byokDelete, true);
  try {
    renderByok(await api.request('/api/me/byok', { method: 'DELETE' }));
    setByokCheckResult('已删除自定义模型配置。');
  } catch (error) {
    setByokError(byokErrorText(error, '删除失败，请稍后重试。'));
  } finally {
    if (dom.byokDelete && dom.byokDelete.dataset.busy === 'true') setBusy(dom.byokDelete, false);
    if (dom.byokDelete) dom.byokDelete.hidden = !byokState.configured;
    if (dom.byokDelete) dom.byokDelete.disabled = !byokState.configured;
  }
}

function renderUser(user) {
  if (dom.accountUsername) dom.accountUsername.textContent = String(user.username || '—');
  if (dom.accountRole) dom.accountRole.textContent = ROLE_LABELS[user.role] || '成员';
  if (dom.displayName) dom.displayName.value = String(user.displayName || '');
}

/** 用量视图：今日 / 30 天 tokens、估算消费、缓存命中率、配额进度。 */
function renderUsage(payload) {
  if (!dom.usageStats) return;
  const totals = payload?.totals && typeof payload.totals === 'object' ? payload.totals : {};
  const series = Array.isArray(payload?.series) ? payload.series : [];
  const quota = payload?.quota && typeof payload.quota === 'object' ? payload.quota : null;
  const lastRow = series.length > 0 ? series[series.length - 1] : null;
  const todayTokens = Number(lastRow?.tokens);
  const monthTokens = series.reduce((sum, row) => {
    const value = Number(row?.tokens);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  const grid = document.createElement('dl');
  grid.className = 'usage-grid';
  const addStat = (label, value) => {
    const item = document.createElement('div');
    item.className = 'usage-stat';
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    item.append(term, detail);
    grid.append(item);
  };
  addStat('今日 tokens', formatInt(todayTokens));
  addStat('30 天 tokens', formatInt(totals.tokens));
  addStat('估算消费', formatCost(totals.costUsd));
  addStat('缓存命中率', formatRate(totals.cacheHitRate));
  addStat('请求数', formatInt(totals.requests));

  const nodes = [grid];
  if (quota) {
    const dayLimit = Number(quota.dayTokens);
    const monthLimit = Number(quota.monthTokens);
    const bars = document.createElement('div');
    bars.className = 'quota-list';
    if (Number.isFinite(dayLimit) && dayLimit > 0) {
      bars.append(quotaRow('今日配额', todayTokens, dayLimit));
    }
    if (Number.isFinite(monthLimit) && monthLimit > 0) {
      bars.append(quotaRow('30 天配额', monthTokens, monthLimit));
    }
    if (bars.childNodes.length > 0) nodes.push(bars);
    else nodes.push(hint('当前账号未设置 token 配额上限。'));
  } else {
    nodes.push(hint('当前账号未设置 token 配额上限。'));
  }
  dom.usageStats.replaceChildren(...nodes);
}

function hint(text) {
  const node = document.createElement('p');
  node.className = 'form-hint';
  node.textContent = text;
  return node;
}

function quotaRow(labelText, usedTokens, limitTokens) {
  const row = document.createElement('div');
  row.className = 'quota-row';
  const label = document.createElement('span');
  label.className = 'quota-label';
  label.textContent = labelText;
  const bar = document.createElement('progress');
  bar.className = 'quota-bar';
  bar.max = limitTokens;
  bar.value = Math.min(Math.max(Number(usedTokens) || 0, 0), limitTokens);
  const value = document.createElement('span');
  value.className = 'quota-value';
  value.textContent = `${formatInt(usedTokens)} / ${formatInt(limitTokens)}`;
  row.append(label, bar, value);
  return row;
}

/** 我的反馈（只读）：正文 + 时间 + 状态 + 管理员回复。 */
function renderFeedback(entries) {
  if (!dom.feedbackList) return;
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    dom.feedbackList.replaceChildren(hint('还没有提交过反馈。'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of list.slice(0, 20)) {
    const item = document.createElement('article');
    item.className = 'feedback-item';
    const body = document.createElement('p');
    body.className = 'feedback-body';
    body.textContent = String(entry?.body || '');
    const meta = document.createElement('p');
    meta.className = 'feedback-meta';
    meta.textContent = [
      formatRelativeTime(entry?.createdAt),
      entry?.status === 'resolved' ? '已处理' : '待处理',
    ]
      .filter(Boolean)
      .join(' · ');
    item.append(body, meta);
    if (entry?.reply) {
      const reply = document.createElement('p');
      reply.className = 'feedback-reply';
      reply.textContent = `回复：${String(entry.reply)}`;
      item.append(reply);
    }
    fragment.append(item);
  }
  dom.feedbackList.replaceChildren(fragment);
}

async function loadUsage() {
  try {
    renderUsage(await api.getMyUsage({ days: 30 }));
  } catch (error) {
    if (dom.usageStats) dom.usageStats.replaceChildren(hint('用量暂不可用。'));
    if (!(error instanceof ApiError && error.status === 401)) {
      showError(errorText(error, '用量加载失败，请稍后重试。'));
    }
  }
}

async function loadFeedback() {
  try {
    renderFeedback(await api.getMyFeedback());
  } catch (error) {
    if (dom.feedbackList) dom.feedbackList.replaceChildren(hint('反馈暂不可用。'));
  }
}

async function onSubmitProfile(event) {
  event.preventDefault();
  const displayName = dom.displayName ? dom.displayName.value.trim() : '';
  showError('');
  setBusy(dom.saveProfile, true);
  try {
    const payload = await api.updateMe({ displayName });
    if (payload?.user) renderUser(payload.user);
    showStatus(dom.profileStatus, '已保存。');
  } catch (error) {
    showStatus(dom.profileStatus, '');
    showError(errorText(error, '保存失败，请稍后重试。'));
  } finally {
    setBusy(dom.saveProfile, false);
  }
}

async function onSubmitPassword(event) {
  event.preventDefault();
  const oldPassword = dom.oldPassword ? dom.oldPassword.value : '';
  const newPassword = dom.newPassword ? dom.newPassword.value : '';
  showError('');
  if (!oldPassword || !newPassword) {
    showError('请填写当前密码和新密码。');
    return;
  }
  if (newPassword.length < 8) {
    showError('新密码至少 8 位。');
    return;
  }
  setBusy(dom.savePassword, true);
  try {
    await api.updateMe({ oldPassword, newPassword });
    if (dom.oldPassword) dom.oldPassword.value = '';
    if (dom.newPassword) dom.newPassword.value = '';
    showStatus(dom.passwordStatus, '密码已更新。');
  } catch (error) {
    showStatus(dom.passwordStatus, '');
    showError(errorText(error, '密码更新失败，请稍后重试。'));
  } finally {
    setBusy(dom.savePassword, false);
  }
}

async function onLogout() {
  showError('');
  setBusy(dom.logoutBtn, true);
  try {
    await api.logout();
  } catch {
    /* 已过期也算退出成功：直接回登录页。 */
  } finally {
    window.location.replace('/login.html');
  }
}

/* ==========================================================================
   数据与账号（导出我的数据 / 注销账号）
   - 导出：GET /api/me/export → Blob 下载；文件名优先取 content-disposition，否则自拼。
   - 注销：密码 + 用户名二次确认 → DELETE /api/me {password}；204 成功后回登录页。
   - 全部 DOM 用 textContent，密码只从输入框单向提交，不写本地存储。
   ========================================================================== */

/** 本地日期 YYYYMMDD（导出文件名兜底用）。 */
function fileStamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 从 content-disposition 解析文件名（兼容 filename*=UTF-8'' 形式），失败返回 ''。 */
function filenameFromDisposition(value) {
  if (typeof value !== 'string' || !value) return '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(value);
  if (!match) return '';
  const raw = match[1].trim();
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function onExportData() {
  showError('');
  showStatus(dom.dataStatus, '正在准备导出…');
  setBusy(dom.exportDataBtn, true);
  try {
    const response = await window.fetch('/api/me/export', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      let code = '';
      try {
        const payload = await response.json();
        code = payload?.error?.code || '';
      } catch {
        /* 非 JSON 错误体：保留空 code */
      }
      throw new ApiError('导出失败', { status: response.status, code });
    }
    const blob = await response.blob();
    const dispositionName = filenameFromDisposition(
      response.headers.get('content-disposition') || '',
    );
    downloadBlob(blob, dispositionName || `ctf-export-${fileStamp()}.json`);
    showStatus(dom.dataStatus, '已开始下载，请查看浏览器下载列表。');
  } catch (error) {
    showStatus(dom.dataStatus, '');
    showError(errorText(error, '导出失败，请稍后重试。'));
  } finally {
    setBusy(dom.exportDataBtn, false);
  }
}

function setDeleteError(message) {
  if (!dom.deleteError) return;
  dom.deleteError.textContent = message || '';
  dom.deleteError.hidden = !message;
}

async function onDeleteAccount() {
  showError('');
  setDeleteError('');
  const password = dom.deletePassword ? dom.deletePassword.value : '';
  const username = dom.deleteUsername ? dom.deleteUsername.value.trim() : '';
  const expected = String(currentUser?.username || dom.accountUsername?.textContent || '').trim();
  if (!password || !username) {
    setDeleteError('请填写密码并输入用户名确认。');
    return;
  }
  if (expected && username !== expected) {
    setDeleteError('输入的用户名与当前账号不一致。');
    return;
  }
  const confirmed = window.confirm('注销后账号与数据会被删除且无法恢复，确定继续吗？');
  if (!confirmed) return;
  setBusy(dom.deleteAccountBtn, true);
  try {
    await api.request('/api/me', { method: 'DELETE', body: { password } });
    window.location.replace('/login.html');
  } catch (error) {
    const labels = {
      PASSWORD_INVALID: '密码不正确。',
      LAST_ADMIN: '最后一位管理员不能注销；请先指定另一位管理员。',
    };
    const text =
      error instanceof ApiError && labels[error.code]
        ? labels[error.code]
        : errorText(error, '注销失败，请稍后重试。');
    setDeleteError(text);
  } finally {
    setBusy(dom.deleteAccountBtn, false);
  }
}

/** 登录门禁：返回 publicUser；AUTH=off/401/网络错误时跳转并返回 null。 */
async function requireAuth() {
  try {
    const payload = await api.getAuthMe();
    if (payload?.auth === 'on' && payload.user) return payload.user;
    window.location.replace('/');
    return null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      window.location.replace(loginUrlFor(window.location));
      return null;
    }
    window.location.replace('/');
    return null;
  }
}

async function boot() {
  const user = await requireAuth();
  if (!user) return;
  currentUser = user;
  renderUser(user);
  await Promise.allSettled([loadUsage(), loadFeedback(), loadByok()]);
}

if (dom.profileForm) dom.profileForm.addEventListener('submit', onSubmitProfile);
if (dom.passwordForm) dom.passwordForm.addEventListener('submit', onSubmitPassword);
if (dom.logoutBtn) dom.logoutBtn.addEventListener('click', onLogout);
if (dom.exportDataBtn) dom.exportDataBtn.addEventListener('click', onExportData);
if (dom.deleteAccountBtn) dom.deleteAccountBtn.addEventListener('click', onDeleteAccount);
// 自定义模型（BYOK）
if (dom.byokForm) dom.byokForm.addEventListener('submit', onSubmitByok);
if (dom.byokProvider) dom.byokProvider.addEventListener('change', onByokProviderChange);
if (dom.byokCheck) dom.byokCheck.addEventListener('click', onByokCheck);
if (dom.byokDelete) dom.byokDelete.addEventListener('click', onByokDelete);

boot();
