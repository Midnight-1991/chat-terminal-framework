// reader-notice.js — 阅读器顶部固定免责横幅（前端常量）。
//
// 语料许可口径见 docs/DATA-CONTRACT.md 1 白名单：
// - 演示内容许可（原文摘录）：书籍原文摘录，必须提示个人使用与非医疗建议；
// - Public Domain / 政府公开：公版或政府公开文本，仅提示个人学习参考。
// 文案只存在于前端，不写入 corpus、不改 DATA-CONTRACT（T28b 要求）。

export const READER_NOTICE_COPYRIGHT =
  '示例内容 · LicenseRef-Synthetic-Fixture · 非医疗建议；专业问题请咨询医生或专业人士';

export const READER_NOTICE_PUBLIC = '公版 / 政府公开文本 · 仅个人学习参考';

// 第 4 类许可（docs/DATA-CONTRACT.md 12）：模板卡来自外部示例站点，
// 站点条款为免费个人使用；12 明确要求模板卡同样显示「非医疗建议」。
export const READER_NOTICE_WORKSHEET =
  '示例内容 · LicenseRef-Synthetic-Fixture · 非医疗建议；专业问题请咨询医生或专业人士';

export const READER_COPYRIGHT_LICENSE = '演示内容许可（原文摘录）';

export const READER_WORKSHEET_LICENSE = '演示内容许可（模板卡）';

export const READER_PUBLIC_LICENSES = ['Public Domain', '政府公开'];

/** 依据 doc.license 返回阅读器免责横幅文案；无法判定时返回空串（不渲染横幅）。 */
export function readerNoticeFor(license) {
  const value = typeof license === 'string' ? license.trim() : '';
  if (value === READER_COPYRIGHT_LICENSE) return READER_NOTICE_COPYRIGHT;
  if (value === READER_WORKSHEET_LICENSE) return READER_NOTICE_WORKSHEET;
  if (READER_PUBLIC_LICENSES.includes(value)) return READER_NOTICE_PUBLIC;
  return '';
}
