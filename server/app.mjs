// HTTP 应用：路由 /api/health、/api/chat、/api/docs/:docId、/api/session/:id、
// /api/conversations*、/api/memories*、/api/marks* + 静态文件。
// 依赖全部可注入（fetchImpl / retriever / callModel / 目录 / logger），测试绝不发真实网络请求。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveMaxTokens } from './config.mjs';
import { createAtRest, setupAtRest } from './at-rest.mjs';
import { createAuthService, csrfRequired, isPublicApi } from './auth.mjs';
import { handleAuthRoutes, handleMeRoutes } from './auth-routes.mjs';
// 请求 id 与优雅关闭生命周期（createLifecycle 单例挂载到 ctx）。
import { createLifecycle } from './lifecycle.mjs';
// 管理员操作审计日志（JSONL；AUTH=off 不启用）。
import { createAuditLog } from './audit.mjs';
import { createUserService, publicUser } from './users.mjs';
import { createSessionService } from './user-sessions.mjs';
import { createUsageService } from './usage.mjs';
import { createRateLimiter } from './ratelimit.mjs';
import { createFeedbackService, handleFeedback } from './feedback.mjs';
import { createInviteStore, createSettingsStore, handleAdmin } from './admin.mjs';
import { createByokService } from './byok.mjs';
import { handleByok } from './byok-routes.mjs';
// /api/me 合规扩展路由（consent/export/DELETE 账号）。
import { handleMeData } from './me-data.mjs';
import { ensureUserEnvelope } from './envelope.mjs';
import { createMemoryExtractCaller } from './memory-extract.mjs';
import { sendApiError, sendJson, sendJsonText } from './http-utils.mjs';
import { loadCorpus } from './corpus.mjs';
import { createDocStore, DOC_ID_PATTERN } from './docstore.mjs';
import { createLibrary } from './library.mjs';
import { loadMemoryExtractPrompt, loadSystemPrompt, loadWebSearchRules } from './prompts.mjs';
import { createSessionStore, SESSION_ID_PATTERN } from './sessions.mjs';
import { loadReranker, loadRetriever, readRetrieverStats } from './rag.mjs';
import { retrieveCitations } from './citations.mjs';
import { handleChat } from './chat.mjs';
import { handleConversations } from './conversations.mjs';
import { createMemoryService, handleMemories } from './memory.mjs';
import { createMarksStore, handleMarks } from './marks.mjs';
import { handleScales, registerPrivateScales } from './scales.mjs';
import { createScaleHistoryStore } from './scales-history.mjs';
import { loadPrivateScalePacks, privateScalesDir } from './scales-private.mjs';
import { createStore } from './store.mjs';
import { createHealthStore, handleHealthImport } from './health.mjs';
import { createCallModel } from './upstream.mjs';
import {
  cleanupExpiredAttachments,
  createAttachmentStore,
  handleAttachments,
  sweepStoreAttachments,
} from './attachments.mjs';
import { handleStatic } from './static.mjs';
import { createWebSearch } from './websearch.mjs';

export function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

