# Chat Terminal Framework

**A zero-dependency, self-hosted AI chat terminal framework for Node.js.**

Chat Terminal Framework ships the generic kernel of a self-hosted AI chat product: streaming chat over SSE,
sessions and long-term memory, local retrieval-augmented generation, a document library with snippets,
attachments, optional multi-user auth with an admin console, and a plain-JS PWA front end.

**Why:** own your data (everything stays in `DATA_DIR`), swap prompts and knowledge base without touching the
core, and run a single Node.js process with no database, no build step and no runtime npm dependency.

**Quick start:** `cp .env.example .env && CHAT_MOCK=1 node bin/serve.mjs` → open http://127.0.0.1:8787

自托管的通用 AI 对话终端框架：流式对话、会话与长期记忆、本地检索增强（RAG）、文档库与收藏片段、
附件、可选多用户与管理后台，数据全部留在你自己的 `DATA_DIR` 里；提示词、知识库、问卷与主题都是
可替换的内容层。

> **状态**：0.2.1（首个公开版本）｜**许可**：代码 Apache-2.0，文档 CC BY 4.0｜**运行时**：Node.js ≥ 22，零运行时依赖｜**测试**：`npm test` 668 项通过｜**分发**：源码包（未发布 npm 包，无容器镜像）

## 它解决什么 / 设计原则

- **自托管、数据自有**：单进程 Node 服务；会话、记忆、附件、账号都在 `DATA_DIR` 里，不依赖外部数据库或对象存储。
- **通用内核 × 可替换内容层**：提示词、知识库、问卷、主题通过扩展点接入，核心代码不绑定具体业务；默认随包只有少量自撰演示内容（示例提示词与 3 篇演示文档）。
- **零运行时依赖**：只用 Node 内置模块，无需 `npm install`；前端是原生 JS + CSS，无构建步骤。
- **默认收敛暴露面**：模型密钥只存服务端；`AUTH` 默认关闭，需要多用户时再开；静态加密可选；没有遥测与第三方统计。
- **可运维**：状态接口、审计日志、备份/恢复/恢复演练、密钥轮换、限流与配额都是一等能力。

## 特性

| 能力 | 说明 |
|---|---|
| 流式对话 | SSE 推送、逐字输出；支持 mock 模式离线演示 |
| 会话与长期记忆 | 会话持久化；后台抽取稳定记忆，后续对话按需注入（可关） |
| 本地检索增强 | 零依赖中文分词与 bigram 检索、可选查询扩展与重排；引用按文档锚点回链 |
| 文档库 | 按分类浏览文档与章节目录，直达原文；分类与文档由 `corpus/` 元数据驱动，可整体替换；随包仅 3 篇演示文档 |
| 收藏片段 | 文档级收藏与段落级摘录，可定位、复制、删除 |
| 模板卡 | 卡片清单由 `corpus/_worksheets.json` 驱动，可整体替换；随包不含演示卡元数据，需自备 |
| 记录 | 可选的记录导入与按日聚合摘要（最近 7 天视图、保留期、一键清空）；只存摘要，不存原始明细 |
| 附件与图片 | 附件持久化到数据目录，按内容哈希去重 |
| 多用户与配额 | 可选的注册登录、会话隔离、速率限制与管理员后台 |
| 数据安全 | 可选 at-rest 加密（AES-256-GCM）、密钥轮换；模型密钥只存服务端 |
| 可替换内容层 | 提示词包、文档库与模板卡内容、问卷、主题文案均可替换，无需改核心代码 |
| 零依赖前端 | 原生 JS + CSS，无构建步骤，可直接用任意静态服务器托管 |

## 同类项目与定位

一句话：Chat Terminal Framework 是**可审计、可嵌入、可扩展的自托管 AI 对话内核**——不是多模型控制台，不是应用编排平台，也不是文档解析引擎。它把「对话 + 本地知识检索 + 多用户 + 数据自有 + 运维能力」收进一个零依赖的 Node.js 单进程里，方便小团队自托管，或作为产品底座二次开发。

下表的邻近项目都很优秀，多数也比本项目成熟得多（头部项目数万至十余万 stars，2026-11 快照）。它们位于不同层次、解决不同问题，按需选择：

**适合谁**：希望自托管、数据留在本地、又不想为一次对话引入整套平台的团队；以及需要把对话能力嵌入自己产品、并替换内容层的开发者。

