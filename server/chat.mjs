// POST /api/chat：校验 → 会话（持久化）→ 检索 → 记忆注入 → meta → 上游流式透传 → done / error。
// v2 契约：docs/API-CONTRACT.md 1/2/3；会话 & 记忆见 5/6。
// attachments 先经 flash 解析成摘要，正文仍由 deepseek-v4-pro 生成。
import { EFFORTS, resolveMaxTokens } from './config.mjs';
import { HttpError, readJsonBody, sendApiError, sendJson } from './http-utils.mjs';
import { normalizeUsage } from './usage.mjs';
import { retrieveCitations, publicCitations } from './citations.mjs';
import { startSSE, writeSSE, endSSE } from './sse.mjs';
import { runMockStream } from './mock.mjs';
import { historyToMessages, streamUpstream, UpstreamFailure, ClientAbortError } from './upstream.mjs';
import {
  buildTurnText,
  citationProvenanceTag,
  formatAttachmentBlock,
  MAX_EVIDENCE_CHUNK_CHARS,
  MAX_EVIDENCE_CHUNKS,
  MAX_EVIDENCE_TOTAL_CHARS,
} from './prompts.mjs';
import { persistAttachmentImages } from './attachments.mjs';
// ..BYOK 自定义模型（来源解析 + 上游流式分支）。
import { redactSecrets, resolveChatModelSource } from './byok.mjs';
// 官方模型峰谷策略（PEAK_MODEL_POLICY=off|auto）。
import { resolveOfficialModel } from './model-policy.mjs';
import { ByokUpstreamFailure, streamByokUpstream } from './byok-upstream.mjs';
import {
  AttachmentError,
  normalizeAttachments,
  parseAttachments,
  persistedAttachmentMeta,
  publicAttachmentMeta,
} from './vision.mjs';

/**
 * 请求体上限：附件（3 张 ≤4MB 图片 base64 后约 16MB + 1 个 ≤100KB 文本 + JSON 包装）留余量。
 * 没有附件的老客户端与旧上限行为一致（正常消息远小于此值）。
 */
const CHAT_BODY_LIMIT = 20 * 1024 * 1024;
/** 拼进上游 messages 的历史轮数上限（与 sessions.MAX_ROUNDS 对齐：12 轮 = 24 条）。 */
export const MAX_HISTORY_MESSAGES = 24;
export const MEMORY_MODES = Object.freeze(['on', 'off']);
/** webSearch 请求体取值（缺省/空 = off；其它 400）。 */
export const WEBSEARCH_MODES = Object.freeze(['on', 'off']);

function validateChatPayload(payload, config) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '请求体必须是 JSON 对象' };
  }
  const { message, effort, sessionId, conversationId, memory, webSearch } = payload;
  if (typeof message !== 'string') return { error: 'message 必填，且必须是字符串' };
  if (message.trim().length === 0) return { error: 'message 不能为空' };
  if (message.length > 4000) return { error: 'message 长度不能超过 4000 字符' };

  let resolvedEffort = config.defaultEffort;
  if (effort !== undefined && effort !== null && effort !== '') {
    if (typeof effort !== 'string' || !EFFORTS.includes(effort)) {
      return { error: `effort 必须是 ${EFFORTS.join('|')} 之一` };
    }
    resolvedEffort = effort;
  }

  let resolvedSessionId;
  if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
      return { error: 'sessionId 格式不合法（1–64 位字母/数字/-/_）' };
    }
    resolvedSessionId = sessionId;
  }

  let resolvedConversationId;
  if (conversationId !== undefined && conversationId !== null && conversationId !== '') {
    if (typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) {
      return { error: 'conversationId 格式不合法（1–64 位字母/数字/-/_）' };
    }
    resolvedConversationId = conversationId;
  }

  let memoryEnabled = true;
  if (memory !== undefined && memory !== null && memory !== '') {
    if (typeof memory !== 'string' || !MEMORY_MODES.includes(memory)) {
      return { error: "memory 必须是 'on'|'off' 之一" };
    }
    memoryEnabled = memory === 'on';
  }

  // 联网搜索仅在显式 on 时尝试（缺省 off；服务端 WEBSEARCH=off 时该值被忽略）。
  let resolvedWebSearch = 'off';
  if (webSearch !== undefined && webSearch !== null && webSearch !== '') {
    if (typeof webSearch !== 'string' || !WEBSEARCH_MODES.includes(webSearch)) {
      return { error: "webSearch 必须是 'on'|'off' 之一" };
    }
    resolvedWebSearch = webSearch;
  }

  // 附件校验（纯校验，不做网络；图片 media_type/大小/数量/文本大小）。
  let attachments;
  try {
    attachments = normalizeAttachments(payload.attachments);
  } catch (error) {
    if (error instanceof AttachmentError) return { error: error.message, code: error.code };
    throw error;
  }

  return {
    message,
    effort: resolvedEffort,
    sessionId: resolvedSessionId,
    conversationId: resolvedConversationId,
    memoryEnabled,
    webSearch: resolvedWebSearch,
    attachments,
  };
}