async function readVersion(repoRoot) {
  try {
    const raw = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    return typeof raw.version === 'string' && raw.version ? raw.version : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/** 字节数 → 人类可读（仅用于启动日志，不含任何隐私数据）。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0KB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * 建立服务上下文（读取配置、语料、prompt、检索模块、持久化 store、长期记忆）。
 * @param {{
 *   env?: Record<string,string|undefined>,
 *   repoRoot?: string,
 *   fetchImpl?: typeof fetch,
 *   retriever?: object|null,
 *   retrieverOptions?: object,
 *   reranker?: object|null,
 *   callModel?: Function|null,
 *   docsDir?: string,
 *   promptsDir?: string,
 *   staticDir?: string,
 *   dataDir?: string,
 *   credentialPath?: string,
 *   logger?: Console,
 * }} [options]
 */
export async function createContext(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const logger = options.logger ?? console;
  const config = loadConfig(options.env ?? process.env, {
    credentialPath: options.credentialPath,
    logger,
  });

  const docsDir = options.docsDir ?? path.join(repoRoot, 'corpus');
  const promptsDir = options.promptsDir ?? path.join(repoRoot, 'prompts');
  const staticDir = options.staticDir ?? path.join(repoRoot, 'public');
  const dataDir =
    options.dataDir ??
    (path.isAbsolute(config.dataDir) ? config.dataDir : path.resolve(repoRoot, config.dataDir));

  // DATA_DIR 静态数据加密（at-rest）。
  // 无 key → 模式 off，保持明文并 WARN（既有行为不变）；有 key → 启动先把既有明文迁移为密文（幂等），
  // 错误 key / 损坏密文直接抛错（由启动入口 fail-fast 退出，不静默覆盖数据）。
  const atRestSetup = setupAtRest({ dataDir, config, env: options.env ?? process.env, logger });
  const atRest = atRestSetup.atRest;
  // 信封加密必须有 KEK（否则用户数据无法用 DEK 加密，且 health 会误报 envelope:on）。
  // 配置矛盾时启动即 fail-fast，避免静默降级为单密钥/明文。
  if (config.atRestEnvelope && !atRestSetup.key) {
    throw new Error(
      'AT_REST_ENVELOPE=on 需要配置 DATA_ENCRYPTION_KEY 或 DATA_ENCRYPTION_KEY_FILE（信封加密 KEK）',
    );
  }
  if (atRest.enabled) {
    logger?.log?.(`[at-rest] 加密 on（已迁移 ${atRestSetup.migration.migrated} 个文件）`);
    if (atRestSetup.keySource === 'file') {
      logger?.log?.('[at-rest] 密钥来源：DATA_ENCRYPTION_KEY_FILE（权限已校验，不打印路径/内容）');
    }
  } else {
    logger?.log?.('[at-rest] 加密 off（已迁移 0 个文件）');
    logger?.warn?.(
      '[at-rest] 未配置 DATA_ENCRYPTION_KEY / DATA_ENCRYPTION_KEY_FILE：DATA_DIR 以明文保存（生产环境建议配置加密密钥）',
    );
  }
  // 信封加密（KEK→DEK）开关。开启时 AUTH=on 的用户数据用各用户 DEK 加密（见 createUserScopedCtx），
  // 全局文件与 byok.secret.enc 仍用 KEK；关闭时保持  单密钥语义（测试/AUTH=off 零回归）。
  if (config.atRestEnvelope) {
    logger?.log?.('[at-rest] 信封加密 on（KEK→DEK，用户数据按用户 DEK 加密）');
  } else {
    logger?.log?.('[at-rest] 信封加密 off（单密钥模式）');
  }

  // 加载本机私有问卷包（<DATA_DIR>/scales-private/*.json，不随软件分发）。
  // 每个服务实例按自己的 DATA_DIR 重新注册；坏文件记日志跳过，不阻塞启动。
  const privateScales = await loadPrivateScalePacks({
    dir: privateScalesDir(dataDir),
    logger,
  });
  const privateScaleRegistration = registerPrivateScales(privateScales.scales);
  logger?.log?.(
    `[chat-terminal] 私有问卷 ${privateScaleRegistration.count} 份（本地文件，不随软件分发）`,
  );

  // 语料只读一次，共享给 docStore / library / retriever（避免同一批 JSON 解析三次）。
  const corpus = await loadCorpus({ docsDir, logger });
  const docStore = await createDocStore({ docsDir, docs: corpus.docs, logger });
  // 文档库入口数据：启动时构建一次并缓存（契约 7）。
  const library = await createLibrary({ docsDir, docStore, corpus, logger });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const prompts = await loadSystemPrompt({ promptsDir, logger });
  const memoryPrompt = await loadMemoryExtractPrompt({ promptsDir, logger });
  // 联网搜索的外部资料规则独立文件，仅在 WEBSEARCH=on 时载入（缺失只 warn 不阻断）。
  const webSearchRules = config.websearch
    ? await loadWebSearchRules({ promptsDir, logger })
    : { text: '', fallback: false, missing: false };

  // 补全型模型调用（记忆抽取 / LLM 重排）：mock 或缺少 key 时为 null，调用方降级。
  let callModel = options.callModel ?? null;
  if (!callModel && !config.mock && config.apiKey) {
    callModel = createCallModel({ fetchImpl, config, logger, model: config.memoryExtractModel || undefined });
  }

  let reranker = options.reranker;
  if (reranker === undefined) {
    reranker = config.rerank === 'llm' ? await loadReranker({ repoRoot, callModel, logger }) : null;
  }

  // -B：注入式 retriever（单元测试 fake）保持旧检索行为；真实 rag retriever 启用相关度层。
  const injectedRetriever = options.retriever !== undefined;
  let retriever = options.retriever;
  if (retriever === undefined) {
    retriever = await loadRetriever({
      repoRoot,
      docsDir,
      // 复用 loadCorpus 单次解析的语料，retriever 不再重复读盘。
      docs: corpus.docs,
      // T18b 增强检索：注入 reranker / 查询扩展开关（rag/index.mjs 可选支持）。
      retrieverOptions: {
        ...(options.retrieverOptions && typeof options.retrieverOptions === 'object'
          ? options.retrieverOptions
          : {}),
        ...(reranker ? { reranker } : {}),
        expand: config.queryExpand !== 'off',
      },
      logger,
    });
  }

  const sessions = createSessionStore();
  const store = await createStore({ dataDir, logger, atRest });
  // 记录按 DATA_DIR 单独一份 health.json；启动日志只报配置状态，绝不打印 token。
  const health = await createHealthStore({ dataDir, config, logger, atRest });
  logger?.log?.(
    `[chat-terminal] 健康导入 ${config.healthImport ? 'on' : 'off'}（${config.healthImportToken ? '已配置令牌' : '未配置令牌'}）`,
  );
  const marks = await createMarksStore({
    dataDir,
    logger,
    docStore,
    atRest,
    ...(options.marksLimits && typeof options.marksLimits === 'object'
      ? {
          maxExcerpts: options.marksLimits.MAX_EXCERPTS,
          maxFavorites: options.marksLimits.MAX_FAVORITES,
        }
      : {}),
  });
  const version = await readVersion(repoRoot);

  const memory = createMemoryService({
    store,
    config,
    logger,
    callModel,
    extractPrompt: memoryPrompt.text,
  });

  //  /  协作：memory-engineer 的启动迁移通过 memory.ready Promise 暴露；
  // 防御式等待（失败只 warn，绝不阻塞启动；未提供 ready 时保持原行为）。
  if (memory && typeof memory.ready?.then === 'function') {
    try {
      await memory.ready;
    } catch (error) {
      logger?.warn?.(`[chat-terminal] 记忆迁移失败（不阻塞启动）：${error?.message ?? error}`);
    }
  }

  // 图片附件持久化（DATA_DIR/attachments，内容寻址）。启动时清理孤儿文件并报一次统计；
  // 失败只 warn，不影响服务启动（关闭存储时只保留 解析摘要）。
  const attachments = createAttachmentStore({
    dataDir,
    maxTotalMb: config.attachmentMaxMb,
    logger,
    enabled: config.attachmentStorage,
    atRest,
  });
  try {
    const { removed } = await sweepStoreAttachments({ attachments, store, logger });
    const stats = await attachments.stats();
    logger?.log?.(
      `[chat-terminal] 图片附件存储 ${config.attachmentStorage ? 'on' : 'off'}（${stats.count} 个 / ${formatBytes(stats.bytes)}${removed > 0 ? `，清理孤儿 ${removed} 个` : ''}）`,
    );
  } catch (error) {
    logger?.warn?.(`[chat-terminal] 附件存储初始化失败（忽略）：${error?.message ?? error}`);
  }

  // 问卷历史（只存结果摘要，不存原始答案/题面）。启动日志只报开关与条数。
  const scaleHistory = await createScaleHistoryStore({ dataDir, config, logger, atRest });
  const scaleHistoryStats = scaleHistory.meta();
  logger?.log?.(
    `[chat-terminal] 问卷历史 ${scaleHistory.enabled ? 'on' : 'off'}（${scaleHistoryStats.count} 条）`,
  );

  // 联网搜索（默认关闭）。薄适配器只做检索增强：缓存/限流在内存、不落盘，
  // 失败/超时/限流一律降级为空，绝不阻断对话。日志只报开关与 provider，不打印 key。
  const webSearch = createWebSearch({ config, fetchImpl, logger });
  logger?.log?.(
    `[chat-terminal] 联网搜索 ${config.websearch ? 'on' : 'off'}（provider=${config.websearchProvider}，最多 ${config.websearchMaxCitations} 条联网引用）`,
  );

  // 多用户认证。AUTH=off 时**完全不构造**认证服务（旧单用户路径逐字节零回归）。
  const authMode = config.auth === 'on' ? 'on' : 'off';
  const baseDataDir = dataDir;
  const atRestKey = atRestSetup.key ?? null;
  // 生命周期管理器（request id + 优雅关闭 flush 注册表）。AUTH=off 同样需要 request-id。
  const lifecycle = createLifecycle({
    logger,
    timeoutMs: Number.isFinite(Number(process.env.SHUTDOWN_TIMEOUT_MS))
      ? Number(process.env.SHUTDOWN_TIMEOUT_MS)
      : 5000,
  });
  let users = null;
  let userSessions = null;
  let auth = null;
  let usageService = null;
  let ratelimit = null;
  let feedbackService = null;
  let inviteStore = null;
  let settingsStore = null;
  let byokService = null;
  let auditLog = null;
  if (authMode === 'on') {
    users = createUserService({ dataDir: baseDataDir, logger });
    userSessions = createSessionService({
      dataDir: baseDataDir,
      logger,
      ttlMs: config.authSessionTtlDays * 24 * 60 * 60 * 1000,
    });
    auth = createAuthService({ config, users, sessions: userSessions, logger });
    // 首个管理员引导：users.json 不存在/无 admin 时用 ADMIN_USERNAME + ADMIN_INITIAL_PASSWORD_FILE；
    // 缺 env 直接 fail-fast（错误信息不含密码），迁移脚本在启动入口已完成同一逻辑时此处为幂等空操作。
    await ensureBootstrapAdmin({ config, users, repoRoot, env: options.env ?? process.env, logger });
    usageService = createUsageService({ dataDir: baseDataDir, config, logger });
    ratelimit = createRateLimiter({
      perMinute: config.rateLimit.perMinute,
      concurrency: config.rateLimit.concurrency,
    });
    // 反馈 webhook（config.feedbackWebhookUrl 非空才发；fetchImpl 可注入便于测试）。
    feedbackService = createFeedbackService({ dataDir: baseDataDir, logger, config, fetchImpl });
    // 邀请码存储：base ctx 持有单实例，admin 路由与注册路由共用（避免多实例各自缓存 invites.json 造成不一致）。
    inviteStore = createInviteStore({ dataDir: baseDataDir, logger });
    // ..管理员设置单例（BYOK 开关等生效值）与 BYOK 服务（每用户加密存储）。
    settingsStore = createSettingsStore({ dataDir: baseDataDir, logger });
    // 管理员操作审计（JSONL；失败不阻断启动，由模块内部降级）。
    auditLog = createAuditLog({ dataDir: baseDataDir, logger });
    byokService = createByokService({
      baseDataDir,
      atRestKey,
      config,
      logger,
      fetchImpl,
      now: () => new Date(),
    });
    logger?.log?.(
      `[byok] 自定义模型 ${config.byokEnabled !== false ? 'on' : 'off'}（探活 ${config.byokCheckPerMinute} 次/分，超时 ${config.byokTimeoutMs}ms）`,
    );
    logger?.log?.(
      `[auth] 认证 on（管理员 ${await users.count({ role: 'admin' })} 个 / 用户 ${await users.count()} 个；Cookie Secure=${config.authCookieSecure !== false ? 'on' : 'off'}；邀请制 ${config.inviteOnly !== false ? 'on' : 'off'}）`,
    );
  } else {
    logger?.log?.('[auth] 认证 off（单用户模式）');
  }

  const ctx = {
    repoRoot,
    logger,
    config,
    docStore,
    library,
    retriever,
    reranker,
    callModel,
    memory,
    attachments,
    scaleHistory,
    // 联网搜索服务（缓存/限流/统计）与外部资料规则（WEBSEARCH=off 时为空文本）。
    webSearch,
    webSearchRules,
    store,
    health,
    marks,
    // at-rest 加密编解码器（off 时 enabled=false；health.storage.atRest 读取 mode）。
    atRest,
    atRestMigration: atRestSetup.migration,
    prompts,
    sessions,
    version,
    staticDir,
    docsDir,
    dataDir,
    // 认证模式与多用户服务（AUTH=off 时除 authMode/baseDataDir 外均为 null）。
    baseDataDir,
    authMode,
    auth,
    users,
    userSessions,
    usage: usageService,
    ratelimit,
    feedback: feedbackService,
    // ..管理员设置（BYOK 开关生效值）与 BYOK 服务（AUTH=off 时为 null）。
    settingsStore,
    byok: byokService,
    // ..审计日志（AUTH=off 为 null）与进程生命周期（registry + requestId + 优雅关闭）。
    audit: auditLog,
    lifecycle,
    /** BYOK 是否全站生效：管理员设置优先，否则 config.byokEnabled（AUTH=off 恒 false）。 */
    async getByokEnabled() {
      if (authMode !== 'on' || !settingsStore) return false;
      try {
        const stored = await settingsStore.read();
        if (typeof stored?.byokEnabled === 'boolean') return stored.byokEnabled;
      } catch {
        /* 读设置失败按 config 默认值，不阻断对话 */
      }
      return config.byokEnabled !== false;
    },
    // 邀请码存储单例（admin 路由与注册路由共用；AUTH=off 不新增该字段，保持旧 ctx 形状）。
    ...(inviteStore ? { inviteStore } : {}),
    // per-user 数据用同一把 at-rest 密钥（无 key 时 null，与全局明文模式一致）。
    atRestKey,
    // AUTH=off 恒为 null；AUTH=on 由请求作用域 scoped ctx 覆盖。
    userId: null,
    // 私有问卷包加载结果（目录、有效 id、跳过的坏文件；管理/测试可观测）。
    privateScales: {
      dir: privateScales.dir,
      ids: privateScaleRegistration.ids,
      count: privateScaleRegistration.count,
      errors: privateScales.errors,
    },
    memoryPrompt,
    fetchImpl,
    startedAt: Date.now(),
    /**
     * 语料统计：优先用检索器 stats()，检索器未就绪时退回文档存储统计。
     * @returns {Promise<{docs:number,chunks:number}>}
     */
    async corpusStats() {
      const fromRetriever = await readRetrieverStats(retriever);
      if (fromRetriever) return fromRetriever;
      const { docs, chunks } = docStore.stats();
      return { docs, chunks };
    },
    /**
     * 本轮检索 → 引用（c1..cN）；rerank/query expand 参数以第三参数透传给 rag。
     * -B：真实 rag retriever 启用相关度层（rag/relevance.mjs）；注入式 fake 保持旧行为。
     * 支持 { topK } 覆盖（联网开启时本地先降到 3，给联网资料留预算）。
     */
    retrieveCitations(message, options = {}) {
      const topK =
        Number.isFinite(options?.topK) && options.topK > 0 ? Math.trunc(options.topK) : 5;
      return retrieveCitations({
        retriever,
        message,
        topK,
        retrieveOpts: {
          rerank: config.rerank === 'llm',
          expand: config.queryExpand !== 'off',
        },
        relevance: injectedRetriever ? null : true,
        logger,
      });
    },
  };

  // 注册各数据服务的 flush（谁有写队列谁实现；缺省视为已 flush）。
  const flushTargets = [
    ['store', () => ctx.store?.flush?.()],
    ['usage', () => ctx.usage?.flush?.()],
    ['health', () => ctx.health?.flush?.()],
    ['marks', () => ctx.marks?.flush?.()],
    ['scaleHistory', () => ctx.scaleHistory?.flush?.()],
    ['audit', () => ctx.audit?.flush?.()],
  ];
  for (const [name, getter] of flushTargets) {
    lifecycle.registerFlush(name, async () => {
      const flush = getter();
      if (flush && typeof flush.then === 'function') await flush;
    });
  }
  /** bin/serve.mjs 在 SIGTERM 时 await 它：按序 flush 全写队列（总超时由 lifecycle 控制）。 */
  ctx.flushAll = () => lifecycle.shutdown('flushAll');
  ctx.lifecycle = lifecycle;
  // 附件过期清理（默认 0=关闭，避免启动副作用；开启时后台跑、失败只 warn）。
  if (authMode === 'on' && Number(config.attachmentRetentionDays) > 0) {
    void sweepExpiredAttachmentsForAllUsers(ctx).catch((error) => {
      logger?.warn?.(`[attachments] 启动过期附件清理失败（忽略）：${error?.message ?? error}`);
    });
  }
  return ctx;
}

/**
 * AUTH=on 首个管理员引导：users.json 不存在/无 admin 时用 ADMIN_USERNAME + ADMIN_INITIAL_PASSWORD_FILE。
 * 缺 env / 文件不可读 / 内容为空 → 抛错（由启动入口 fail-fast）；任何日志/错误信息都不含密码。
 */
async function ensureBootstrapAdmin({ config, users, repoRoot, env, logger }) {
  const existingAdmins = await users.count({ role: 'admin' });
  if (existingAdmins > 0) return null;
  const fileSetting = typeof config.adminInitialPasswordFile === 'string' ? config.adminInitialPasswordFile.trim() : '';
  if (!fileSetting) {
    throw new Error(
      'AUTH=on 但缺少初始管理员密码：请设置 ADMIN_INITIAL_PASSWORD_FILE（指向仅本机可读的密码文件）',
    );
  }
  const filePath = path.isAbsolute(fileSetting) ? fileSetting : path.resolve(repoRoot, fileSetting);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw new Error('AUTH=on 但无法读取 ADMIN_INITIAL_PASSWORD_FILE（请检查路径与权限；内容不会打印）');
  }
  const initialPassword = raw.trim();
  if (!initialPassword) {
    throw new Error('AUTH=on 但 ADMIN_INITIAL_PASSWORD_FILE 内容为空');
  }
  try {
    const { created, user } = await users.ensureAdmin({
      username: config.adminUsername,
      initialPassword,
    });
    logger?.log?.(`[auth] 初始管理员 ${user.username} 已${created ? '创建' : '就绪'}（密码不打印）`);
    return user;
  } catch (error) {
    // HttpError(400) 等可能带“密码至少 8 位”等提示，天然不含明文密码，可直接透出。
    throw new Error(`AUTH=on 初始管理员初始化失败：${error?.message ?? error}`);
  }
}

/* ------------------------- 按用户数据作用域 ------------------------- */

/** 每用户作用域 ctx 缓存：baseCtx → Map<userId, Promise<scopedCtx>>（上限 32，LRU）。 */
const USER_CTX_CACHE_LIMIT = 32;
const userCtxCaches = new WeakMap();

async function createUserScopedCtx(baseCtx, userId, user) {
  const userDir = path.join(baseCtx.baseDataDir, 'users', userId);
  // 信封加密（KEK→DEK）。开启时先把用户目录里的旧 KEK 密文幂等迁移为 DEK 密文
  // （迁移必须先于任何 store 读取），再用 DEK 构造该用户的 at-rest 实例；失败 fail-fast 交给上层。
  let atRestKey = baseCtx.atRestKey;
  let envelopeStatus = 'off';
  if (baseCtx.config.atRestEnvelope && baseCtx.atRestKey) {
    try {
      const envelope = await ensureUserEnvelope({
        kek: baseCtx.atRestKey,
        dataDir: baseCtx.baseDataDir,
        userDir,
        userId,
        logger: baseCtx.logger,
      });
      atRestKey = envelope.dek;
      envelopeStatus = 'on';
      if (envelope.created || envelope.migrated > 0) {
        baseCtx.logger?.log?.(
          `[at-rest] 用户 ${userId} DEK ${envelope.created ? '已创建' : '已加载'}，迁移 ${envelope.migrated} 个文件`,
        );
      }
    } catch (error) {
      throw new Error(`信封加密初始化失败（用户 ${userId}）：${error?.message ?? error}`);
    }
  }
  // per-user at-rest：AAD = 相对该用户目录的路径（契约 11.1），与全局实例互相独立。
  const atRest = createAtRest({ key: atRestKey, dataDir: userDir, logger: baseCtx.logger });
  const store = await createStore({ dataDir: userDir, logger: baseCtx.logger, atRest });
  const health = await createHealthStore({ dataDir: userDir, config: baseCtx.config, logger: baseCtx.logger, atRest });
  const marks = await createMarksStore({
    dataDir: userDir,
    logger: baseCtx.logger,
    docStore: baseCtx.docStore,
    atRest,
  });
  const scaleHistory = await createScaleHistoryStore({
    dataDir: userDir,
    config: baseCtx.config,
    logger: baseCtx.logger,
    atRest,
  });
  const attachments = createAttachmentStore({
    dataDir: userDir,
    maxTotalMb: baseCtx.config.attachmentMaxMb,
    logger: baseCtx.logger,
    enabled: baseCtx.config.attachmentStorage,
    atRest,
  });
  const memory = createMemoryService({
    store,
    config: baseCtx.config,
    logger: baseCtx.logger,
    // BYOK 用户的记忆抽取走用户自己的模型（服务端代理）；官方用户保持原 callModel 行为。
    callModel: createMemoryExtractCaller({
      ctx: { ...baseCtx, userId, user },
      officialCallModel: baseCtx.callModel,
      logger: baseCtx.logger,
    }),
    extractPrompt: baseCtx.memoryPrompt.text,
  });
  if (memory && typeof memory.ready?.then === 'function') {
    try {
      await memory.ready;
    } catch (error) {
      baseCtx.logger?.warn?.(
        `[chat-terminal] 用户 ${userId} 记忆迁移失败（不阻塞启动）：${error?.message ?? error}`,
      );
    }
  }
  // 首次创建该用户作用域时清理一次孤儿附件（失败只 warn，不影响请求）。
  Promise.resolve()
    .then(() => sweepStoreAttachments({ attachments, store, logger: baseCtx.logger }))
    .catch((error) => {
      baseCtx.logger?.warn?.(`[chat-terminal] 用户 ${userId} 附件清理失败（忽略）：${error?.message ?? error}`);
    });
  return {
    ...baseCtx,
    userId,
    user,
    dataDir: userDir,
    userDir,
    store,
    memory,
    health,
    marks,
    scaleHistory,
    attachments,
    sessions: createSessionStore(),
    atRest,
    envelope: envelopeStatus,
  };
}

/**
 * 对所有 active 用户执行一次「过期未引用附件」清理（启动时后台执行）。
 * 仅当 config.attachmentRetentionDays > 0 时调用；失败逐用户 warn，不阻断启动。
 */
async function sweepExpiredAttachmentsForAllUsers(baseCtx) {
  if (!baseCtx.users || !baseCtx.attachments) return { removed: 0, bytes: 0 };
  let removed = 0;
  let bytes = 0;
  let users = [];
  try {
    users = await baseCtx.users.list();
  } catch (error) {
    baseCtx.logger?.warn?.(`[attachments] 读取用户列表失败，跳过过期附件清理：${error?.message ?? error}`);
    return { removed: 0, bytes: 0 };
  }
  for (const user of users) {
    if (!user || user.status !== 'active') continue;
    try {
      const scoped = await loadUserCtx(baseCtx, { user, userId: user.id });
      const conversations = scoped.store
        .listConversations()
        .map((summary) => scoped.store.getConversation(summary.id))
        .filter(Boolean);
      const memories = scoped.store.listMemories();
      const result = await cleanupExpiredAttachments({
        attachments: scoped.attachments,
        conversations,
        memories,
        config: baseCtx.config,
        logger: baseCtx.logger,
      });
      removed += result.removed;
      bytes += result.bytes;
    } catch (error) {
      baseCtx.logger?.warn?.(
        `[attachments] 用户 ${user.id} 过期附件清理失败（忽略）：${error?.message ?? error}`,
      );
    }
  }
  if (removed > 0) {
    baseCtx.logger?.log?.(`[attachments] 启动清理过期附件 ${removed} 个（${bytes} 字节）`);
  }
  return { removed, bytes };
}

/** 取（或创建）某用户的作用域 ctx；命中缓存时刷新 LRU 顺序并使 user 为本次认证的最新公开信息。 */
async function loadUserCtx(baseCtx, identity) {
  let cache = userCtxCaches.get(baseCtx);
  if (!cache) {
    cache = new Map();
    userCtxCaches.set(baseCtx, cache);
  }
  const hit = cache.get(identity.userId);
  if (hit) {
    cache.delete(identity.userId);
    cache.set(identity.userId, hit);
    const scoped = await hit;
    return { ...scoped, user: publicUser(identity.user) };
  }
  const pending = createUserScopedCtx(baseCtx, identity.userId, publicUser(identity.user));
  cache.set(identity.userId, pending);
  while (cache.size > USER_CTX_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  try {
    return await pending;
  } catch (error) {
    cache.delete(identity.userId);
    throw error;
  }
}

/**
 * 取管理员的作用域 ctx。
 * 仅 AUTH=on 且存在管理员时返回；用于 iOS 健康导入（token 是全局的，导入数据归属单户管理员）。
 */
async function loadAdminScopedCtx(baseCtx) {
  if (baseCtx.authMode !== 'on' || !baseCtx.users) return null;
  const list = await baseCtx.users.list();
  const admin = (list || []).find((user) => user.role === 'admin');
  if (!admin) return null;
  return loadUserCtx(baseCtx, { userId: admin.id, user: admin });
}

async function handleHealth(req, res, ctx) {
  const corpus = await ctx.corpusStats();
  // 服务健康字段保持兼容（既有测试/测试依赖），并追加记录摘要（前端健康面板用）。
  const healthData = ctx.health ? ctx.health.summaryPayload() : {
    lastImportedAt: null,
    updatedAt: null,
    days: {},
    summary: { last7: null },
  };
  sendJson(res, 200, {
    ok: true,
    version: ctx.version,
    model: ctx.config.model,
    defaultEffort: ctx.config.defaultEffort,
    mock: ctx.config.mock,
    // 实际生效的默认档位上限：显式 MAX_TOKENS 覆盖时即该值，auto 时等于 defaultEffort 分档值。
    maxTokens: resolveMaxTokens(ctx.config, ctx.config.defaultEffort),
    corpus,
    // storage 保持既有字段兼容，仅追加 atRest:'on'|'off'（不泄露密钥/路径）。
    // 追加 envelope:'on'|'off'（信封加密开关；旧字段逐字节不变）。
    storage: {
      ...ctx.store.health(),
      atRest: ctx.atRest?.enabled ? 'on' : 'off',
      envelope: ctx.config.atRestEnvelope ? 'on' : 'off',
    },
    uptimeSec: Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000)),
    // 记录（无数据时 days={}、lastImportedAt=null）：
    lastImportedAt: healthData.lastImportedAt,
    updatedAt: healthData.updatedAt,
    days: healthData.days,
    summary: healthData.summary,
    // 联网搜索能力与配置（WEBSEARCH=off 时 enabled=false，前端据此隐藏开关）。
    webSearch: {
      enabled: Boolean(ctx.config.websearch),
      provider: ctx.config.websearchProvider,
      maxCitations: ctx.config.websearchMaxCitations,
    },
    // AUTH=on 时追加认证模式（AUTH=off 时字段逐字节不变，保证旧断言零回归）。
    ...(ctx.authMode === 'on' ? { auth: { mode: 'on' } } : {}),
  });
}

