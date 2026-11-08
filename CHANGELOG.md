# Changelog

本项目的所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-11-09

### Changed

- README 新增「同类项目与定位」章节：与邻近开源项目（Open WebUI、LobeHub（原 Lobe Chat）、NextChat、AnythingLLM、LibreChat、Dify、RAGFlow、FastGPT、Khoj、MaxKB）按形态 / 技术栈、许可与适用场景做对比，说明本项目的定位与取舍。
- README 状态行与 `/api/health` 示例中的版本号更新为 0.2.1。

### Notes

- 仅文档与版本号变更，无代码或 API 变更；发布树内 `npm test` 668 项测试通过，发布树与归档按 0.2.1 重建。

## [0.2.0] - 2026-11-08

首个公开版本。由一套私有 AI 对话终端项目的通用能力子集剥离而来，作为独立、可自托管的框架发布。

### Added

- 框架发布仓库：独立 README、CHANGELOG、CONTRIBUTING、SECURITY、CODE_OF_CONDUCT 与 CI。
- 四个内容扩展点：提示词包（`prompts/`）、语料包（`corpus/`）、问卷模块（内置 1 份演示自评问卷 +
  私有问卷 JSON 注册）、主题与文案外壳（CSS 变量 + manifest + 条款占位页）。
- 通用检索适配器契约：`createRetriever({ docsDir, docs }) → { retrieve(), stats(), buildSearchIndex() }`，
  可替换检索实现而不改业务代码。
- 领域接入示例 `examples/domain-demo/`：旅行问答与厨房助手两套自撰 CC0 提示词/语料与接入说明。
- 发布配套：CI workflow（Node.js 22 / 24 matrix 跑 `npm test`）、issue 模板、
  扩展点文档 `docs/EXTENDING.md`。
- 中文文档：README 快速开始、架构图、部署要点与扩展点导读。

### Changed

- 全仓中性化：包名与展示名统一为 `chat-terminal-framework` / "Chat Terminal Framework"；
  源码、前端文案、注释与测试中的内部项目标识、迭代与检查编号（M、D、task、A 类）、
  历史契约引用已清理或改为通用表述。
- 问卷模块统一使用「自评问卷 / questionnaire」表述；内置示例问卷为自撰演示内容。
- 测试夹具中的模拟许可字段改为中性占位（`LicenseRef-Synthetic-Fixture`），并同步测试断言。

### Breaking changes（相对 0.x 早期内部构建）

- 0.2.0 视为**全新项目**：加密数据头 magic、localStorage 键前缀等内部标识符已更名。
  旧内部构建的 `DATA_DIR` 数据**不能**直接迁移到本版本，请以全新数据目录启动。
- 包名与目录名变更；请按本仓库 README 重新部署，不要混用旧配置。

### Known limitations

- UI 端到端测试套件不在本仓库内（仅后端与检索测试随包）；前端改动请手工验证关键路径。
- 部署示例为最小单进程形态，不含容器编排、集群与多实例共享存储方案。
- 项目处于 0.x，公开接口在次版本之间可能有破坏性调整，升级前请阅读本文件。