async function readChatPayload(req, res) {
  try {
    return await readJsonBody(req, { limit: CHAT_BODY_LIMIT });
  } catch (error) {
    if (error instanceof HttpError) {
      sendApiError(res, error.status, error.code, error.message);
      return undefined;
    }
    throw error;
  }
}

function donePayload(state) {
  return {
    stopReason: state.stopReason || 'end_turn',
    usage: {
      inputTokens: state.usage.inputTokens,
      outputTokens: state.usage.outputTokens,
      cacheReadInputTokens: state.usage.cacheReadInputTokens,
    },
  };
}

/** 单条证据块长度估算（与 prompts.buildTurnText 的截断/预算口径一致，保证 citations 与注入内容一致）。 */
function evidenceBlockLength(citation, c) {
  const chars = Array.from(String(citation?.text ?? ''));
  const body =
    chars.length > MAX_EVIDENCE_CHUNK_CHARS
      ? `${chars.slice(0, MAX_EVIDENCE_CHUNK_CHARS).join('')}…`
      : chars.join('');
  const header = `[资料 c${c}] 《${citation?.title ?? ''}》/ 章节：${citation?.heading ?? ''} / 锚点：${citation?.anchor ?? ''}${citationProvenanceTag(citation)}`;
  return header.length + (body ? 1 + body.length : 0);
}

/**
 * 本地 RAG 在前、联网资料接续编号合流。
 * - 总证据字符受 MAX_EVIDENCE_TOTAL_CHARS 约束（超出时先丢联网尾部，保证注入与 meta 一致）；
 * - 条数受 MAX_EVIDENCE_CHUNKS 约束（本地 ≤3 + 联网 ≤2）；
 * - 合流后统一重排 c1..cN，本地项 source='rag'、联网项 source='web'（内部项仍带 text 供证据块）。
 */
function mergeWebCitations(localCitations = [], webCitations = []) {
  const merged = [];
  let total = 0;
  const append = (citation, source) => {
    if (merged.length >= MAX_EVIDENCE_CHUNKS) return false;
    const c = merged.length + 1;
    const length = evidenceBlockLength(citation, c);
    if (merged.length > 0 && total + length > MAX_EVIDENCE_TOTAL_CHARS) return false;
    merged.push({ ...citation, c, source: citation?.source ?? source });
    total += length;
    return true;
  };
  for (const citation of localCitations) {
    if (!append(citation, 'rag')) break;
  }
  for (const citation of webCitations) {
    if (!append(citation, 'web')) break;
  }
  return merged;
}

/** resetAt(ISO) → retry-after 秒（最小 1）。 */
function retryAfterSeconds(resetAt) {
  const time = Date.parse(resetAt ?? '');
  if (!Number.isFinite(time)) return 1;
  return Math.max(1, Math.ceil((time - Date.now()) / 1000));
}

/**
 * 对话 gate（配额 → 限流）。AUTH=on 且已认证才生效；AUTH=off / 匿名时原样放行。
 * 失败开放：gate 内部任何异常都记 warn 并放行，不阻断对话。
 * BYOK 请求跳过 token 配额（用户自带 key），但仍执行限流。
 * @param {{quotaExempt?: boolean}} [options]
 * @returns {Promise<{release:()=>void}|null>} null 表示已发送 429；否则返回幂等 release。
 */
