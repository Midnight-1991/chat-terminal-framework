# 领域接入示例：旅行问答 + 厨房助手

这个目录演示**如何不写一行核心代码**，把一个新的业务领域接入 Chat Terminal Framework：

- `prompts/`：一套完整的提示词包（四件套），演示「旅行规划 + 家常厨房」双主题的助手人设。
- `corpus/`：两篇自撰的 CC0 演示语料，演示知识库文档格式与引用回链。
- `config.example.env`：最小配置示例。

内容全部为自撰演示数据（CC0-1.0），不含任何第三方版权材料、真实用户数据或生产信息。

## 5 分钟接入

```bash
# 在发布树根目录执行（假设当前目录为 examples/domain-demo）

# 1) 覆盖提示词包
cp prompts/*.md ../../prompts/

# 2) 放入语料（示例语料可删除或保留）
cp corpus/*.json ../../corpus/

# 3) 配置并启动
cp config.example.env ../../.env       # 或手动把变量加进已有的 .env
cd ../..
CHAT_MOCK=1 node bin/serve.mjs         # 无模型 key 时先体验链路
# 有 key 时直接 node bin/serve.mjs
```

打开 `http://127.0.0.1:8787`，提问例如：

- 「周末去杭州两天，怎么安排一条不太累的步行路线？」
- 「冰箱里有番茄、鸡蛋和面条，能做点什么？」

## 目录说明

| 路径 | 作用 |
|---|---|
| `prompts/system.md` | 助手身份、领域范围与回答方式 |
| `prompts/style-csb.md` | 表达风格（结构、长度、语气） |
| `prompts/safety.md` | 安全边界与不可用场景 |
| `prompts/citation-rules.md` | 引用/来源标注规则（与检索注入配套） |
| `corpus/travel-notes-01.json` | 示例语料：城市步行路线笔记 |
| `corpus/kitchen-recipes-01.json` | 示例语料：家常菜步骤笔记 |

## 自己换成别的领域

1. 改 `prompts/system.md` 的身份与范围，保持「不编造、不确定就说明」；
2. 按 `corpus/` 里的 JSON 结构准备你自有版权的语料（必须带 `license`/`sourceUrl`）；
3. 重启服务，用两个真实场景问题测试：能引用到语料、答不出时会明确说不知道；
4. 需要换配色/标题时改 `public/css/style.css` 变量与 `public/manifest.webmanifest`（见 `docs/EXTENDING.md`）。

## 许可

本目录内所有内容由 Chat Terminal Framework contributors 以 CC0-1.0 释出，可自由复制、修改、
再分发，无需署名。语料 JSON 的 `license`/`licenseUrl` 字段已按此填写。