async function handleDocs(req, res, ctx, rawDocId) {
  let docId;
  try {
    docId = decodeURIComponent(rawDocId ?? '');
  } catch {
    sendApiError(res, 400, 'INVALID_REQUEST', 'docId 编码不合法');
    return;
  }
  if (!DOC_ID_PATTERN.test(docId)) {
    sendApiError(res, 404, 'NOT_FOUND', '文档不存在');
    return;
  }
  const doc = ctx.docStore.get(docId);
  if (!doc) {
    sendApiError(res, 404, 'NOT_FOUND', '文档不存在');
    return;
  }
  sendJson(res, 200, doc);
}

function handleSession(req, res, ctx, rawSessionId) {
  let sessionId;
  try {
    sessionId = decodeURIComponent(rawSessionId ?? '');
  } catch {
    sendApiError(res, 400, 'INVALID_REQUEST', 'sessionId 编码不合法');
    return;
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    sendApiError(res, 400, 'INVALID_REQUEST', 'sessionId 格式不合法');
    return;
  }
  sendJson(res, 200, { sessionId, turns: ctx.sessions.getTurns(sessionId) });
}

/** 公网部署用的统一安全响应头（CSP 允许同源 CSS/脚本，不放开内联脚本）。 */
const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
  'content-security-policy':
    // 前端内联样式已清零（public/*.html + js 全量审计），CSP 去掉 style-src 的 unsafe-inline。
  "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'",
});

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/**
 * 同源检查（CSRF 防护）：拒绝跨站 POST/PATCH/DELETE。
 * - 无 Origin（curl/原生客户端/旧浏览器）放行；
 * - 配置 ALLOWED_ORIGINS（逗号分隔）时按白名单；
 * - 否则比较 Origin 的 host 与 Host / X-Forwarded-Host。
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowed.length > 0) return allowed.includes(origin);
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  const ownHost = forwarded || req.headers.host || '';
  return host === ownHost;
}

/** POST/PATCH/PUT 带 body 时要求 JSON Content-Type（防止跨站表单直投）。 */
function hasJsonContentType(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const length = Number(req.headers['content-length'] ?? 0);
  if (!length) return true;
  return /^application\/json/i.test(String(req.headers['content-type'] ?? ''));
}

