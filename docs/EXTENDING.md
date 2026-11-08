# Extending Chat Terminal Framework

框架的核心原则：**通用能力在内核，内容与领域在外壳。** 升级内核时，内容层可以独立维护；
接入一个新领域或新产品时，通常不需要改 `server/`、`bin/`、`rag/` 的代码。

本文覆盖六个扩展点（extension points）：

1. 提示词包（`prompts/`）
2. 语料与检索适配器（`corpus/`、`rag/`）
3. 工具与路由注册（`server/`）
4. 问卷模块（`server/` 问卷引擎 + 私有问卷包）
5. 主题与配置（`public/`、环境变量）
6. 部署（单进程 + 反向代理 + `DATA_DIR`）

另见 [examples/domain-demo/](../examples/domain-demo/)：一个把「旅行问答 + 厨房助手」接入进来的
完整最小示例（自撰 CC0 内容）。

---

## 1. 提示词包（`prompts/`）

启动时 `server/prompts.mjs` 按**固定顺序**读取 `prompts/` 下的 Markdown 并拼接：

| 顺序 | 文件 | 必需 | 作用 |
|---|---|---|---|
| 1 | `system.md` | 是 | 身份、能力边界、回答方式（必须静态，不含时间/用户数据） |
| 2 | `style-csb.md` | 是 | 表达风格（文件名沿用历史命名，内容可任意替换） |
| 3 | `safety.md` | 是 | 安全边界，优先级最高 |
| 4 | `citation-rules.md` | 是 | 引用规则，与检索注入格式配套 |

独立加载的两个文件（不参与主对话拼接）：

| 文件 | 作用 |
|---|---|
| `memory-extract.md` | 后台长期记忆抽取指令；缺失用内置最小占位 |
| `websearch-rules.md` | 联网搜索的整理规则；缺失用内置占位 |

行为约定：

- 必需文件缺失时使用内置最小占位并打印 warn，服务仍可启动（便于先跑起来再补内容）。
- 分隔符固定 `\n\n---\n\n`，逐文件 trim 后拼接；替换文件后**重启进程**生效。
- `system.md` 保持静态有利于上游 prompt cache；不要把动态变量拼进去。

**替换方式**：整体替换目录内容即可。

```bash
# 用一个内容包里的提示词替换默认示例
cp -r examples/domain-demo/prompts/. prompts/
node bin/serve.mjs
```

**程序化指定目录**（适合多实例/多租户各带一套内容）：

```js
import { createServer } from './server/app.mjs';

const server = await createServer({
  promptsDir: '/srv/content/prompts',   // 默认 <repo>/prompts
  docsDir: '/srv/content/corpus',       // 默认 <repo>/corpus
  dataDir: '/srv/data',
});
server.listen(8787, '127.0.0.1');
```

---

## 2. 语料与检索适配器（`corpus/`、`rag/`）

### 2.1 语料包格式

把知识库文档写成 JSON 放进 `corpus/`（文件名以 `_` 开头的元数据文件除外）。启动时加载并在内存中
构建检索索引，无需预生成索引文件；坏文件只 warn，不影响启动。

```json
{
  "id": "travel-notes-01",
  "title": "示例：城市两日徒步路线",
  "author": "Chat Terminal Framework contributors",
  "year": 2026,
  "sourceUrl": "https://example.com/travel-notes-01",
  "license": "CC0-1.0",
  "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
  "lang": "zh",
  "tags": ["示例", "旅行"],
  "sections": [
    {
      "anchor": "day-1",
      "heading": "第一天：老城到河岸",
      "paragraphs": [
        { "para": 1, "text": "上午从老城广场出发……" },
        { "para": 2, "text": "下午沿河岸步行……" }
      ]
    }
  ]
}
```

字段说明：

- 必需：`id`（全局唯一）、`title`、`sections[]`（至少一节，每节有 `anchor`/`heading`/`paragraphs`）。
- 建议：`license`/`licenseUrl`/`sourceUrl`/`author`/`year`/`tags`；引用展示与合规审计依赖这些字段。
- 可选元数据文件：`_manifest.json`（文档清单）、`_taxonomy.json`（两级分类）、`_themes.json`（主题分组）。
  缺失或格式不符时回退为默认分组，不会 500。格式见 `server/library.mjs` 头部注释。

**替换方式**：增删 `corpus/*.json` 后重启；`docsDir` 可指向仓库外目录。

### 2.2 自定义检索适配器

检索层通过一个稳定契约接入。默认实现在 `rag/index.mjs`，由 `server/rag.mjs` 的
`loadRetriever()` 动态加载：

