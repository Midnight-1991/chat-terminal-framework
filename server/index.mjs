// server 公共导出。
export { createServer, createContext, handleRequest, defaultRepoRoot } from './app.mjs';
export {
  loadConfig,
  resolveApiKey,
  readApiKeyFromCredentials,
  EFFORTS,
  EFFORT_MAX_TOKENS,
  RERANK_MODES,
  QUERY_EXPAND_MODES,
  resolveMaxTokens,
  messagesUrl,
} from './config.mjs';
export {
  loadSystemPrompt,
  loadMemoryExtractPrompt,
  loadWebSearchRules,
  buildTurnText,
  PROMPT_FILES,
  OPTIONAL_PROMPT_FILES,
  PROMPT_SEPARATOR,
  MEMORY_EXTRACT_PROMPT_FILE,
  WEB_SEARCH_RULES_FILE,
} from './prompts.mjs';
export { loadCorpus, CORPUS_META_PREFIX } from './corpus.mjs';
export { createDocStore, DOC_ID_PATTERN } from './docstore.mjs';
export {
  createLibrary,
  THEMES_UNAVAILABLE,
  TAXONOMY_FILE,
  TAXONOMY_UNAVAILABLE,
  libraryItemKey,
  taxonomyReferenceKey,
  FIXED_GROUP_META,
  WORKSHEET_SITES,
  PUBLIC_DOMAIN_LICENSE,
  GOVERNMENT_LICENSE,
} from './library.mjs';
export { createSessionStore, MAX_MESSAGES, MAX_ROUNDS } from './sessions.mjs';
export { retrieveCitations, publicCitations } from './citations.mjs';
export {
  buildUpstreamBody,
  streamUpstream,
  createCallModel,
  UpstreamFailure,
  ClientAbortError,
} from './upstream.mjs';
export { buildMockAnswer, runMockStream, MOCK_THINKING_SEGMENTS } from './mock.mjs';
export { handleChat, MAX_HISTORY_MESSAGES, WEBSEARCH_MODES } from './chat.mjs';
export { handleConversations, validateTitle, MAX_TITLE_CHARS } from './conversations.mjs';
export {
  createMemoryService,
  handleMemories,
  parseExtractOutput,
  mockExtractMemories,
  buildExtractPrompt,
  normalizeMemoryText,
  jaccardSimilarity,
  isDuplicateText,
  triviaRelevance,
  hasRecallIntent,
  selectInjectable,
  MEMORY_KINDS,
  MEMORY_LEVELS,
  MEMORY_CORE_CATEGORIES,
  MEMORY_SOURCES,
  MEMORY_HEADING,
  MAX_EXTRACT_ITEMS,
  MAX_EXTRACT_CHARS,
  MAX_INJECT_CORE,
  MAX_INJECT_TRIVIA,
  TRIVIA_RELEVANCE_MIN,
  EVENT_MARKERS,
  hasEventMarkers,
  charBigrams,
  diceCoefficient,
  containmentRatio,
  applyOverlapRules,
  migrateOverlaps,
  trimEventOverlap,
} from './memory.mjs';
export {
  createMarksStore,
  handleMarks,
  newMarkId,
  MarksError,
  MARKS_LIMITS,
  MARKS_FILE_NAME,
  MARK_ID_RE,
  MARK_KINDS,
} from './marks.mjs';
export {
  createStore,
  deriveTitle,
  STORE_LIMITS,
  MEMORY_FILE_VERSION,
  MEMORY_CATEGORY_PRIORITY,
  MEMORY_SIMILARITY,
  CONVERSATION_ID_RE,
  MEMORY_ID_RE,
} from './store.mjs';
export {
  SCALES_UPDATED_AT,
  SCALES_DISCLAIMER,
  SAFETY_ADVISORY,
  BUILTIN_SCALE_IDS,
  SCALE_IDS,
  registerPrivateScales,
  listScalesPayload,
  getScalePayload,
  scoreScale,
  handleScales,
  getScaleHistoryMeta,
} from './scales.mjs';
export {
  PRIVATE_SCALES_DIR_NAME,
  privateScalesDir,
  loadPrivateScalePacks,
} from './scales-private.mjs';
export {
  createScaleHistoryStore,
  normalizeScaleHistoryEntry,
  normalizeScaleHistoryKind,
  SCALE_HISTORY_FILE_NAME,
  SCALE_HISTORY_FILE_VERSION,
  SCALE_HISTORY_MAX_ENTRIES,
  SCALE_HISTORY_RETENTION_DAYS_DEFAULT,
  SCALE_HISTORY_RETENTION_DAYS_MAX,
  SCALE_HISTORY_QUERY_LIMIT_DEFAULT,
  SCALE_HISTORY_QUERY_LIMIT_MAX,
  SCALE_HISTORY_INJECT_MAX_CHARS,
  SCALE_HISTORY_INJECT_MAX_SCALES,
  SCALE_HISTORY_INJECT_WINDOW_DAYS,
  SCALE_HISTORY_INJECT_LINE_MAX_CHARS,
  SCALE_HISTORY_INJECT_TITLE,
  SCALE_HISTORY_INJECT_FOOTER,
  SCALE_HISTORY_ENTRY_ID_RE,
  SCALE_HISTORY_KINDS,
} from './scales-history.mjs';
export { SSE_HEADERS, parseSSEStream, parseSSEBlock } from './sse.mjs';
export {
  createAttachmentStore,
  handleAttachments,
  sweepStoreAttachments,
  persistParsedImage,
  persistAttachmentImages,
  collectReferencedAttachmentIds,
  attachmentIdFor,
  attachmentPreviewUrl,
  isAttachmentId,
  ATTACHMENT_DIR_NAME,
  ATTACHMENT_ID_RE,
  ATTACHMENT_CACHE_CONTROL,
  ATTACHMENT_EXT_BY_MIME,
  DEFAULT_ATTACHMENT_MAX_MB,
} from './attachments.mjs';
export {
  setupAtRest,
  hasEncryptedDataFiles,
  createAtRest,
  loadEncryptionKey,
  readEncryptionKeyFile,
  decodeKeyBase64,
  migrateDataDir,
  listDataFiles,
  listKnownDataFilesInDir,
  listDirFiles,
  isEncryptedBuffer,
  encodePayload,
  decodePayload,
  isAtRestError,
  AtRestError,
  AT_REST_MAGIC,
  AT_REST_FORMAT_VERSION,
  AT_REST_ALGO,
  AT_REST_KEY_BYTES,
  AT_REST_IV_BYTES,
  AT_REST_TAG_BYTES,
  AT_REST_OVERHEAD_BYTES,
  AT_REST_DATA_FILES,
  AT_REST_ERROR_CODES,
} from './at-rest.mjs';
export {
  createHealthStore,
  handleHealthImport,
  tokenMatches,
  parseHealthPayload,
  normalizeMetrics,
  aggregateSamples,
  buildLast7Summary,
  buildInjectSuffix,
  formatLocalDate,
  HEALTH_FILE_NAME,
  HEALTH_FILE_VERSION,
  HEALTH_IMPORT_BODY_LIMIT,
  HEALTH_INJECT_MAX_CHARS,
  HEALTH_INJECT_TITLE,
  HEALTH_METRIC_KEYS,
} from './health.mjs';
export {
  createWebSearch,
  enabled as webSearchEnabled,
  shouldSearch as shouldWebSearch,
  containsCrisisKeyword,
  redactQuery,
  hashQuery,
  normalizeResults as normalizeWebResults,
  searchWeb,
  mockResults as mockWebResults,
  CRISIS_KEYWORDS,
  WEBSEARCH_MOCK_MODES,
  WEBSEARCH_SEARCH_PATH,
  WEBSEARCH_PROVIDER_DEFAULT,
  WEBSEARCH_RETRY_DELAY_MS,
  MAX_QUERY_CHARS as WEBSEARCH_MAX_QUERY_CHARS,
  MAX_WEB_SUMMARY_CHARS,
} from './websearch.mjs';

