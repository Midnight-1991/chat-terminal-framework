# Content Licensing

Chat Terminal Framework uses different licenses for different kinds of
content. This document explains which license applies to what. It is a summary
of intent, not legal advice; the full license texts govern.

## 1. At a glance

| Content | License | Full text |
|---|---|---|
| Source code (`server/`, `rag/`, `bin/`, `public/js/`, `scripts/`, `tests/`) | Apache License 2.0 | `LICENSE` |
| Code samples embedded in documentation | Apache License 2.0 | `LICENSE` |
| Documentation prose (`docs/`, Markdown files at the repository root, in-code comments) | Creative Commons Attribution 4.0 International (CC BY 4.0) | https://creativecommons.org/licenses/by/4.0/ |
| Bundled font files (`public/fonts/`) | SIL Open Font License 1.1 | `public/fonts/OFL-MaShanZheng.txt` |
| Demo content (`corpus/`, `prompts/`, `examples/`) | CC0 1.0 Universal (public-domain dedication) | https://creativecommons.org/publicdomain/zero/1.0/ |
| Third-party components | their respective licenses | `THIRD_PARTY.md`, `NOTICE` |
| Project name, logos, and other marks | not licensed; all rights reserved | see Section 5 |
| third-party content packs and their source materials | not distributed with this project | — |

## 2. Source code — Apache License 2.0

All program source code is licensed under the Apache License, Version 2.0. This
includes the HTTP server, retrieval layer, command-line entry point, browser
scripts, build scripts, test code, and the code samples embedded in
documentation.

Key points of the Apache License, Version 2.0:

- a patent license is granted together with the copyright license;
- redistributors must retain the `LICENSE` and `NOTICE` files and state
  significant changes made to the code;
- the license does not grant permission to use the trade names, trademarks, or
  service marks of the project, except as required for reasonable and
  customary use in describing the origin of the work;
- the work is provided on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS
  OF ANY KIND.

The full, unmodified license text is in `LICENSE`.

## 3. Documentation — CC BY 4.0

Documentation prose in the `docs/` directory, the Markdown files at the
repository root, and explanatory comments are licensed under Creative Commons
Attribution 4.0 International (CC BY 4.0).

If you reuse documentation prose, attribute it in a reasonable manner, for
example:

> Source: Chat Terminal Framework contributors, licensed under CC BY 4.0
> (https://creativecommons.org/licenses/by/4.0/). Changes indicated if any.

Code blocks inside documentation are covered by the Apache License 2.0, not by
CC BY 4.0, so that readers can reuse them in software without additional
attribution complexity.

## 4. Fonts — SIL Open Font License 1.1

Font files under `public/fonts/` are distributed under the SIL Open Font
License, Version 1.1. The font copyright notice and the complete license text
are retained in `public/fonts/OFL-MaShanZheng.txt`.

The font may be bundled with, and redistributed as part of, this software. It
may not be sold on its own. Any redistribution must keep the copyright notice
and license text. The upstream project has not declared a Reserved Font Name,
so subsetting is permitted without renaming.

## 5. Trademarks and names

The Apache License, Version 2.0 (Section 6) does not grant permission to use
the trade names, trademarks, or service marks of the project. The name
"Chat Terminal Framework", any associated logos, and the names of any demo
deployments remain reserved by the project contributors.

Third-party product names, logos, and trademarks referenced in the
documentation belong to their respective owners. References are descriptive
only and do not imply affiliation or endorsement.

## 6. Content not distributed

The following content is not part of this distribution and is not covered by
the licenses above:

- third-party content packs and their source materials;
- third-party text collections and prompt packs;
- production deployment configurations, host information, and internal review
  records.

Anyone reusing this framework for their own domain must obtain the necessary
rights for the content they add.

## 7. How to attribute

- **Code**: retain `LICENSE` and `NOTICE`; if you modify files, state that you
  changed them.
- **Documentation**: keep the attribution line shown in Section 3 (or an
  equivalent one) when you reuse prose.
- **Demo content**: attribution is not required (CC0), but the suggested line
  is "Demo content from Chat Terminal Framework contributors (CC0 1.0)".
- **Fonts**: keep `public/fonts/OFL-MaShanZheng.txt` and the copyright notice.

## 8. Status of this document

This document records the project's intended licensing and is not legal
advice. It is a summary and does not modify or replace the full license texts.
Before relying on it for redistribution, commercial use, or any specific
compliance scenario, consult qualified legal counsel.
