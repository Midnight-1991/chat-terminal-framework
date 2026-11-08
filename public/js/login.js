// login.js — 登录 / 邀请码注册页（AUTH=on 多用户）。
//
// 行为（对齐接口契约 2.4）：
// - 已登录（GET /api/auth/me → {auth:'on'}）→ 回跳 next（仅站内路径）或首页；
// - AUTH=off（{auth:'off'}）→ 直接回首页，保持旧单用户行为；
// - AUTH=on 未登录（401）→ 留在本页，服务端同时下发 csrf Cookie 供表单提交；
// - 旧后端 404 / 网络错误 → 回首页（不让用户卡在登录页）。
//
// 用户数据只用 textContent 渲染；错误提示不拼 HTML。

import { ApiError, createApi, safeNextPath } from './api.js';

const api = createApi({ fetchImpl: (...args) => window.fetch(...args) });
const $ = (id) => document.getElementById(id);

const dom = {
  loginBack: $('loginBack'),
  loginTitle: $('loginTitle'),
  loginForm: $('loginForm'),
  loginUsername: $('loginUsername'),
  loginPassword: $('loginPassword'),
  loginSubmit: $('loginSubmit'),
  loginError: $('loginError'),
  loginModeToggle: $('loginModeToggle'),
  registerForm: $('registerForm'),
  registerCode: $('registerCode'),
  registerUsername: $('registerUsername'),
  registerPassword: $('registerPassword'),
  registerSubmit: $('registerSubmit'),
  registerConsent: $('registerConsent'),
  registerError: $('registerError'),
};

const params = new URLSearchParams(window.location.search);
const inviteCode = (params.get('invite') || '').trim();
const nextPath = (() => {
  const candidate = safeNextPath(params.get('next') || '') || '/';
  return candidate.startsWith('/login') ? '/' : candidate;
})();

function go(path) {
  window.location.replace(path || '/');
}

function showError(node, message) {
  node.textContent = message || '';
  node.hidden = !message;
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.busy = busy ? 'true' : 'false';
}

function errorText(error, fallback) {
  if (!(error instanceof ApiError)) return fallback;
  const labels = {
    LOGIN_FAILED: '用户名或密码不正确。',
    ACCOUNT_BANNED: '这个账号已被停用，请联系管理员。',
    LOGIN_RATE_LIMITED: '尝试次数太多，请稍后再试。',
    INVALID_INPUT: '请检查填写的内容。',
    INVITE_INVALID: '邀请码无效或已失效。',
    INVITE_EXPIRED: '邀请码已过期，请联系管理员重新获取。',
    INVITE_USED: '邀请码已被使用，请联系管理员重新获取。',
    USER_EXISTS: '这个用户名已被占用。',
    REGISTER_CLOSED: '注册暂未开放。',
    ACCOUNT_DELETED: '这个账号已注销，无法再登录。',
    CONSENT_REQUIRED: '请先阅读并同意《用户协议》与《隐私政策》。',
    NETWORK: '网络中断或服务未启动。',
  };
  return labels[error.code] || fallback;
}

function setMode(mode) {
  const register = mode === 'register';
  if (dom.loginForm) dom.loginForm.hidden = register;
  if (dom.registerForm) dom.registerForm.hidden = !register;
  if (dom.loginTitle) dom.loginTitle.textContent = register ? '注册' : '登录';
  if (dom.loginModeToggle) {
    dom.loginModeToggle.textContent = register ? '已有账号，去登录' : '用邀请码注册';
    dom.loginModeToggle.setAttribute('aria-expanded', String(register));
  }
  showError(register ? dom.loginError : dom.registerError, '');
}

async function onSubmitLogin(event) {
  event.preventDefault();
  const username = dom.loginUsername.value.trim();
  const password = dom.loginPassword.value;
  if (!username || !password) {
    showError(dom.loginError, '请填写用户名和密码。');
    return;
  }
  showError(dom.loginError, '');
  setBusy(dom.loginSubmit, true);
  try {
    await api.login({ username, password });
    go(nextPath);
  } catch (error) {
    showError(dom.loginError, errorText(error, '登录失败，请稍后再试。'));
  } finally {
    setBusy(dom.loginSubmit, false);
  }
}

async function onSubmitRegister(event) {
  event.preventDefault();
  const code = dom.registerCode.value.trim() || inviteCode;
  const username = dom.registerUsername.value.trim();
  const password = dom.registerPassword.value;
  if (!code) {
    showError(dom.registerError, '请填写邀请码。');
    return;
  }
  if (username.length < 3 || username.length > 32) {
    showError(dom.registerError, '用户名需为 3–32 个字符。');
    return;
  }
  if (password.length < 8) {
    showError(dom.registerError, '密码至少 8 位。');
    return;
  }
  // 注册必须同意《用户协议》与《隐私政策》（后端另做 CONSENT_REQUIRED 兜底）。
  if (!dom.registerConsent || !dom.registerConsent.checked) {
    showError(dom.registerError, '请先阅读并同意《用户协议》与《隐私政策》。');
    return;
  }
  showError(dom.registerError, '');
  setBusy(dom.registerSubmit, true);
  try {
    // 直接走 api.request：注册体需带 acceptTerms:true（api.register 为 冻结签名，不扩展）。
    await api.request('/api/auth/register', {
      method: 'POST',
      body: { inviteCode: code, username, password, acceptTerms: true },
    });
    go(nextPath);
  } catch (error) {
    showError(dom.registerError, errorText(error, '注册失败，请稍后再试。'));
  } finally {
    setBusy(dom.registerSubmit, false);
  }
}

/** 启动：已登录回跳；AUTH=off 回首页；401 留在登录页。 */
async function boot() {
  if (dom.loginBack && nextPath !== '/') dom.loginBack.href = nextPath;
  if (inviteCode) {
    dom.registerCode.value = inviteCode;
    setMode('register');
  }
  try {
    const payload = await api.getAuthMe();
    if (payload?.auth === 'on') {
      go(nextPath);
      return;
    }
    // AUTH=off：保持旧单用户行为，直接回到原来要去的页面。
    go(nextPath);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // AUTH=on 未登录：正常停在登录页（csrf Cookie 已由 401 响应下发）。
      dom.loginUsername.focus({ preventScroll: true });
      return;
    }
    // 旧后端没有 /api/auth/me（404）或服务不可达：回 next/首页，不让用户卡在登录页。
    go(nextPath);
  }
}

if (dom.loginForm) dom.loginForm.addEventListener('submit', onSubmitLogin);
if (dom.registerForm) dom.registerForm.addEventListener('submit', onSubmitRegister);
if (dom.loginModeToggle) {
  dom.loginModeToggle.addEventListener('click', () => {
    const register = !dom.registerForm || dom.registerForm.hidden;
    setMode(register ? 'register' : 'login');
    const focusTarget = register ? dom.registerCode : dom.loginUsername;
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  });
}

boot();
