# Third-Party Notices and Attributions

This document lists the third-party components, dependencies, and design
references relevant to Chat Terminal Framework, and states the licensing
status of self-authored demo content. It is a provenance record, not legal
advice.

## 1. Runtime dependencies

| Component | Version | License | Use | Link |
|---|---|---|---|---|
| Node.js runtime | 22 or newer, host-provided and not bundled | MIT | JavaScript runtime | https://nodejs.org/ |
| npm runtime packages | none | — | the runtime has zero third-party package dependencies | — |
| npm development packages | none | — | the repository declares no development dependencies | — |

The project declares empty `dependencies` and `devDependencies` maps in
`package.json`. No third-party package code is bundled or redistributed by
this project.

## 2. Bundled third-party assets

### 2.1 Ma Shan Zheng font subset

| Field | Value |
|---|---|
| Asset | Ma Shan Zheng font subset, 3 glyphs |
| Upstream | https://github.com/google/fonts/tree/main/ofl/mashanzheng |
| Copyright | Copyright 2018 The Ma Shan Zheng Project Authors (https://github.com/googlefonts/mashanzheng) |
| License | SIL Open Font License, Version 1.1; full text retained at `public/fonts/OFL-MaShanZheng.txt` |
| Use | rendering a three-glyph greeting sample in the demo interface |
| Obligations | retain the copyright notice and the OFL text when redistributing the font subset; do not sell the font on its own |

### 2.2 User-interface color tokens

| Field | Value |
|---|---|
| Assets | color values associated with the Tokyo Night, Nord, Catppuccin, Everforest, Gruvbox, Solarized, Rosé Pine, and GitHub Primer palettes |
| Use | user-selectable color themes in the demo interface |
| License status | the repository uses individual hexadecimal color values; color values as such are not copyrightable subject matter. No theme files, stylesheets, or code were copied. Palette project names and logos remain the trademarks of their owners. |
| Links | https://www.nordtheme.com/ ; https://catppuccin.com/ ; https://ethanschoonover.com/solarized/ ; https://github.com/rose-pine/rose-pine-theme ; https://github.com/enkia/tokyo-night-vscode-theme |

## 3. Design references (ideas only; no code copied)

The following projects were consulted for design and engineering ideas only.
No source code, prompt text, user-interface assets, or other copyrightable
material was copied; all implementations are original.

| Project | License | Concepts referenced | Link |
|---|---|---|---|
| letta-ai/letta | Apache-2.0 | memory chunking, asynchronous consolidation | https://github.com/letta-ai/letta |
| getzep/zep | Apache-2.0 | memory contradiction handling | https://github.com/getzep/zep |
| ChatGPTNextWeb/NextChat | MIT | mobile session-list interaction | https://github.com/ChatGPTNextWeb/NextChat |
| open-webui/open-webui | BSD-3-Clause with brand terms | session storage structure | https://github.com/open-webui/open-webui |
| lucaong/minisearch | MIT | field-weighted search | https://github.com/lucaong/minisearch |
| oramasearch/orama | Apache-2.0 | hybrid ranking | https://github.com/oramasearch/orama |
| blader/humanizer | MIT | style-feature checklist (rules rewritten from scratch) | https://github.com/blader/humanizer |
| langgptai/LangGPT | Apache-2.0 | prompt section structure | https://github.com/langgptai/LangGPT |
| anthropics/claude-cookbooks | MIT | prompt organization | https://github.com/anthropics/claude-cookbooks |
| gkurt/tegaki | MIT | handwriting reveal animation | https://github.com/gkurt/tegaki |
| Jkalio52/khoshnus | MIT | handwriting reveal animation | https://github.com/Jkalio52/khoshnus |

Because no third-party code or text is copied, no redistribution obligations
from these projects apply to this distribution. The attribution is provided
for transparency and good practice.

## 4. Self-authored demo content

Demo content shipped under `corpus/`, `prompts/`, and `examples/` is authored
for this distribution and dedicated to the public domain under CC0 1.0
Universal (https://creativecommons.org/publicdomain/zero/1.0/). It contains no
third-party text. Attribution is not required, but is appreciated:
"Demo content from Chat Terminal Framework contributors (CC0 1.0)".

## 5. Self-generated assets

- Application icons are generated at build time by a project script from
  inline SVG definitions; no third-party icon font, icon library, or icon set
  is bundled or required.
- The demo interface uses only the bundled font subset described in Section
  2.1 and system font fallbacks.

## 6. Content not distributed with this repository

- third-party content packs and their source materials;
- third-party text collections and prompt packs;
- production deployment files, host details, and internal review records.

These are not part of this distribution and are not covered by this
repository's licenses. Users must obtain their own permissions for such
content.

## 7. License obligations summary

| License | Obligations for this distribution |
|---|---|
| Apache-2.0 (project code) | retain `LICENSE` and `NOTICE`; state significant changes; patent grant included; no trademark license |
| SIL OFL 1.1 (font subset) | retain copyright notice and license text; the font may be bundled but not sold on its own |
| CC BY 4.0 (documentation) | attribution required when reusing documentation prose |
| CC0 1.0 (demo content) | no conditions; public-domain dedication |
| Third-party project licenses | no third-party code is copied, so no redistribution obligations arise; links are listed for provenance |

## 8. Provenance notes

All entries above were compiled from the project's own dependency manifest,
asset inventory, and design history. External links point to upstream project
homes and were valid at the time of writing. No third-party text, code, or
assets are reproduced in this document.


*This document is not legal advice.*