async function acquireChatGate(ctx, res, { quotaExempt = false } = {}) {
  if (!ctx.userId || !ctx.usage || !ctx.ratelimit) {
    return { release() {} };
  }
  const isAdmin = ctx.user?.role === 'admin';
  let lease = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      lease?.release?.();
    } catch (error) {
      ctx.logger?.warn?.(`[chat] 释放限流并发位失败（忽略）：${error?.message ?? error}`);
    }
  };
  try {
    // 配额优先级：用户单独配额 → 全局默认 config.quota → 不限；管理员豁免（传 null）。
    // BYOK 请求不计入 token 配额（quotaExempt），因此跳过 checkQuota、仅保留限流。
    if (!quotaExempt) {
      const quota = isAdmin ? null : (ctx.user?.quota ?? ctx.config.quota ?? null);
      const decision = await ctx.usage.checkQuota({
        userId: ctx.userId,
        quota,
      });
      if (decision && decision.allowed === false) {
        const resetAt = decision.resetAt ?? null;
        sendJson(
          res,
          429,
          { error: { code: 'QUOTA_EXCEEDED', message: '本窗口配额已用尽，请稍后再试', resetAt } },
          { 'retry-after': String(retryAfterSeconds(resetAt)) },
        );
        return null;
      }
    }
    if (!isAdmin) {
      const result = ctx.ratelimit.tryAcquire(ctx.userId);
      if (!result || result.ok !== true) {
        const code = result?.code === 'CONCURRENCY_LIMITED' ? 'CONCURRENCY_LIMITED' : 'RATE_LIMITED';
        const retryAfter = Number.isFinite(result?.retryAfterSec)
          ? Math.max(1, Math.ceil(result.retryAfterSec))
          : 1;
        sendJson(
          res,
          429,
          {
            error: {
              code,
              message: code === 'CONCURRENCY_LIMITED' ? '同时进行的对话过多，请稍后再试' : '请求过于频繁，请稍后再试',
            },
          },
          { 'retry-after': String(retryAfter) },
        );
        return null;
      }
      lease = result;
    }
  } catch (error) {
    ctx.logger?.warn?.(`[chat] 配额/限流检查失败（失败开放）：${error?.message ?? error}`);
    release();
    return { release() {} };
  }
  return { release };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} ctx createContext() 返回的上下文
 */
