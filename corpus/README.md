# corpus/ — 本地知识库语料（示例）

本目录是框架的**示例语料**：3 篇自撰的框架使用手册章节（CC0-1.0），用于演示
「本地知识库 → 检索 → 带引用回答」的完整链路。替换本目录内容即可换成你自己的领域知识库。

## 文件格式

每个 `.json` 文件是一篇文档，启动时由 `server/corpus.mjs` 一次性加载（文件名以 `_` 开头的
文件为元数据，不参与检索）：

```json
{
  "id": "demo-handbook-01",
  "title": "文档标题",
  "author": "作者/机构",
  "year": 2026,
  "sourceUrl": "https://example.com/source",
  "license": "CC0-1.0",
  "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
  "lang": "zh",
  "tags": ["tag1", "tag2"],
  "sections": [
    {
      "anchor": "s1",
      "heading": "小节标题",
      "paragraphs": [
        { "para": 1, "text": "段落正文……" }
      ]
    }
  ]
}
```

## 约定

- `id` 全局唯一，用于 `GET /api/docs/:docId` 与引用锚点；
- `sections[].anchor` 文档内唯一，用于引用定位（`#/doc/<id>/<anchor>`）；
- 只放你有权使用的语料正文；本示例内容为自撰，以 CC0-1.0 贡献；
- 启动时在内存中建索引，不需要预生成索引文件；
- 可选：`_manifest.json` / `_taxonomy.json` / `_themes.json` 用于书架与分类展示，
  格式见 `server/library.mjs` 头部注释。

本框架**不包含**原私有项目的领域语料；请自行提供合规语料。
