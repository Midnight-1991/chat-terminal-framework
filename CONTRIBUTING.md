# Contributing

感谢参与 Chat Terminal Framework。本文说明开发环境、代码规范、提交与评审流程。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 开发环境

- Node.js >= 22（CI 覆盖 22 与 24）。
- 无需安装任何 npm 依赖：项目**零运行时依赖**，前端无构建步骤。
- 本地运行：

```bash
cp .env.example .env        # 可选；mock 模式不需要模型 key
npm test                    # 后端 + 检索测试，不联网、不需要 key
CHAT_MOCK=1 node bin/serve.mjs   # 打开 http://127.0.0.1:8787 手工体验
```

## 红线（以下内容不接受）

1. **不引入第三方受版权内容**：语料、题目、文案、图片、数据表都必须是自撰、公有领域或
   许可兼容且已在 `THIRD_PARTY.md` 登记；禁止提交来源不明的内容。
2. **不引入领域专有内容**：本框架只提供通用能力。具体业务/领域的人设、知识库、问卷题面、
   界面文案请通过扩展点（`prompts/`、`corpus/`、主题层）以「内容包」形式提供，不进入核心代码。
3. **不提交真实个人数据与生产标识**：测试夹具必须使用合成数据；禁止生产 IP/域名/路径、
   内部项目编号、真实用户数据、密钥或任何凭据。
4. **不引入运行时依赖**：新增运行时 npm 依赖需要先在设计讨论（issue）中说明理由并获维护者同意；
   优先使用 Node 内置能力（`node:crypto`、`node:fs`、`node:http` 等）。

## 提交与 DCO

本项目使用 **Developer Certificate of Origin (DCO) 1.1**，不要求签署 CLA。
每次提交请带签名：

```bash
git commit -s -m "fix: 说明变更"
```

签名行格式（`-s` 自动生成）：

```text
Signed-off-by: Your Name <you@example.com>
```

签名表示你确认有权按项目许可提交该贡献，完整文本见
<https://developercertificate.org/>。未签名的提交需要 rebase 补签。

## 分支与 PR

1. Fork 并从 `main` 开分支：`feat/…`、`fix/…`、`docs/…`。
2. 一次 PR 只做一件事；附带测试与文档更新。
3. 用户可见的变更请更新 `CHANGELOG.md`（写在 `Unreleased` 区）。
4. 提交 PR 前在本地跑通：

```bash
npm test
git log --oneline -1        # 确认已签名
```

PR 模板检查项：测试通过、无密钥/个人数据、无第三方内容、无新增运行时依赖、文档已更新。

## 代码风格

- 原生 ESM（`import`/`export`），不使用 TypeScript 转译或打包器。
- 2 空格缩进、单引号、尾逗号、行宽约 110；文件名小写连字符或现有风格。
- 注释只写「为什么」与边界条件，不复述代码；不写内部项目编号或里程碑叙事。
- HTTP 层保持现有约定：JSON 请求体、统一错误响应、安全响应头、AUTH/CSRF 中间件顺序。

## 测试

- `npm test` 跑后端与检索测试（注入式夹具，不联网、不需要 API key）。
- 新功能必须带测试；修 bug 先补回归测试再修；测试名描述行为，不写内部编号。
- 不要用跳过/删除测试来让 CI 变绿；确实无法自动化时在 PR 里说明并请维护者裁决。

## 评审与响应

- 维护者会尽快回复 PR/issue；本项目为单维护者项目，响应窗口见 README/SECURITY。
- 评审关注：正确性、测试、向后兼容、安全边界（密钥/鉴权/注入）、是否越界引入领域内容。
- 合并方式：squash merge，保留 DCO 签名行。

## 安全

发现安全漏洞请勿提交公开 issue，按 [SECURITY.md](SECURITY.md) 私密报告。
