// 中文分词与归一化：Intl.Segmenter('zh', {granularity:'word'})，零依赖。
// index.mjs 与 tests/rag/ 共用本模块，保证「索引用的分词」和「测试断言的排序」是同一套。

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

// 高频功能词：去掉后 BM25 的 IDF 更有区分度（不丢实词，如「死」「怕」保留）。
const STOPWORDS = new Set([
  // 中文功能词
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '您',
  '我们', '你们', '他们', '她们', '咱们', '自己',
  '这', '那', '这个', '那个', '这些', '那些', '这样', '那样', '这里', '那里',
  '一个', '一种', '一些', '一点', '一下',
  '和', '与', '及', '或', '或者', '而', '而且', '但', '但是', '不过',
  '就', '都', '也', '很', '太', '更', '最', '还', '还是', '又', '再',
  '不', '没', '没有', '无', '有', '着', '过', '地', '得', '似的',
  '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '哈', '嘛',
  '什么', '怎么', '为什么', '如何', '怎样', '多少',
  '可以', '能', '会', '要', '想', '说', '做', '让', '把', '被', '给',
  '对', '从', '到', '向', '于', '为', '以', '因', '所以', '因为',
  '如果', '虽然', '但是', '然后', '于是', '并且', '以及', '还有',
  '就是', '只是', '只是', '其实', '真的', '非常', '有点', '一直',
  '时候', '现在', '最近', '今天', '昨天', '明天', '时候',
  '感觉', '觉得', '知道', '认为', '希望', '需要',
  '事情', '东西', '地方', '方面', '问题',
  // 英文功能词
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'my', 'your',
  'that', 'this', 'with', 'for', 'as', 'not', 'have', 'has', 'had',
  'do', 'does', 'did', 'so', 'if', 'then', 'than', 'too', 'very',
  'can', 'could', 'would', 'should', 'will', 'just', 'about', 'from'
]);

/** 全半角 / 大小写归一（NFKC + lower）。 */
export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase();
}

/** 分词：返回去停用词后的词数组（保留原始顺序与重复，便于统计词频）。 */
export function tokenize(text) {
  const normalized = normalize(text);
  const tokens = [];
  for (const part of segmenter.segment(normalized)) {
    if (!part.isWordLike) continue;
    const word = part.segment.trim();
    if (!word) continue;
    if (STOPWORDS.has(word)) continue;
    tokens.push(word);
  }
  return tokens;
}

/** 统计词频。 */
export function termFrequency(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

// ---- 中文 bigram（T18b 增强检索） ----
// 目的：Intl.Segmenter 对未登录词/口语常切成单字（如「睡不着」→ 睡/不/着，其中「不/着」还会被停用词过滤），
// 只靠 unigram 会丢失词形；把相邻汉字两两组成 bigram 作为补充词项，可提升短查询与未登录词召回。
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export { CJK_CHAR_RE };

/** 判断字符串是否含汉字（用于测试与扩展词过滤）。 */
export function hasCJK(text) {
  return CJK_CHAR_RE.test(String(text ?? ''));
}

/**
 * 提取中文 bigram（只取连续汉字片段内的相邻两字，不跨标点/空格/英文）。
 * @param {string} text
 * @returns {string[]} 按出现顺序、保留重复的 bigram 数组（过滤停用词 bigram）
 */
export function cjkBigrams(text) {
  const normalized = normalize(text);
  const out = [];
  let run = '';
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (STOPWORDS.has(bigram)) continue;
      out.push(bigram);
    }
    run = '';
  };
  for (const char of normalized) {
    if (CJK_CHAR_RE.test(char)) run += char;
    else flush();
  }
  flush();
  return out;
}

export { STOPWORDS };