```js
// createRetriever({ docsDir, docs, ... }) → 必须有 retrieve() 与 stats()
export async function createRetriever({ docs = [] } = {}) {
  return {
    buildSearchIndex() {},                       // 可选：启动时建索引
    retrieve(query, { limit = 5 } = {}) {        // 必需：返回证据块数组
      return [];
    },
    stats() {                                    // 必需：健康检查/调试用
      return { docs: docs.length, indexed: 0 };
    },
  };
}
```

证据块的推荐形状（与引用渲染配套）：

```js
{
  docId: 'travel-notes-01',
  title: '示例：城市两日徒步路线',
  anchor: 'day-1',
  heading: '第一天：老城到河岸',
  text: '命中的段落或摘要',
  score: 0.82,
}
```

**接入方式**：实现同名模块替换 `rag/index.mjs`；或在程序化启动时注入自定义实例：

```js
import { createServer } from './server/app.mjs';
import { createRetriever } from './my-retriever.mjs';

const server = await createServer({
  retriever: await createRetriever({ docsDir: './corpus' }),
});
```

替换后请确认 `/api/health` 正常、对话能返回带引用的回答；`tests/` 里用注入式夹具，
不依赖具体检索实现。

---

## 3. 工具与路由注册（`server/`）

框架没有魔法插件加载器：新增工具 = **新增一个模块 + 在路由分派挂载端点 + 补契约与测试**。
这样保持零依赖、可审计、升级冲突最小。

步骤：

1. 新建 `server/hello.mjs`：

```js
// 返回 JSON 的最小工具端点；错误统一用 sendApiError，响应统一用 sendJson。
export async function handleHello(req, res, ctx) {
  return { ok: true, user: ctx.userId ?? null };
}
```

2. 在 `server/app.mjs` 的 `handleRequest()` 里把端点接进 `if (segments[0] === 'api')` 分支：

```js
if (resource === 'hello' && req.method === 'GET') {
  const payload = await handleHello(req, res, requestCtx);
  sendJson(res, 200, payload);
  return;
}
```

3. 若端点需要登录，放在既有鉴权中间件之后（默认所有 `/api/*` 都会先过 origin / content-type /
   auth / CSRF 检查）；若需公开，把路径加入 `server/auth.mjs` 的 `isPublicApi()` 白名单并说明理由。
4. 补测试（注入 `fetchImpl`/`callModel`，不发真实网络请求）与 `docs/` 中的 HTTP 契约说明。

路由注册不需要外部注册表；保持每个工具一个模块、显式接入、显式测试。

---

## 4. 问卷模块（questionnaire）

框架内置一个**自撰的演示自评问卷**（6 题，用于演示「列表 → 单表 → 计分 → 历史摘要」链路），
以及一套私有问卷包的注册机制。它适合作为「自评工具」类扩展的样板，不包含任何第三方题目。