// 多用户认证、配额、限流、反馈与管理员模块（ 起对外导出）。
export {
  USERNAME_PATTERN,
  PASSWORD_MIN,
  PASSWORD_MAX,
  ROLES,
  STATUSES,
  USERS_FILE_NAME,
  USERS_FILE_VERSION,
  DISPLAY_NAME_MAX,
  MODEL_SOURCES,
  SCRYPT_PARAMS,
  hashPassword,
  verifyPassword,
  publicUser,
  createUserService,
} from './users.mjs';
export {
  SESSIONS_FILE_NAME,
  SESSIONS_FILE_VERSION,
  SESSION_ID_PATTERN,
  DEFAULT_TTL_MS,
  createSessionService,
} from './user-sessions.mjs';
export {
  AUTH_MODES,
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_TOKEN_PATTERN,
  PUBLIC_API,
  parseCookies,
  isPublicApi,
  csrfRequired,
  createAuthService,
} from './auth.mjs';
export { handleAuthRoutes, handleMeRoutes } from './auth-routes.mjs';
export {
  USAGE_VERSION,
  TOKEN_FIELDS,
  USAGE_TIME_ZONE,
  USAGE_LOAD_DAYS,
  USAGE_SUMMARY_MAX_RANGE_DAYS,
  USAGE_STATUSES,
  normalizeUsage,
  usageTotalTokens,
  cacheHitRate,
  costOf,
  localDateKey,
  createUsageService,
} from './usage.mjs';
export { createRateLimiter, RATE_LIMIT_DEFAULTS } from './ratelimit.mjs';
export {
  INVITES_FILE_NAME,
  SETTINGS_FILE_NAME,
  INVITE_CODE_RE,
  createInviteStore,
  createSettingsStore,
  handleAdmin,
} from './admin.mjs';
export {
  FEEDBACK_STATUSES,
  FEEDBACK_MAX_CHARS,
  FEEDBACK_FILE_NAME,
  createFeedbackService,
  handleFeedback,
} from './feedback.mjs';
export {
  BYOK_PROTOCOLS,
  BYOK_PRESETS,
  MODEL_PATTERN,
  ByokError,
  resolveProvider,
  buildHeaders,
  buildRequestBody,
  buildChatUrl,
  parseStreamEvent,
  extractUsage,
  listModelsUrl,
  parseModels,
} from './byok-providers.mjs';
export {
  createByokService,
  resolveChatModelSource,
  redactSecrets,
  BYOK_META_FILE_NAME,
  BYOK_SECRET_ENC_FILE_NAME,
  BYOK_SECRET_PLAIN_FILE_NAME,
  BYOK_VERSION,
  BYOK_SECRET_AAD_PREFIX,
} from './byok.mjs';
export { handleByok } from './byok-routes.mjs';
export { ByokUpstreamFailure, BYOK_UPSTREAM_ERROR_CODES, streamByokUpstream } from './byok-upstream.mjs';

