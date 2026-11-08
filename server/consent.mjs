//  / 用户协议与隐私政策同意（consent）的冻结契约。
// 记录形状：users.json 中 `consent: { version, at }`；本模块只负责版本常量与对外视图，
// 不读写磁盘（持久化在 users.mjs 的 setConsent）。
export const CONSENT_VERSION = '2026-11-01';
export const CONSENT_DOCS = Object.freeze(['terms', 'privacy']);

/**
 * 同意记录的对外视图：`{ version, at, current }`；无记录（或记录损坏）返回 null。
 * current=false 表示用户同意过旧版本条款，前端应提示重新签署。
 * @param {{consent?: {version?:string, at?:string}|null}|null} user
 * @returns {{version:string, at:string, current:boolean}|null}
 */
export function consentView(user) {
  const consent = user?.consent;
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)) return null;
  const version = typeof consent.version === 'string' && consent.version ? consent.version : null;
  const at = typeof consent.at === 'string' && consent.at ? consent.at : null;
  if (!version || !at) return null;
  return { version, at, current: version === CONSENT_VERSION };
}
