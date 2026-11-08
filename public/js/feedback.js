// feedback.js — 反馈页：提交反馈 / 查看我的反馈（AUTH=on 多用户）。
//
// 契约（2.4）：
// - POST /api/feedback { body, allowContext, conversationId? }，body 1–2000 字符（按 Array.from 计）；
// - GET /api/me/feedback → { feedback: [...] }（只返回本人）；
// - 关联会话从 GET /api/conversations 取最近 10 条。
// 用户数据只用 textContent / DOM 节点渲染，不拼 innerHTML。

import { ApiError, createApi, formatRelativeTime, loginUrlFor } from './api.js';

const api = createApi({ fetchImpl: (...args) => window.fetch(...args) });
const $ = (id) => document.getElementById(id);

const BODY_MAX = 2000;
const CONVERSATION_LIMIT = 10;

const dom = {
  feedbackForm: $('feedbackForm'),
  feedbackBody: $('feedbackBody'),
  feedbackCount: $('feedbackCount'),
  allowContext: $('allowContext'),
  conversationSelect: $('conversationSelect'),
  feedbackSubmit: $('feedbackSubmit'),
  feedbackError: $('feedbackError'),
  feedbackStatus: $('feedbackStatus'),
  myFeedbackList: $('myFeedbackList'),
};

function charLength(value) {
  return Array.from(typeof value === 'string' ? value : '').length;
}

function updateCount() {
  const length = charLength(dom.feedbackBody ? dom.feedbackBody.value : '');
  if (dom.feedbackCount) {
    dom.feedbackCount.textContent = `${length} / ${BODY_MAX}`;
    dom.feedbackCount.classList.toggle('is-near', length > BODY_MAX - 100);
  }
}

function showError(message) {
  if (!dom.feedbackError) return;
  dom.feedbackError.textContent = message || '';
  dom.feedbackError.hidden = !message;
}

function showStatus(message) {
  if (!dom.feedbackStatus) return;
  dom.feedbackStatus.textContent = message || '';
  dom.feedbackStatus.hidden = !message;
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.dataset.busy = busy ? 'true' : 'false';
}

function errorText(error, fallback) {
  if (!(error instanceof ApiError)) return fallback;
  const labels = {
    INVALID_INPUT: '反馈内容需为 1–2000 个字符。',
    UNAUTHORIZED: '登录已失效，请重新登录。',
    NETWORK: '网络中断或服务未启动。',
  };
  return labels[error.code] || fallback;
}

function hint(text) {
  const node = document.createElement('p');
  node.className = 'form-hint';
  node.textContent = text;
  return node;
}

/** 我的反馈（只读）：正文 + 时间 + 状态 + 管理员回复。 */
function renderFeedback(entries) {
  if (!dom.myFeedbackList) return;
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    dom.myFeedbackList.replaceChildren(hint('还没有提交过反馈。'));
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
  dom.myFeedbackList.replaceChildren(fragment);
}

async function loadFeedback() {
  try {
    renderFeedback(await api.getMyFeedback());
  } catch (error) {
    if (dom.myFeedbackList) dom.myFeedbackList.replaceChildren(hint('反馈暂不可用。'));
  }
}

/** 关联会话下拉：GET /api/conversations 取最近 10 条（失败则保持「不关联」）。 */
async function loadConversations() {
  if (!dom.conversationSelect) return;
  try {
    const conversations = await api.listConversations();
    const items = Array.isArray(conversations) ? conversations.slice(0, CONVERSATION_LIMIT) : [];
    const fragment = document.createDocumentFragment();
    for (const conversation of items) {
      if (!conversation || typeof conversation.id !== 'string' || !conversation.id) continue;
      const option = document.createElement('option');
      option.value = conversation.id;
      option.textContent = String(conversation.title || '未命名会话');
      fragment.append(option);
    }
    dom.conversationSelect.append(fragment);
  } catch {
    /* 旧后端 / 会话接口不可用：只保留「不关联会话」，不阻塞反馈提交。 */
  }
}

async function onSubmitFeedback(event) {
  event.preventDefault();
  const body = dom.feedbackBody ? dom.feedbackBody.value.trim() : '';
  const length = charLength(body);
  showError('');
  showStatus('');
  if (length < 1) {
    showError('请写点什么再提交。');
    return;
  }
  if (length > BODY_MAX) {
    showError(`反馈内容最多 ${BODY_MAX} 个字符。`);
    return;
  }
  const conversationId = dom.conversationSelect && dom.conversationSelect.value
    ? dom.conversationSelect.value
    : undefined;
  setBusy(dom.feedbackSubmit, true);
  try {
    await api.submitFeedback({
      body,
      allowContext: dom.allowContext ? dom.allowContext.checked : false,
      conversationId,
    });
    if (dom.feedbackBody) dom.feedbackBody.value = '';
    if (dom.allowContext) dom.allowContext.checked = false;
    if (dom.conversationSelect) dom.conversationSelect.value = '';
    updateCount();
    showStatus('已提交，谢谢你的反馈。');
    await loadFeedback();
  } catch (error) {
    showError(errorText(error, '提交失败，请稍后再试。'));
  } finally {
    setBusy(dom.feedbackSubmit, false);
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
  updateCount();
  await Promise.allSettled([loadConversations(), loadFeedback()]);
}

if (dom.feedbackForm) dom.feedbackForm.addEventListener('submit', onSubmitFeedback);
if (dom.feedbackBody) dom.feedbackBody.addEventListener('input', updateCount);

boot();