export {
  ENVELOPE_MAGIC,
  ENVELOPE_FORMAT_VERSION,
  ENVELOPE_DEK_BYTES,
  ENVELOPE_DEK_FILE_NAME,
  ENVELOPE_DEK_AAD_PREFIX,
  ENVELOPE_ERROR_CODES,
  EnvelopeError,
  isEnvelopeError,
  wrapDek,
  unwrapDek,
  loadUserDek,
  backupDataDirOnce,
  migrateUserDirToEnvelope,
  ensureUserEnvelope,
} from './envelope.mjs';
export {
  buildExtractRequest,
  parseExtractResponse,
  extractViaByok,
  createMemoryExtractCaller,
} from './memory-extract.mjs';

// ~ 运行时、审计、合规、BYOK 钉扎、峰谷策略（ ~  对外导出）。
export {
  createLifecycle,
  LIFECYCLE_DEFAULT_TIMEOUT_MS,
  REQUEST_ID_PATTERN,
} from './lifecycle.mjs';
export {
  createAuditLog,
  AUDIT_FILE_NAME,
  AUDIT_RETENTION_DAYS,
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMIT_MAX,
} from './audit.mjs';
export { CONSENT_VERSION, CONSENT_DOCS, consentView } from './consent.mjs';
export { handleMeData, EXPORT_VERSION, EXPORT_USAGE_DAYS } from './me-data.mjs';
export {
  PINNED_DEFAULT_TIMEOUT_MS,
  parseIPv4,
  parseIPv6Bytes,
  isForbiddenIPv4,
  isForbiddenIPv6,
  isForbiddenHostname,
  isAllowedAddress,
  isLoopbackAddress,
  createAddressValidator,
  createPinnedLookup,
  createPinnedTransport,
  createFetchTransport,
  pinnedRequest,
  pinnedReadText,
  pinnedTransport,
} from './pinned-http.mjs';
export {
  DEFAULT_PEAK_HOURS_UTC,
  PEAK_POLICY_VALUES,
  parsePeakHours,
  isPeakTime,
  resolveOfficialModel,
} from './model-policy.mjs';