公开接口（英文路径，v0.2 起保持稳定）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/scales` | 问卷列表（分类 + 公开字段） |
| `GET` | `/api/scales/:id` | 单份问卷（题目、选项、档位、来源） |
| `POST` | `/api/scales/score` | 计分 `{ scaleId, answers: { "1": 0 } }`，返回分数/档位/提示 |
| `GET` | `/api/scales/history` | 结果摘要历史（可按 `scaleId`、`limit` 过滤） |
| `DELETE` | `/api/scales/history/:id` | 删除一条摘要 |
| `DELETE` | `/api/scales/history` | 清空摘要历史 |

私有问卷包：把 JSON 放在 `<DATA_DIR>/private-scales/*.json`，启动时加载并注册；坏文件只记日志跳过。
定义通过 `buildScaleDefinition()` 的 v1 schema 校验：

```json
{
  "id": "focus-demo",
  "categoryId": "focus",
  "kind": "band",
  "name": "示例：专注自评",
  "shortName": "专注",
  "timeframe": "最近一周",
  "purpose": "演示问卷引擎接入，非专业评估工具",
  "options": [
    { "value": 0, "label": "从不" },
    { "value": 1, "label": "偶尔" },
    { "value": 2, "label": "经常" }
  ],
  "itemsText": ["我能按计划开始手头的事", "被打断后我能很快回到任务"],
  "reverseItems": [],
  "bands": [
    { "key": "low", "label": "低", "min": 0, "max": 2, "note": "示例说明" },
    { "key": "high", "label": "高", "min": 3, "max": 4, "note": "示例说明" }
  ],
  "source": {
    "name": "自撰示例",
    "url": "https://example.com/focus-demo",
    "license": "CC0-1.0",
    "citation": "Chat Terminal Framework contributors, 2026"
  }
}
```

要点：

- 只保存**结果摘要**（分数/档位/时间），不保存原始答案与题面到历史文件；摘要可删除、可关闭。
- `kind: "factor"` 用 `factors[]`（覆盖全部题目）替代 `bands[]`；需要常模/换算等高级形态时，
  在问卷引擎模块内扩展，并同步契约文档与测试。
- 问卷题目/选项文本属于**内容层**：请确保你有权发布这些文本；私有问卷放在 `DATA_DIR` 下，
  不进仓库（`.gitignore` 已覆盖）。
- 切换到自己的问卷体系时，替换内置演示问卷与私有包即可，HTTP 接口与计分链路复用。

---

## 5. 主题与配置（`public/`、环境变量）

### 5.1 前端主题

前端是原生 JS/CSS，无构建步骤。主题集中在 `public/css/style.css` 顶部的 CSS 变量：

```css
:root {
  --bg: #F4E9D4;          /* 页面背景 */
  --surface: #FBF4E6;     /* 卡片/输入区背景 */
  --border: rgba(15,65,66,0.22);
  --text-primary: #0F4142;
  --text-secondary: #3E5B5B;
  --user-bubble-bg: #0F4142;
  --user-text: #F4E9D4;
  --danger: #A83318;
  --link: #A83318;
  --focus-ring: #F04722;
}
```

改这些变量即可换配色；圆角/字号/间距变量同为 CSS 自定义属性，可按需覆盖。
`public/manifest.webmanifest` 改名称、短名、主题色与图标；`public/icons/` 放图标；
条款/隐私占位页（`public/terms.html`、`public/privacy.html`）替换为部署方文本。

### 5.2 配置

- 环境变量：见 `.env.example`（`.env` 已 gitignore，绝不提交）。
- 启动时读取；改动后重启生效。生产环境建议显式设置 `PORT`/`HOST`/`MODEL`/`DATA_DIR`/
  `DATA_ENCRYPTION_KEY`/`AUTH`/`ADMIN_SESSION_SECRET`。
- 不要在仓库里放环境相关值；用部署平台的 secret 管理或受保护的文件注入。

---

## 6. 部署

最小形态：一个 Node 进程 + 一个反向代理 + 一个数据目录。

```bash
# 生产（Node >= 22；以非 root 用户运行）
cp .env.example .env      # 填 DEEPSEEK_API_KEY / DATA_DIR / DATA_ENCRYPTION_KEY / AUTH 等
npm test                  # 部署前跑一次
node bin/serve.mjs        # 默认 :8787；建议 HOST=127.0.0.1 只监听本机
```

- **反向代理**：Nginx/Caddy 终结 TLS 并转发到 8787；SSE 需要关闭响应缓冲（Nginx
  `proxy_buffering off;`）并放大 `proxy_read_timeout`。
- **数据边界**：`DATA_DIR` 是会话/记忆/用户/附件/问卷历史的唯一根目录；备份/恢复/迁移只针对它。
  - 备份：`node scripts/backup-data.mjs`；恢复：`node scripts/restore-data.mjs`；
    演练：`node scripts/drill-restore.mjs`。
- **加密**：设置 `DATA_ENCRYPTION_KEY`（base64 32B，`openssl rand -base64 32`）开启 at-rest 加密；
  已有明文数据会在启动时自动迁移（迁移前备份）。轮换用 `node scripts/rotate-data-key.mjs`。
- **多用户**：`AUTH=on` 并设置强随机 `ADMIN_SESSION_SECRET`；按需设置注册/配额/速率限制。
- **命令与端口**：`PORT`/`HOST` 由环境变量控制；`CHAT_MOCK=1` 用于无模型密钥的测试与演示。
- **升级**：备份 `DATA_DIR` → 替换代码 → `npm test` → 重启；框架不写仓库目录，升级不丢数据。
- **健康检查**：`GET /api/health`（公开）；前端可用同一地址做存活探测。

---

## 7. 领域包打包建议

把内容组织成独立目录，不要改核心代码：

```text
content-pack/
  prompts/            # 四件套必需的提示词 + 可选 memory-extract/websearch-rules
  corpus/             # 语料 JSON（带 license/sourceUrl）
  theme/              # 可选：CSS 变量覆盖、manifest、条款/隐私文本
  README.md           # 内容来源、许可、安装方式
  LICENSE             # 你对自己内容的授权
```

安装 = 复制到部署目录对应位置（或用 `promptsDir`/`docsDir` 指向它们），重启服务；
升级框架时保持内容包不变。请确保：

- 所有语料/文本可公开发布，并保留来源与许可字段；
- 不放任何第三方受版权内容、真实个人数据或内部部署信息；
- 内容包版本与框架版本在 README 中注明兼容范围。

---

## 8. 兼容性与版本

- 0.x 阶段：HTTP API 与扩展点契约（extension API）在次版本之间可能有破坏性调整；升级前读 `CHANGELOG.md`。
- 稳定的扩展面：`prompts/` 文件名与顺序、`corpus/` 文档 schema、`createRetriever()` 契约、
  问卷模块的 HTTP 路径与私有包 schema。
- 内部实现（`server/` 模块划分、函数签名）不承诺跨版本稳定；请通过上述扩展面接入。