/** 页面别名（干净 URL → 静态页面；页面自身在 AUTH=off 时跳回首页，不改变旧路由）。 */
const PAGE_ALIASES = Object.freeze({
  '/login': '/login.html',
  '/account': '/account.html',
  '/admin': '/admin.html',
  '/feedback': '/feedback.html',
});

/** 用基础 ctx 的路由（全局数据）；其余业务路由在 AUTH=on 时用按用户作用域的 scoped ctx。 */
const BASE_CTX_RESOURCES = new Set(['auth', 'me', 'feedback', 'admin', 'health', 'health-import']);

/** 主路由：只做分发与错误兜底，业务在各自模块。 */
export async function handleRequest(req, res, ctx) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const segments = pathname.split('/').filter(Boolean);

  applySecurityHeaders(res);
  // 每个请求生成 x-request-id（'r'+16hex），便于日志/证据串联（不引入外部 APM）。
  const requestId = ctx.lifecycle?.newRequestId?.() ?? `r${Date.now().toString(16).slice(-16)}`;
  res.setHeader('x-request-id', requestId);
  if (segments[0] === 'api') {
    if (!originAllowed(req)) {
      sendApiError(res, 403, 'FORBIDDEN', '跨站请求被拒绝');
      return;
    }
    if (!hasJsonContentType(req)) {
      sendApiError(res, 415, 'INVALID_REQUEST', 'Content-Type 必须为 application/json');
      return;
    }
  }

  const authMode = ctx.authMode === 'on' ? 'on' : 'off';
  let identity = null;
  /** 基础 ctx（全局数据）：AUTH=off 时就是共享 ctx 本身。 */
  let requestCtx = ctx;
  /** 业务路由的按用户作用域 ctx：AUTH=off 时与 requestCtx 为同一对象（逐字节零变化）。 */
  let scopedCtx = ctx;

  if (segments[0] === 'api' && authMode === 'on') {
    // 路径穿越防护（仅 AUTH=on 生效；off 模式保持既有 404 语义，避免破坏旧断言）。
    for (const segment of segments) {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        sendApiError(res, 400, 'BAD_PATH', '路径不合法');
        return;
      }
      if (decoded.includes('..') || decoded.includes('\0') || decoded.includes('/') || decoded.includes('\\')) {
        sendApiError(res, 400, 'BAD_PATH', '路径不合法');
        return;
      }
    }
    const resource = segments[1] ?? '';
    // 中间件顺序（契约 1）：origin(403) → content-type(415) → auth(401) → csrf(403) → admin(403)。
    if (!isPublicApi(pathname)) {
      identity = await ctx.auth.authenticate(req);
      if (!identity) {
        sendApiError(res, 401, 'UNAUTHORIZED', '请先登录');
        return;
      }
      requestCtx = { ...ctx, user: publicUser(identity.user), userId: identity.userId, requestId };
      if (csrfRequired(req.method, pathname) && !ctx.auth.verifyCsrf(req)) {
        sendApiError(res, 403, 'FORBIDDEN', 'CSRF 校验失败');
        return;
      }
      if (resource === 'admin' && requestCtx.user?.role !== 'admin') {
        sendApiError(res, 403, 'FORBIDDEN', '需要管理员权限');
        return;
      }
      if (!BASE_CTX_RESOURCES.has(resource)) {
        // 业务路由：按用户隔离的 scoped ctx（缓存 Map<uid, Promise<ctx>>，上限 32 LRU）。
        scopedCtx = await loadUserCtx(ctx, identity);
      }
    }
    // /api/health 是公开 API（未登录可探活，响应字段不变），但 AUTH=on 且已登录时
    // 读写的必须是本人记录（迁移后 health.json 在 users/<uid>/ 下）。匿名请求继续走基础 ctx。
    if (resource === 'health' && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE')) {
      const healthIdentity = await ctx.auth.authenticate(req);
      if (healthIdentity) {
        requestCtx = { ...ctx, user: publicUser(healthIdentity.user), userId: healthIdentity.userId, requestId };
        scopedCtx = await loadUserCtx(ctx, healthIdentity);
        if (req.method === 'DELETE' && !ctx.auth.verifyCsrf(req)) {
          sendApiError(res, 403, 'FORBIDDEN', 'CSRF 校验失败');
          return;
        }
      } else if (req.method === 'DELETE') {
        sendApiError(res, 401, 'UNAUTHORIZED', '请先登录');
        return;
      }
    }
    // iOS 健康导入入口保持 X-Health-Token 不变；AUTH=on 时导入数据归属管理员
    // （单户部署：站点唯一的历史数据/健康面板都属于管理员），写入 users/<adminId>/health.json。
    if (resource === 'health-import') {
      try {
        const adminCtx = await loadAdminScopedCtx(ctx);
        if (adminCtx) scopedCtx = adminCtx;
      } catch (error) {
        ctx.logger?.warn?.(`[health-import] 管理员作用域加载失败，回退基础 ctx：${error?.message ?? error}`);
      }
    }
  } else if (segments[0] === 'api' && authMode !== 'on') {
    // AUTH=off：旧单用户路径。除 /api/auth/me（前端探测认证模式，恒 200）外不挂载多用户路由。
    const resource = segments[1] ?? '';
    if (resource === 'auth') {
      if (!(segments.length === 3 && segments[2] === 'me')) {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      await handleAuthRoutes(req, res, requestCtx, segments);
      return;
    }
  }

  if (segments[0] === 'api') {
    const resource = segments[1] ?? '';

    // 认证 / 当前用户 / 反馈 / 管理员路由（基础 ctx；AUTH=off 时仅 /api/auth/me 挂载）。
    if (resource === 'auth') {
      await handleAuthRoutes(req, res, requestCtx, segments);
      return;
    }
    if (authMode === 'on' && resource === 'me' && segments[2] === 'feedback') {
      // GET /api/me/feedback 属于反馈模块（契约 11.6 完整 segments 传入）。
      await handleFeedback(req, res, requestCtx, segments);
      return;
    }
    if (authMode === 'on' && resource === 'me' && segments[2] === 'byok') {
      // BYOK 配置接口（GET/PUT/DELETE /api/me/byok + POST /api/me/byok/check）。
      await handleByok(req, res, requestCtx, segments);
      return;
    }
    if (authMode === 'on' && resource === 'me') {
      // 合规扩展（consent/export/DELETE 账号）需要 per-user scoped ctx（本人数据），
      // 不能复用 base ctx（否则 export 会读到根目录单用户数据）；consent/DELETE 统一走 scoped 更稳。
      const isMeDataRoute =
        (segments.length === 2 && req.method === 'DELETE') ||
        (segments.length === 3 && (segments[2] === 'consent' || segments[2] === 'export'));
      if (isMeDataRoute && identity) {
        const meCtx = await loadUserCtx(ctx, identity);
        if (await handleMeData(req, res, meCtx, segments)) return;
      }
      await handleMeRoutes(req, res, requestCtx, segments);
      return;
    }
    if (authMode === 'on' && resource === 'feedback') {
      await handleFeedback(req, res, requestCtx, segments);
      return;
    }
    if (authMode === 'on' && resource === 'admin') {
      await handleAdmin(req, res, requestCtx, segments);
      return;
    }

    if (resource === 'health') {
      if (segments.length !== 2) {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        // AUTH=on 且已登录时 scopedCtx 指向本人分区；匿名/off 时等于基础 ctx。
        await handleHealth(req, res, scopedCtx);
        return;
      }
      if (req.method === 'DELETE') {
        // AUTH=on：清空记录仅管理员（api/health 是公开 API，中间件已补 auth→csrf；这里补 admin）。
        // AUTH=on 时 scopedCtx 指向管理员本人分区，清空的是管理员自己的记录。
        if (authMode === 'on' && requestCtx.user?.role !== 'admin') {
          sendApiError(res, 403, 'FORBIDDEN', '需要管理员权限');
          return;
        }
        const { cleared } = await scopedCtx.health.clear();
        sendJson(res, 200, { ok: true, cleared });
        return;
      }
      // 保持既有行为：GET/HEAD/DELETE 之外 /api/health 返回 404（不暴露方法集）。
      sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
      return;
    }
    if (resource === 'health-import') {
      // iOS 快捷指令导入入口：不走站点 Basic Auth（nginx 层例外），用 X-Health-Token 鉴权。
      // AUTH=on 时 scopedCtx 指向管理员分区（单户部署），导入后用户健康面板可见。
      if (segments.length !== 2) {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      await handleHealthImport(req, res, scopedCtx);
      return;
    }
    if (resource === 'library') {
      // 文档库入口：启动时已构建并缓存，只读无副作用，可并发。
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      if (segments.length !== 2) {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      sendJsonText(res, 200, scopedCtx.library.json());
      return;
    }
    if (resource === 'chat') {
      if (segments.length !== 2 || req.method !== 'POST') {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      await handleChat(req, res, scopedCtx);
      return;
    }
    if (resource === 'docs') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      if (segments.length !== 3) {
        sendApiError(res, 404, 'NOT_FOUND', '文档不存在');
        return;
      }
      await handleDocs(req, res, scopedCtx, segments[2]);
      return;
    }
    if (resource === 'session') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
        return;
      }
      if (segments.length !== 3) {
        sendApiError(res, 400, 'INVALID_REQUEST', '缺少 sessionId');
        return;
      }
      handleSession(req, res, scopedCtx, segments[2]);
      return;
    }
    if (resource === 'conversations') {
      await handleConversations(req, res, scopedCtx, segments);
      return;
    }
    if (resource === 'memories') {
      await handleMemories(req, res, scopedCtx, segments);
      return;
    }
    if (resource === 'attachments') {
      // GET/HEAD /api/attachments/{id} 返回图片二进制（未知/非法 404）。
      await handleAttachments(req, res, scopedCtx, segments);
      return;
    }
    if (resource === 'marks') {
      await handleMarks(req, res, scopedCtx, segments);
      return;
    }
    if (resource === 'scales') {
      // 自评问卷：计分纯内存、无题面/答案落盘；起结果摘要保存到问卷历史（见 scales-history.mjs）。
      await handleScales(req, res, segments, scopedCtx);
      return;
    }
    sendApiError(res, 404, 'NOT_FOUND', '接口不存在');
    return;
  }

  // /login、/account、/admin、/feedback 干净 URL 别名到对应静态页（页面在 AUTH=off 时自行跳回首页）。
  const aliasPath = PAGE_ALIASES[pathname];
  await handleStatic(req, res, ctx.staticDir, aliasPath ?? pathname);
}

/**
 * 创建 HTTP 服务（未 listen）。
 * @returns {Promise<import('node:http').Server & {ctx: object}>}
 */
export async function createServer(options = {}) {
  const ctx = await createContext(options);
  const server = http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((error) => {
      ctx.logger?.error?.('[http] 未捕获异常：', error);
      if (!res.headersSent) {
        sendApiError(res, 500, 'INTERNAL', '服务器内部错误');
      } else {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
    });
  });
  server.on('clientError', (_error, socket) => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  });
  server.ctx = ctx;
  return server;
}