**我们没有现成的直接同类**：本次调研中，「零依赖 Node 单进程 + 内置中文 BM25F 检索 + 多用户 + 内容层可替换」这一组合未发现现成项目；最接近的是 AnythingLLM（产品形态）与 LibreChat（Node.js 技术栈），但它们依赖外部数据库、向量库或嵌入模型，也未把内容层与领域包作为一等概念。

| 项目 | 形态 / 技术栈 | License | 何时选它 |
|---|---|---|---|
| [Open WebUI](https://github.com/open-webui/open-webui) | 自托管多模型聊天控制台（Python / Svelte，容器交付） | 自定义许可（GitHub 标 Other；使用前读仓库 LICENSE） | 要开箱即用的多模型聊天与知识库全家桶，以容器方式部署 |
| [LobeHub（原 Lobe Chat）](https://github.com/lobehub/lobehub) | 多模型聊天与 Agent 平台（TypeScript / React） | 自定义许可（GitHub 标 Other，以仓库为准） | 看重前端体验与插件/助手生态，接受较重技术栈 |
| [NextChat](https://github.com/ChatGPTNextWeb/NextChat) | 零配置多端聊天客户端（TypeScript，Web / 桌面 / 移动） | MIT | 主要需要客户端体验与多端使用，服务端能力非重点 |
| [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | 本地优先的文档问答工作台（Node.js 全栈，可桌面 / 容器） | MIT | 团队文档问答、桌面或容器部署，接受嵌入模型与向量库 |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | 自托管多 provider 对话平台（Node.js / TypeScript + MongoDB） | MIT | 要成熟的多用户、多模型接入与助手生态 |
| [Dify](https://github.com/langgenius/dify) | LLM 应用编排与 RAG 平台（Python / TypeScript） | 自定义许可（GitHub 标 Other，以仓库 LICENSE 为准） | 需要可视化工作流、应用编排与团队级 AI 应用平台 |
| [RAGFlow](https://github.com/infiniflow/ragflow) | RAG 引擎与上下文基础设施（Go / Python） | Apache-2.0 | 重点在复杂文档解析（表格 / 扫描件 / OCR）与检索管线 |
| [FastGPT](https://github.com/labring/FastGPT) | 中文知识库与可视化工作流平台（TypeScript） | 自定义许可（GitHub 标 Other，以仓库为准） | 需要中文知识库、可视化编排与运营后台 |
| [Khoj](https://github.com/khoj-ai/khoj) | 个人 AI 第二大脑（Python） | AGPL-3.0 | 个人知识管理、自动化与深度检索 |
| [MaxKB](https://github.com/1Panel-dev/MaxKB) | 企业知识库问答平台（Python / Django） | GPL-3.0 | 企业内嵌问答与运营管理，接受 GPL 与较重部署 |

### 什么情况下该用它们

- 需要「多模型切换 + 插件 / 助手生态」的通用聊天控制台 → Open WebUI、LibreChat。
- 需要可视化编排 AI 应用或 RAG 工作流 → Dify、FastGPT。
- 核心难点是复杂文档解析（PDF 表格、扫描件 OCR）→ RAGFlow。
- 团队文档问答且偏好桌面 / 容器一体化 → AnythingLLM。
- 主要诉求是多端轻客户端与对话体验 → NextChat、LobeHub。

### 我们的取舍（诚实版）

- **零依赖换来了什么**：没有数据库、向量库、嵌入模型与构建链，`cp .env.example .env` 即可启动；代价是检索用词法 BM25F（中文分词 + bigram），可解释、零 embedding 成本，但语义召回弱于向量或混合方案。
- **单进程换来了什么**：部署与备份都围绕一个 `DATA_DIR`；代价是不做水平扩展与多实例共享存储。
- **内容层可替换**：提示词、文档库、问卷与主题可整体替换，适合做领域包；但生态与插件数量远不能和大平台相比。
- **安全与运维是一等公民**：at-rest 加密、BYOK、审计、备份 / 恢复演练、限流与配额内置，默认收敛暴露面。
- **定位**：适合内网小团队、需要二次开发的产品底座、以及「先跑起来再扩展」的场景；若你要的正是上面某类平台能力，请优先选对应项目。

> **诚实声明**：以上对比基于 2026-11 的公开信息（GitHub 仓库页与许可证标识），项目能力与许可可能随时间变化，请以各仓库最新 LICENSE 与文档为准。表中部分项目为自定义许可（GitHub 显示 Other / NOASSERTION），使用或分发前请阅读原文判断；本项目代码为 Apache-2.0。此处只做定位说明，不复制它们的代码或文案。

## 快速开始

要求：Node.js ≥ 22，无其他依赖。所有命令都在**发布树根目录**执行。

### A. 30 秒 mock 体验（不需要模型密钥）

```bash
cp .env.example .env
CHAT_MOCK=1 node bin/serve.mjs
```

打开 http://127.0.0.1:8787 即可对话（回复来自本地 mock 规则，不调用任何外部服务）。
另开一个终端验证服务状态：

```bash
curl -s http://127.0.0.1:8787/api/health
```

期望输出（节选；实际响应还包含 `model` / `corpus` / `storage` 等字段，`mock` 应为 `true`）：

```json
{"ok":true,"version":"0.2.1","mock":true}
```

### B. 接入真实模型（Anthropic Messages 协议兼容服务）

```bash
cp .env.example .env
# 编辑 .env：至少填入 DEEPSEEK_API_KEY；
# 换其他 Anthropic Messages 兼容端点时，同时改 DEEPSEEK_BASE_URL（默认 https://api.deepseek.com/anthropic）与 MODEL。
npm start
```

访问 http://127.0.0.1:8787，首轮对话会走真实上游模型。

### C. 多用户 / 生产部署

```bash
# 1) 生成初始管理员密码文件（仅本机可读）
mkdir -p secrets
printf '%s' 'change-me-to-a-long-password' > secrets/admin-initial-password
chmod 600 secrets/admin-initial-password

# 2) 生成数据加密密钥，按输出填写到 .env 的 DATA_ENCRYPTION_KEY
openssl rand -base64 32

# 3) .env 关键项
#    AUTH=on
#    ADMIN_USERNAME=admin
#    ADMIN_INITIAL_PASSWORD_FILE=./secrets/admin-initial-password
#    DATA_ENCRYPTION_KEY=<上一步生成的密钥>
#    HOST=127.0.0.1
#    AUTH_COOKIE_SECURE=1
#    AUTH_SESSION_TTL_DAYS=7               # 可选：登录态有效期（天）

npm start
```

首次启动会用初始密码文件创建管理员（之后该文件可删除、密码请立即改掉）。默认邀请制
（`INVITE_ONLY=on`）：管理员在后台创建邀请码，用户凭邀请码注册。生产环境请把服务放在
TLS 反向代理之后，只让代理访问 `127.0.0.1:8787`（见「部署与运维」）。

## 配置速查

完整注释与默认值见 [`.env.example`](.env.example)；`AUTH=on` 首次启动所需的 `ADMIN_INITIAL_PASSWORD_FILE`、`INVITE_ONLY` 等变量定义在 `server/config.mjs`。

| 分组 | 变量 | 默认 | 说明 |
|---|---|---|---|
| 上游模型 | `DEEPSEEK_API_KEY` | 空 | 上游 API key；留空时可用 `CHAT_MOCK=1` 或（`AUTH=on` 时）用户自带密钥 |
| 上游模型 | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | Anthropic Messages 协议服务的 base URL（默认 DeepSeek Anthropic 端点）；BYOK 另支持 OpenAI 兼容端点 |
| 上游模型 | `MODEL` | 见 `.env.example` | 模型名，可替换为服务商支持的任意模型 |
| 上游模型 | `MAX_TOKENS` | auto | 单轮输出上限；留空按模型上限解析 |
| 上游模型 | `CHAT_MOCK` | `0` | `1` = 本地 mock，不调用上游模型 |
| 监听 | `PORT` / `HOST` | `8787` / `0.0.0.0` | 端口与监听地址；生产建议 `HOST=127.0.0.1` |
| 对话能力 | `MEMORY` | `1` | 长期记忆抽取与注入开关 |
| 对话能力 | `MEMORY_MAX` | `20` | 单次注入的记忆条数上限 |
| 对话能力 | `RERANK` | `off` | `off` / `llm`：检索结果重排（`llm` 会多一次模型调用） |
| 对话能力 | `QUERY_EXPAND` | `heuristic` | `off` / `heuristic` / `llm`：查询扩展 |
| 对话能力 | `WEBSEARCH` | `off` | 联网搜索开关（关闭时前端隐藏入口） |
| 存储 | `DATA_DIR` | `./data` | 运行时数据目录（已 gitignore） |
| 存储 | `DATA_ENCRYPTION_KEY` / `DATA_ENCRYPTION_KEY_FILE` | 空 | 开启 at-rest 加密的 32 字节密钥（base64）或 600 权限密钥文件 |
| 鉴权 | `AUTH` | `off` | `on` 启用注册登录、会话隔离、配额与管理后台 |
| 鉴权 | `ADMIN_USERNAME` | `admin` | 初始管理员用户名 |
| 鉴权 | `ADMIN_INITIAL_PASSWORD_FILE` | 空 | `AUTH=on` 首次启动必需：初始管理员密码文件路径 |
| 鉴权 | `INVITE_ONLY` | `on` | 注册是否必须使用邀请码 |
| 鉴权 | `AUTH_COOKIE_SECURE` | `on` | HTTPS 生产保持开启；本地 http 调试可设 `0` |
| 鉴权 | `RATE_PER_MINUTE` / `RATE_CONCURRENCY` | `20` / `2` | 每用户每分钟请求上限与并发上限 |
| 鉴权 | `QUOTA_DAY_TOKENS` / `QUOTA_MONTH_TOKENS` | `200000` / `2000000` | 每用户每日/每月 token 配额 |
| 附件 | `ATTACHMENT_STORAGE` / `ATTACHMENT_MAX_MB` | `1` / `512` | 附件是否持久化到 `DATA_DIR/attachments` 及总容量上限 |
| 自评问卷 | `SCALE_HISTORY` / `SCALE_HISTORY_INJECT` | `1` / `1` | 是否保存结果摘要、是否在对话中注入历史摘要 |
| 自评问卷 | `SCALE_HISTORY_RETENTION_DAYS` | `730` | 结果摘要保留天数 |
| 自评问卷 | 私有问卷包 | 固定 | 固定在 `DATA_DIR` 下，不可配置 |

## 架构与数据流

```text
浏览器 / PWA (public/)
   │  HTTP + SSE
   ▼
server/app.mjs      路由 / 鉴权 / 限流 / 安全响应头 / 静态文件
   │
   ├── server/chat.mjs              对话流水线：提示词拼装 → 检索 → 记忆注入 → 上游 SSE
   ├── server/sessions.mjs          会话消息；server/conversations.mjs  会话历史
   ├── server/memory*.mjs           长期记忆抽取与注入
   ├── server/corpus.mjs            文档与元数据加载（corpus/*.json）
   ├── server/library.mjs           文档库分类与元数据
   ├── server/docstore.mjs          原文读取与段落锚点
   ├── server/marks.mjs             收藏片段（文档级收藏 / 段落级摘录）
   ├── server/rag.mjs + rag/        检索实现（可替换适配器）
   ├── server/auth*.mjs / users.mjs 注册登录、会话、CSRF、配额
   ├── server/admin.mjs             管理后台接口与审计
   ├── server/byok*.mjs             服务端模型密钥托管（可选）
   ├── server/at-rest.mjs           数据静态加密（可选）
   └── server/scales*.mjs           自评问卷引擎（含历史摘要）
            │
            ▼
   DATA_DIR（会话 / 记忆 / 用户 / 附件 / 问卷历史 / 记录摘要）
```

**分层**：

- **接入层**：`server/app.mjs` 统一处理路由、鉴权中间件、安全响应头与静态文件；`public/` 是无需构建的前端。
- **业务层**：对话、会话、记忆、文档库、收藏片段、问卷模块，彼此通过函数契约组合，不依赖全局单例。
- **检索层**：`rag/` 实现零依赖检索；`server/rag.mjs` 通过 `createRetriever()` 契约接入，可整体替换。
- **存储层**：`DATA_DIR` 下的文件存储；可选 at-rest 加密与信封加密；无需数据库。
- **内容层**：不写代码即可替换的 Markdown / JSON / CSS 内容，见下。
- **运维层**：`scripts/` 下的备份、恢复、恢复演练、密钥轮换、图标生成等脚本。

内容层（不改代码即可替换）：

```text
prompts/   提示词包（system / style / safety / citation 等 Markdown，固定顺序拼接）
corpus/    文档库内容与元数据（JSON 文档；可选 _manifest/_taxonomy/_themes 元数据）
public/    前端外壳：页面、CSS 变量、图标、manifest、条款/隐私占位页
```

目录结构：

```text
bin/         启动入口（bin/serve.mjs）
server/      HTTP 服务与业务模块（路由/会话/记忆/文档库/收藏片段/鉴权/加密/问卷引擎）
rag/         零依赖检索实现（分词/扩展/相关性/重排）
public/      静态前端（原生 JS，无构建步骤）
prompts/     提示词包（示例，可整体替换）
corpus/      文档库内容与元数据（示例，可整体替换）
scripts/     运维脚本（备份/恢复/恢复演练/密钥轮换/测试分片/图标生成）
tests/       后端与检索测试（注入式夹具）
docs/        扩展说明与文档许可
examples/    领域接入示例（旅行问答 / 厨房助手）
```

## HTTP API 速查

| 方法 | 路径 | 用途 | 备注 |
|---|---|---|---|
| GET / HEAD / DELETE | `/api/health` | 服务状态、版本、语料统计、存储与能力开关 | 公开 |
| POST | `/api/chat` | 流式对话（SSE） | 请求为 JSON，响应 `text/event-stream` |
| GET | `/api/session/:id` | 读取会话消息 | 会话 id 由前端生成 |
| GET / POST / PATCH / DELETE | `/api/conversations`、`/api/conversations/:id` | 会话列表、新建、改名、删除 | 持久化到 `DATA_DIR` |
| GET / POST / PATCH / DELETE | `/api/memories`、`/api/memories/:id` | 长期记忆的读取、新增、编辑、删除 | `MEMORY=1` 时生效 |
| GET | `/api/library` | 文档库分类与目录元数据 | 内容来自 `corpus/` |
| GET | `/api/docs/:docId` | 文档原文与段落锚点 | 引用回链使用 |
| GET / POST / DELETE | `/api/marks`、`/api/marks/:id` | 收藏片段（文档级收藏 / 段落级摘录） | 按用户隔离 |
| GET | `/api/attachments/:id` | 附件二进制（图片等） | 内容寻址，按哈希去重 |
| GET / POST / DELETE | `/api/scales`、`/api/scales/score`、`/api/scales/history` | 自评问卷列表、计分、历史摘要 | 内置 1 份演示问卷 |
| POST | `/api/feedback` | 用户反馈 | 可选关联会话 |
| `AUTH=on` 时 | `/api/auth/*`、`/api/me/*`、`/api/admin/*` | 注册登录、账号数据、用户自带密钥、管理后台 | 无凭据返回 401/403 |

约定：JSON 请求/响应；错误统一返回 `{error:{code,message}}`；状态接口与静态资源之外，未启用
（如 `AUTH=off`）的端点不会挂载。完整字段与行为以源码为准，扩展与替换见
[`docs/EXTENDING.md`](docs/EXTENDING.md)。

## 六个扩展点

框架把「通用能力」与「内容/领域」分离；六个扩展点的完整契约与示例在
[`docs/EXTENDING.md`](docs/EXTENDING.md)。

1. **提示词包**：替换 `prompts/` 下的 Markdown；启动时按固定顺序拼接，缺失文件有内置最小占位或跳过。
2. **语料与检索适配器**：往 `corpus/` 放 JSON 文档即可接入知识库；也可实现自定义检索适配器
   （保持 `createRetriever({ docsDir, docs }) → { retrieve(), stats(), buildSearchIndex() }` 契约）。
3. **工具与路由注册**：新增 `server/` 模块，在 `server/app.mjs` 的路由分派中挂载端点，复用鉴权/CSRF/JSON 约定。
4. **问卷模块**：内置 1 份演示自评问卷；私有问卷 JSON 放在数据目录的 `scales-private/`
   子目录，启动注册，计分与历史摘要接口复用。
5. **主题与配置**：前端 CSS 变量（配色/圆角/字号）、`manifest.webmanifest`、条款/隐私占位页、
   环境变量均可替换。
6. **部署**：单进程 Node 服务 + 反向代理；`DATA_DIR` 是数据边界，备份/迁移/加密轮换都以它为中心。

最小的内容层改动示例（替换提示词 + 增加一篇语料，重启生效）：

```bash
# 1) 备份并替换提示词包
mkdir -p prompts/backup && cp prompts/*.md prompts/backup/
cp my-prompts/*.md prompts/

# 2) 放入一篇自有版权语料（JSON 结构见 corpus/README.md）
cp my-corpus/faq-01.json corpus/
```

`corpus/*.json` 的最小结构：

```json
{
  "id": "faq-01",
  "title": "产品常见问题",
  "author": "示例作者",
  "year": 2026,
  "sourceUrl": "https://example.com/faq",
  "license": "CC-BY-4.0",
  "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
  "lang": "zh",
  "tags": ["faq"],
  "sections": [
    { "anchor": "s1", "heading": "安装要求", "paragraphs": [{ "para": 1, "text": "需要 Node.js 22 或更高版本。" }] }
  ]
}
```

## 五分钟接入新领域（examples/domain-demo）

[`examples/domain-demo`](examples/domain-demo/) 用「旅行问答 + 厨房助手」演示**不写核心代码**接入一个全新领域：

```bash
cd examples/domain-demo
cp prompts/*.md ../../prompts/          # 覆盖提示词包
cp corpus/*.json ../../corpus/         # 放入示例语料
cp config.example.env ../../.env       # 最小配置
cd ../..
CHAT_MOCK=1 node bin/serve.mjs         # 先无 key 体验链路；有 key 时用 npm start
```

打开 http://127.0.0.1:8787 试试「周末去杭州两天怎么安排步行路线？」「冰箱里有番茄和鸡蛋能做点什么？」。
换成你自己的领域：改 `prompts/system.md` 的身份与边界，按同一 JSON 结构准备自有版权语料，
重启即可；需要换配色或标题时改 `public/css/style.css` 变量与 `public/manifest.webmanifest`。

## 部署与运维

- **反向代理**：Nginx/Caddy 终结 TLS 并转发到本进程；`HOST=127.0.0.1` 时只监听本机。
  SSE 需要关闭代理缓冲：

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8787;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_buffering off;        # SSE 必须
      proxy_read_timeout 3600s;
  }
  ```

- **systemd（可选）**：

  ```ini
  [Service]
  WorkingDirectory=/opt/chat-terminal-framework
  EnvironmentFile=/opt/chat-terminal-framework/.env
  ExecStart=/usr/bin/node bin/serve.mjs
  User=chat
  Restart=on-failure
  ```

- **备份与恢复**（数据都在 `DATA_DIR`，建议每日备份并定期演练）：

  ```bash
  node scripts/backup-data.mjs --data-dir ./data --out ./backups --keep 7
  node scripts/restore-data.mjs --backup ./backups/<时间戳> --data-dir ./data --force
  node scripts/drill-restore.mjs --backup-dir ./backups   # 恢复演练：沙盒中真实恢复并校验
  ```

- **加密密钥轮换**：

  ```bash
  node scripts/rotate-data-key.mjs --data-dir ./data --new-key-file ./secrets/data-new.key
  ```

  旧密钥省略时从 `DATA_ENCRYPTION_KEY` 或 `DATA_ENCRYPTION_KEY_FILE` 读取；启用信封加密时另加 `--envelope`。

- **升级流程**：备份 `DATA_DIR` → 阅读 [`CHANGELOG.md`](CHANGELOG.md) → 替换代码 → `npm test` → 重启进程。
  框架不写仓库目录，升级不丢数据；数据目录请勿跨版本混用（见 CHANGELOG 的破坏性说明）。
- **状态检查与日志**：`GET /api/health` 可用于负载均衡/监控探活；`GET /api/admin/system`（`AUTH=on`）返回运行时长、
  磁盘/内存、备份与生效配置摘要。日志输出到 stdout/stderr，交给进程管理器收集。

## 测试与 CI

```bash
npm test              # 后端 + 检索测试；注入式夹具，不联网、不需要 API key
npm run test:backend  # 仅后端
npm run test:rag      # 仅检索
```

- 发布时测试基线：55 个测试文件、668 项测试全部通过（0 失败、0 跳过）。
- CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在 Node.js 22 与 24 上运行 `npm test`。
- 测试不使用跳过标记；新增行为请附带测试。新增测试文件放在 `tests/backend/`（或 `tests/rag/`），
  用 Node 内置 `node:test` + `node:assert` 编写，无需安装依赖。
- 说明：UI 端到端测试套件不在本仓库内（见 CHANGELOG 的 Known limitations），前端改动请手工验证关键路径。

## 安全与隐私

- **模型密钥只在服务端**：来自 `.env` 或（`AUTH=on` 时）用户自带密钥的加密存储；不会写入仓库、日志或前端。
- **静态加密**：设置 `DATA_ENCRYPTION_KEY` 后，`DATA_DIR` 内数据以 AES-256-GCM 加密落盘；支持信封加密与
  `scripts/rotate-data-key.mjs` 轮换密钥。
- **多用户隔离**：`AUTH=on` 时会话、记忆、收藏、问卷历史按用户隔离；写操作有 CSRF 防护，登录态 Cookie 可要求 HTTPS；
  默认邀请制注册，管理员可发/吊销邀请码、查看审计日志。
- **限流与配额**：每用户每分钟请求与并发上限、每日/每月 token 配额均可配置，防止单用户打满上游额度。
- **外部调用防护**：上游模型地址白名单、私有网段与回环地址拦截（服务端自带 SSRF 防护），附件有类型/大小上限。
- **无遥测**：不包含分析、埋点或回传机制；所有状态留在这台机器上。
- **数据可携带/可删除**：`AUTH=on` 时提供账号数据导出与 `DELETE /api/me` 注销删除接口。
- **漏洞报告**：请按 [`SECURITY.md`](SECURITY.md) 私密报告，不要开公开 issue。

## 不包含什么

- 默认不包含特定领域的专用提示词、语料、技能与内容包；领域内容通过扩展点由部署方提供。
- 随包仅含自撰 CC0 示例提示词与 3 篇通用演示文档；模板卡/分类元数据与记录示例需自备，可整体替换或删除。
- 不含第三方受版权语料、真实用户数据与生产部署信息。
- 不做模型训练、不代理多租户 SaaS 计费、不内置具体业务产品。
- 不提供容器镜像、npm 包或一键托管服务：本项目以源码分发，自行部署。

## FAQ

**需要 GPU 或数据库吗？**
不需要。它是普通 CPU 上的 Node 服务，数据用文件存储；模型推理在上游服务完成。

**能接哪些模型？**
默认接 Anthropic Messages 协议兼容服务（默认 DeepSeek 该端点，填 `DEEPSEEK_BASE_URL` 与 `MODEL` 即可）；
`AUTH=on` 时用户也可通过自带密钥（BYOK）接入 OpenAI 兼容或 Anthropic 兼容服务。

**如何换知识库？**
把自有版权 JSON 文档放进 `corpus/`（结构见 `corpus/README.md`），重启后自动建索引；也可以按
`createRetriever()` 契约实现自己的检索层。

**如何关闭长期记忆？**
设置 `MEMORY=0`；已有记忆可在界面的「记忆」面板查看与删除（`AUTH=on` 时按用户隔离）。

**多用户怎么开？**
设置 `AUTH=on`、`ADMIN_INITIAL_PASSWORD_FILE`（需要静态加密时再设 `DATA_ENCRYPTION_KEY`）并重启；
首次启动创建管理员，之后用邀请码接入其他用户（`INVITE_ONLY=on`）。

**升级会丢数据吗？**
数据都在 `DATA_DIR`，升级前先备份并阅读 `CHANGELOG.md`。0.x 阶段接口与数据格式可能变化，破坏性变更会写在 CHANGELOG 中。

**前端能改吗？**
可以。`public/` 是纯静态页面，无构建步骤；改 CSS 变量、文案或 `manifest.webmanifest` 后刷新即可。

## Roadmap

- **0.2.x**：补全部署模板与示例、完善扩展点文档、收敛兼容性细节（不承诺具体日期）。
- **0.3**：引入领域包示例与扩展点契约的稳定化（提示词包 / 语料适配器 / 问卷模块）。
- 更长期：更多检索与主题适配器、运维脚本增强；以 issue 讨论为准，不承诺时间表。

## 参与贡献

- 开发环境、代码风格、提交与评审流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
- 本项目使用 DCO（`git commit -s`），不要求签署 CLA。
- 安全漏洞请按 [`SECURITY.md`](SECURITY.md) 私密报告；行为准则见 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
- 版本变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 许可

- 代码：Apache License 2.0，见 [`LICENSE`](LICENSE)。
- 文档与 README：CC BY 4.0，见 [`docs/LICENSE-DOCS.md`](docs/LICENSE-DOCS.md)。
- 第三方组件、字体（SIL OFL 1.1）与示例内容归属：见 [`NOTICE`](NOTICE) 与 [`THIRD_PARTY.md`](THIRD_PARTY.md)。

> 本项目为独立开源项目，名称与徽标不属于代码许可授权范围；与任何商标持有人无隶属或背书关系。