export async function handleChat(req, res, ctx) {
  const payload = await readChatPayload(req, res);
  if (payload === undefined) return;

  const validation = validateChatPayload(payload, ctx.config);
  if (validation.error) {
    sendApiError(res, 400, validation.code ?? 'INVALID_REQUEST', validation.error);
    return;
  }

  const { message, effort, attachments, webSearch } = validation;

  //  / 契约 6：解析本轮模型来源（official|byok）。AUTH=off / 未配置 / 开关关闭 → official（旧路径不变）。
  const modelSource = await resolveChatModelSource(ctx);
  const isByok = modelSource.kind === 'byok';
  // 官方分支按峰谷策略选择本轮模型（BYOK 用用户自己的模型）；meta/usage 记实际模型。
  const officialModel = isByok ? null : resolveOfficialModel({ config: ctx.config, effort, now: new Date() });
  const usedModel = isByok ? modelSource.model : officialModel.model;

  // gate 顺序 = validation → 配额 → 限流 → 附件/会话（lease 在 SSE 结束 finally 释放一次）。
  const gate = await acquireChatGate(ctx, res, { quotaExempt: isByok });
  if (!gate) return;
  let gateReleased = false;
  const releaseGate = () => {
    if (gateReleased) return;
    gateReleased = true;
    gate.release();
  };

  try {
  // 附件解析（图片→flash 摘要；失败只带 error，不阻断对话）。
  // 解析发生在 SSE 之前，摘要随 meta 一起下发；原始二进制不落盘/不入日志。
  let parsedAttachments = [];
  if (attachments.length > 0) {
    parsedAttachments = await parseAttachments({
      config: ctx.config,
      apiKey: ctx.config.apiKey,
      logger: ctx.logger,
      attachments,
      fetchImpl: ctx.fetchImpl,
    });
    // 有效图片写 DATA_DIR/attachments（内容寻址，持久化失败只 warn 不阻断）。
    parsedAttachments = await persistAttachmentImages({
      parsedAttachments,
      attachments,
      attachmentStore: ctx.attachments,
      logger: ctx.logger,
    });
  }

  const session = ctx.sessions.getOrCreate(validation.sessionId);

  // 1) 会话：显式 conversationId → 不存在则 404（在上游请求之前）；否则新建。
  //    ⚠ 保持 v1 兼容：只传 sessionId 的老客户端仍用内存会话历史（不新建持久化会话）。
  let conversation;
  let priorMessages = [];
  if (validation.conversationId) {
    const record = ctx.store.getConversationRecord(validation.conversationId);
    if (!record) {
      sendApiError(res, 404, 'NOT_FOUND', '会话不存在');
      return;
    }
    conversation = { id: record.id, title: record.title };
    priorMessages = record.messages.slice(-MAX_HISTORY_MESSAGES);
  } else if (validation.sessionId) {
    conversation = null;
    priorMessages = session.turns
      .map(({ role, content }) => ({ role, text: content }))
      .slice(-MAX_HISTORY_MESSAGES);
  } else {
    const summary = await ctx.store.createConversation();
    conversation = { id: summary.id, title: summary.title };
  }

  // 2) 持久化用户消息（失败不影响主链路；store 内部已降级处理）。
  //    只存附件元数据 + 摘要（name/kind/mime/size/summary|error），绝不存 dataBase64。
  if (conversation) {
    try {
      const appended = await ctx.store.appendMessage(conversation.id, {
        role: 'user',
        text: message,
        createdAt: Date.now(),
        ...(parsedAttachments.length > 0
          ? {
              attachments: parsedAttachments.map((parsed, index) =>
                persistedAttachmentMeta(parsed, attachments[index]),
              ),
            }
          : {}),
      });
      if (appended?.summary?.title) conversation.title = appended.summary.title;
    } catch (error) {
      ctx.logger?.warn?.(`[chat] 用户消息持久化失败：${error?.message ?? error}`);
    }
  }

  // 历史回放唯一真源在 upstream.historyToMessages —— 这里只传文本 + 附件元数据
  // （持久化里只有摘要，没有二进制），由上游层统一拼附件块，保证追问可引用早前附件。
  const history = priorMessages
    .filter((item) => item && typeof (item.text ?? item.content) === 'string')
    .map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      text: item.text ?? item.content,
      attachments: Array.isArray(item.attachments) ? item.attachments : [],
    }))
    .filter((item) => item.text !== '' || item.attachments.length > 0);

  // 3) 检索（v2 的 rerank / query expand 参数由 context 内部透传给 rag）。
  // 本地 RAG 永远优先；显式 webSearch=on 且服务端 WEBSEARCH=on 时才补联网资料。
  // 联网失败/超时/限流/危机/关闭一律降级为空，绝不 throw、绝不阻断 SSE。
  const webSearchEnabled = Boolean(ctx.config.websearch && ctx.webSearch);
  let webSearchActive = false;
  /** 超限时下发给前端的配额说明（仅 allowed=false 才出现在 meta 中）。 */
  let webSearchQuota = null;
  if (webSearchEnabled && webSearch === 'on') {
    try {
      webSearchActive = ctx.webSearch.shouldSearch({ webSearch: 'on', message });
    } catch (error) {
      webSearchActive = false;
      ctx.logger?.warn?.(`[chat] 联网搜索门槛判断失败（按不联网处理）：${error?.message ?? error}`);
    }
  }
  // 每用户每日联网次数配额（WEBSEARCH_PER_USER_PER_DAY）。
  // AUTH=off 不强制（管理员豁免）；超限时本轮自动不联网（不 429），仅在 meta 说明配额。
  if (
    webSearchActive &&
    ctx.authMode === 'on' &&
    Boolean(ctx.userId) &&
    ctx.user?.role !== 'admin' &&
    typeof ctx.usage?.checkWebSearchQuota === 'function'
  ) {
    try {
      const q = await ctx.usage.checkWebSearchQuota({
        userId: ctx.userId,
        limit: ctx.config.webSearchPerUserPerDay,
        now: new Date(),
      });
      if (q && q.allowed === false) {
        webSearchActive = false;
        webSearchQuota = {
          limit: q.limit,
          used: q.used,
          resetAt: q.resetAt,
          allowed: false,
        };
      }
    } catch (error) {
      // 配额读失败不能阻断对话：按放行处理，只记 warn。
      ctx.logger?.warn?.(`[chat] 联网配额检查失败（按放行处理）：${error?.message ?? error}`);
    }
  }
  const localCitations = await ctx.retrieveCitations(message, { topK: webSearchActive ? 3 : 5 });
  let webCitations = [];
  if (webSearchActive) {
    try {
      const outcome = await ctx.webSearch.search({ message, webSearch: 'on' });
      webCitations = Array.isArray(outcome?.citations) ? outcome.citations : [];
    } catch (error) {
      // websearch 内部已保证不 throw；这里只是最后一道保险。
      webCitations = [];
      ctx.logger?.warn?.(`[chat] 联网搜索异常，按无联网资料处理：${error?.message ?? error}`);
    }
  }
  const citations = mergeWebCitations(localCitations, webCitations);
  const webSearchUsed = citations.filter((citation) => citation.source === 'web').length;

  // 4) 记忆注入（静态 system 末尾追加一段；memory=off 或 MEMORY=0 时不注入）。
  const memoryOn = Boolean(ctx.config.memory && ctx.memory && validation.memoryEnabled);
  const injection = memoryOn ? ctx.memory.buildSystemSuffix({ query: message }) : { text: '', count: 0 };
  // 记忆注入之后追加健康背景（用户主动导入的聚合数据，≤600 字符，不做诊断）。
  const healthInjection = ctx.health ? ctx.health.buildSuffix() : { text: '', count: 0 };
  // 健康注入之后追加问卷历史背景（只含结果摘要，≤500 字符，不做诊断；
  // 关闭注入/无数据/构建失败时为空段，绝不影响对话流）。
  let scaleInjection = { text: '', count: 0 };
  try {
    if (ctx.scaleHistory) scaleInjection = ctx.scaleHistory.buildSuffix();
  } catch (error) {
    ctx.logger?.warn?.(`[chat] 问卷历史注入失败（忽略）：${error?.message ?? error}`);
  }
  // WEBSEARCH=on 时把外部资料使用规则追加到静态 system 之后（六静态文件与 prompt cache 不变）。
  const webSearchRulesText =
    webSearchEnabled && ctx.webSearchRules?.text ? `\n\n${ctx.webSearchRules.text}` : '';
  const system = `${ctx.prompts.text}${webSearchRulesText}${injection.text}${healthInjection.text}${scaleInjection.text}`;

  startSSE(res);
  const meta = {
    conversationId: conversation ? conversation.id : null,
    title: conversation ? conversation.title : null,
    sessionId: session.id,
    model: usedModel,
    //  / 契约 6：实际模型来源（official|byok）；AUTH=off 单用户路径不新增字段（旧 meta 逐字节一致）。
    ...(ctx.authMode === 'on' ? { modelSource: modelSource.kind } : {}),
    effort,
    memoryUsed: injection.count,
    // 本轮注入的健康背景条目数（0=未注入，例如无数据或 HEALTH_INJECT=off）。
    healthUsed: healthInjection.count,
    // 本轮注入的问卷历史条目数（0=未注入，例如无历史或 SCALE_HISTORY_INJECT=off）。
    scaleHistoryUsed: scaleInjection.count,
    // 本轮实际注入的联网资料条数（0=未用/失败/禁用/危机/关闭）。
    webSearchUsed,
    citations: publicCitations(citations),
  };
  // 超限时说明配额（allowed=true 不输出该字段，旧 meta 逐字节不变）。
  if (webSearchQuota) meta.webSearchQuota = webSearchQuota;
  // 只有带附件时才追加该字段：不带附件的老客户端 meta 与 v2 逐字节一致。
  if (parsedAttachments.length > 0) {
    meta.attachments = parsedAttachments.map(publicAttachmentMeta);
  }
  const metaSent = await writeSSE(res, 'meta', meta);
  if (!metaSent) {
    endSSE(res);
    return;
  }

  const state = {
    clientAborted: false,
    // 客户端断开但选择后台续跑（不 abort、不写 SSE，完成后照常持久化）。
    clientGone: false,
    timedOut: false,
    text: '',
    thinking: '',
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    // 用量只记一次（done.usage 与 done 事件同源；abort/error 补记）。
    usageRecorded: false,
  };
  // 记账在响应收尾前完成（await）：保证紧随其后的 /api/me/usage 与超配额判定确定可见。
  const recordUsage = async (status) => {
    if (state.usageRecorded) return;
    state.usageRecorded = true;
    if (!ctx.usage || !ctx.userId) return;
    try {
      // 真等落盘完成：保证紧随其后的 /api/me/usage、JSONL 与超配额判定确定可见，
      // 避免进程在 done 后立刻退出时丢失最后一条用量记录（record 永不 throw）。
      await ctx.usage.record({
        userId: ctx.userId,
        model: usedModel,
        usage: normalizeUsage(state.usage),
        status,
        conversationId: conversation ? conversation.id : null,
        // 来源分桶（official|byok）+ 厂商；BYOK 不计入官方配额与成本估算。
        source: isByok ? 'byok' : 'official',
        provider: isByok ? (modelSource.provider ?? null) : null,
        // 只有本轮真正联网才计 webSearch（配额拒绝/关闭/危机跳过不计）。
        webSearch: webSearchActive === true,
      });
    } catch (error) {
      ctx.logger?.warn?.(`[chat] 用量记账失败（忽略）：${error?.message ?? error}`);
    }
  };
  const abortController = new AbortController();
  // 日志尽量走 info 级；注入的 logger 若只有 log（测试捕获器）则降级，保证可观测性一致。
  const logInfo = (line) => {
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(line);
    else if (typeof ctx.logger?.log === 'function') ctx.logger.log(line);
  };
  // 客户端断开（离页/切后台）时——
  //   backgroundGeneration=on：只标记 clientGone，不 abort 上游、不写 SSE，生成完成后照常落盘；
  //   off：保持 行为（标记 clientAborted + 中断上游，不落 assistant 消息）。
  const onClose = () => {
    if (res.writableEnded || state.clientGone || state.clientAborted) return;
    if (ctx.config.backgroundGeneration) {
      state.clientGone = true;
      logInfo(`[chat] 客户端断开，后台继续生成 conversation=${conversation ? conversation.id : 'none'}`);
      return;
    }
    state.clientAborted = true;
    abortController.abort();
  };
  res.once('close', onClose);

  let timeoutTimer;
  // BYOK 用 BYOK_TIMEOUT_MS（默认 120s），官方路径沿用 UPSTREAM_TIMEOUT_MS。
  const upstreamTimeoutMs = isByok
    ? (Number.isFinite(ctx.config.byokTimeoutMs) && ctx.config.byokTimeoutMs > 0
        ? ctx.config.byokTimeoutMs
        : ctx.config.upstreamTimeoutMs)
    : ctx.config.upstreamTimeoutMs;
  if (!ctx.config.mock) {
    timeoutTimer = setTimeout(() => {
      state.timedOut = true;
      abortController.abort();
    }, upstreamTimeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
  }

  // 包一层：累计 thinking / 正文增量，便于 done 之后落盘。
  // clientGone 后不再写 SSE，但必须返回 true（假装写成功）——
  // mock 流用 write 返回值判断「客户端中途断开」，返回 false 会让 mock 提前退出、后台续跑失败。
  // 其余情况维持 writeSSE 语义（连接已结束/销毁 → false）。
  const write = (event, data) => {
    if (event === 'thinking_delta' && typeof data?.text === 'string') state.thinking += data.text;
    else if (event === 'text_delta' && typeof data?.text === 'string') state.text += data.text;
    if (state.clientGone) return true;
    if (res.writableEnded || res.destroyed) return false;
    return writeSSE(res, event, data);
  };

  try {
    if (ctx.config.mock) {
      const result = await runMockStream({
        write,
        citations,
        message,
        effort,
        delayMs: ctx.config.mockDelayMs,
        isAborted: () => state.clientAborted || abortController.signal.aborted,
      });
      if (result.aborted) {
        await recordUsage('aborted');
        return;
      }
      state.text = result.text || state.text;
      state.stopReason = result.stopReason;
      state.usage = result.usage;
    } else if (isByok) {
      //  / 契约 6：BYOK 上游分支（mock 优先级最高已在上方；失败直接报错、不回落官方）。
      // messages 与官方同源：historyToMessages 回放历史，buildTurnText 拼本轮证据/附件。
      const byokMessages = historyToMessages(history).map((item) => ({
        role: item.role,
        content: item.content.map((block) => block.text ?? '').join('\n'),
      }));
      byokMessages.push({ role: 'user', content: buildTurnText(citations, message, parsedAttachments) });
      const result = await streamByokUpstream({
        provider: modelSource.provider,
        protocol: modelSource.protocol,
        model: modelSource.model,
        baseUrl: modelSource.baseUrl,
        apiKey: modelSource.apiKey,
        system,
        messages: byokMessages,
        maxTokens: resolveMaxTokens(ctx.config, effort),
        // BYOK 对话统一走 pinned 传输（DNS 钉扎）；fetchImpl 仅旧探针兼容。
        transport: ctx.byok?.transport ?? null,
        fetchImpl: ctx.fetchImpl,
        signal: abortController.signal,
        onEvent: write,
        logger: ctx.logger,
        timeoutMs: upstreamTimeoutMs,
        // 出站前 DNS 重校验（AUTH=off/未注入时为 null，行为不变）。
        assertRequestUrl: ctx.byok?.assertRequestUrl ? (url) => ctx.byok.assertRequestUrl(url) : null,
      });
      state.text = result.text || state.text;
      state.stopReason = result.stopReason;
      state.usage = result.usage;
    } else if (!ctx.config.apiKey) {
      await write('error', {
        code: 'UPSTREAM',
        message:
          '未配置 DEEPSEEK_API_KEY：请设置环境变量或 ~/.config/chat-terminal/credentials.yaml，或使用 CHAT_MOCK=1 启动',
        retryable: false,
      });
      await recordUsage('error');
      return;
    } else {
      const result = await streamUpstream({
        fetchImpl: ctx.fetchImpl,
        // 峰谷策略只改本轮实际模型，不改 ctx.config（其它路径/配额不受影响）。
        config: usedModel === ctx.config.model ? ctx.config : { ...ctx.config, model: usedModel },
        system,
        citations,
        message,
        effort,
        history,
        attachments: parsedAttachments,
        signal: abortController.signal,
        onEvent: write,
        logger: ctx.logger,
      });
      state.text = result.text || state.text;
      state.stopReason = result.stopReason;
      state.usage = result.usage;
    }

    // clientGone 是后台续跑不是中断，继续落盘；只有真 abort/超时才按原语义收尾。
    if (state.clientAborted) {
      await recordUsage('aborted');
      return;
    }
    if (abortController.signal.aborted) {
      // 超时等中断的兜底（正常由 catch 分支处理）：按 error 语义收尾，不落 assistant 消息。
      await recordUsage(state.timedOut ? 'error' : 'aborted');
      if (state.timedOut) {
        await write('error', {
          code: isByok ? 'BYOK_UPSTREAM_TIMEOUT' : 'UPSTREAM',
          message: isByok
            ? `自定义模型响应超时（>${upstreamTimeoutMs}ms）`
            : `上游响应超时（>${ctx.config.upstreamTimeoutMs}ms）`,
          retryable: true,
        });
      }
      return;
    }
    const assistantText = state.text;
    if (assistantText) ctx.sessions.commitTurn(session.id, message, assistantText);

    // 5) 持久化 assistant 消息（thinking 仅在产生时保存）。
    if (conversation && assistantText) {
      try {
        await ctx.store.appendMessage(conversation.id, {
          role: 'assistant',
          text: assistantText,
          createdAt: Date.now(),
          effort,
          ...(state.thinking ? { thinking: state.thinking } : {}),
          citations: publicCitations(citations),
        });
      } catch (error) {
        ctx.logger?.warn?.(`[chat] assistant 消息持久化失败：${error?.message ?? error}`);
      }
    }

    // DATA-CONTRACT 10：服务端引证校验——正文 [[cN]] 必须对应本轮 citations。
    // 不重写正文；无对应编号记 warn，并统计本轮标记数（done 之前输出）。
    if (assistantText) {
      const markers = [...assistantText.matchAll(/\[\[c(\d+)\]\]/g)].map((m) => Number(m[1]));
      const known = new Set(citations.map((c) => c.c));
      const unmatched = [...new Set(markers.filter((n) => !known.has(n)))];
      if (unmatched.length) {
        ctx.logger?.warn?.(`[chat] 正文引用标记无对应资料：${unmatched.join(',')}（citations=${citations.length}）`);
      }
      ctx.logger?.info?.(
        `[chat] markers=${markers.length} citations=${citations.length} conversation=${conversation?.id ?? 'none'} effort=${effort}`,
      );
    }

    await write('done', donePayload(state));
    // 用量记账：done 事件写出之后，与 done.usage 同源；失败不影响响应（record 永不 throw）。
    await recordUsage('ok');

    // 后台续跑完成日志（仅 clientGone；正常在线请求不新增日志）。
    if (state.clientGone) {
      logInfo(
        `[chat] 后台生成完成 conversation=${conversation ? conversation.id : 'none'} chars=${assistantText.length} model=${usedModel}`,
      );
    }

    // 6) 长期记忆抽取：done 之后 fire-and-forget（失败只 warn，不影响响应）。
    if (memoryOn && conversation) {
      const turnAttachmentBlock = formatAttachmentBlock(parsedAttachments);
      const recent = [
        ...history.slice(-4),
        { role: 'user', content: turnAttachmentBlock ? `${message}\n\n${turnAttachmentBlock}` : message },
      ];
      if (assistantText) recent.push({ role: 'assistant', content: assistantText });
      void ctx.memory
        .extractAfterTurn({ conversationId: conversation.id, messages: recent })
        .catch((error) => ctx.logger?.warn?.(`[chat] 记忆抽取异常：${error?.message ?? error}`));
    }
  } catch (error) {
    if (state.clientAborted) {
      await recordUsage('aborted');
      return;
    }
    if (state.timedOut) {
      await recordUsage('error');
      if (isByok) {
        await write('error', {
          code: 'BYOK_UPSTREAM_TIMEOUT',
          message: `自定义模型响应超时（>${upstreamTimeoutMs}ms）`,
          retryable: true,
        });
        return;
      }
      await write('error', {
        code: 'UPSTREAM',
        message: `上游响应超时（>${ctx.config.upstreamTimeoutMs}ms）`,
        retryable: true,
      });
      return;
    }
    if (error instanceof ClientAbortError) {
      await recordUsage('aborted');
      return;
    }
    if (error instanceof ByokUpstreamFailure) {
      //  / 契约 6：错误码归一化 + 消息脱敏（绝不回传明文 key）；不静默回落官方模型。
      await recordUsage('error');
      await write('error', {
        code: error.code,
        message: redactSecrets(error.message, isByok ? modelSource.apiKey : null),
        retryable: error.retryable === true,
      });
      return;
    }
    if (error instanceof UpstreamFailure) {
      await recordUsage('error');
      await write('error', {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
      return;
    }
    ctx.logger?.error?.('[chat] 未处理异常：', error);
    await recordUsage('error');
    await write('error', { code: 'INTERNAL', message: '服务器内部错误', retryable: false });
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    res.off('close', onClose);
    endSSE(res);
    releaseGate();
  }
  } finally {
    releaseGate();
  }
}
