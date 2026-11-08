// CHAT_MOCK=1 的本地假流：不调上游，思考 1–3 段 + 固定中文正文 + usage。
// meta.citations 仍取真实检索结果（由 chat 主流程注入）。
import { setTimeout as sleep } from 'node:timers/promises';
import { ClientAbortError } from './upstream.mjs';

export const MOCK_THINKING_SEGMENTS = Object.freeze([
  '先分辨：这是情境性的孤独，还是长时间的结构性孤独。两者需要的回应不同。',
  '不要急着安慰，也不要布道。给一个今晚就能做的动作，再留一个更长的方向。',
]);

const MOCK_BODY = Object.freeze([
  '孤独不是需要立刻被修好的故障。它更像一个信号：你需要真实的人，而不只是被理解的感觉。',
  '夜里翻上来的旧事，多半不是判决，而是还没有被你说完的话。先把它们写下来，不必急着解释。',
  '今晚先做一件小事：给一个你信得过的人发一句话，说你现在不太好。不用长篇，也不用解释。',
  '如果这样的夜持续了两周以上，或者你开始怀疑活着的意义，请告诉身边的人，并联系专业帮助。你不需要独自扛着。',
]);

function answerWithMarkers(segmentIndex, citations) {
  const markers = [];
  if (citations.length >= 1) markers.push('[[c1]]');
  if (citations.length >= 2) markers.push('[[c2]]');
  if (markers.length === 0) return '';
  if (segmentIndex === 0) {
    return `资料里有一段说法可以直接对上${markers[0]}。但它不是判决，只是把你此刻的处境说得更清楚。`;
  }
  if (segmentIndex === 2 && markers[1]) {
    return `${markers[1]}说的也是同一件事：你不是坏了，你是在承受。`;
  }
  return '';
}

/** 生成固定中文回答（如本轮有引用则含合法的 [[cN]]，否则不出引用标记）。 */
export function buildMockAnswer(citations = []) {
  const paragraphs = MOCK_BODY.map((text, index) => {
    const extra = answerWithMarkers(index, citations);
    return extra ? `${text}\n${extra}` : text;
  });
  if (citations.length === 0) {
    paragraphs.unshift('资料里没有直接对应的条目，我只能说到能确定的程度。');
  }
  return paragraphs.join('\n\n');
}

function splitByCodePoints(text, chunkSize) {
  const chars = Array.from(text);
  const chunks = [];
  for (let index = 0; index < chars.length; index += chunkSize) {
    chunks.push(chars.slice(index, index + chunkSize).join(''));
  }
  return chunks;
}

function estimateUsage({ message, citations, answer }) {
  const evidenceChars = citations.reduce((sum, citation) => sum + (citation.text?.length ?? 0), 0);
  return {
    inputTokens: Math.max(1, Math.ceil((message.length + evidenceChars) / 3)),
    outputTokens: Math.max(1, Math.ceil(answer.length / 2)),
    cacheReadInputTokens: 0,
  };
}

/**
 * 播放 mock 流。Return {aborted:true} 表示客户端中途断开。
 * @param {{
 *   write:(event:string,data:object)=>Promise<boolean>,
 *   citations:Array<object>, message:string, effort:string,
 *   delayMs?:number, isAborted:()=>boolean,
 * }} opts
 */
export async function runMockStream({
  write,
  citations,
  message,
  effort,
  delayMs = 8,
  isAborted = () => false,
}) {
  const think = effort !== 'off';
  const answer = buildMockAnswer(citations);
  const usage = estimateUsage({ message, citations, answer });
  // 小工具：可选停顿；一旦客户端断开立刻返回 false。
  const pause = async () => {
    if (isAborted()) return false;
    if (delayMs > 0) await sleep(delayMs);
    return !isAborted();
  };

  if (think) {
    for (const segment of MOCK_THINKING_SEGMENTS.slice(0, Math.max(1, effort === 'max' ? 3 : 2))) {
      if (!(await pause())) return { aborted: true };
      const ok = await write('thinking_delta', { text: segment });
      if (!ok) return { aborted: true };
    }
  }

  let text = '';
  for (const chunk of splitByCodePoints(answer, 12)) {
    if (!(await pause())) return { aborted: true };
    text += chunk;
    const ok = await write('text_delta', { text: chunk });
    if (!ok) return { aborted: true };
  }

  return { aborted: false, text, stopReason: 'end_turn', usage };
}
