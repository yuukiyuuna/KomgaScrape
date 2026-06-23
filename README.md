# Komga Metadata Scraper

一个用于 [Komga](https://komga.org/) 的用户脚本（Userscript），可以从外部数据源抓取漫画 / 书籍的元数据，并写回 Komga。

当前版本：**v1.2.3**

## 功能概览

- 在 **系列详情页 / 书籍详情页** 自动注入“刮削”按钮。
- 支持手动从以下两个数据源抓取元数据：
  - [Bangumi / 番组计划](https://bgm.tv/) —— 官方 `api.bgm.tv` 接口（推荐）。
  - [Fanza / DMM 同人本](https://www.dmm.co.jp/) —— 页面解析，适用于日式同人志 / 成人向书籍。
- 在 **系列详情页** 额外提供“自动刮削”按钮：按 Bangumi 系列下卷号 (`/v0/subjects/{id}/subjects`) 与 Komga 书籍的 `number` 匹配，批量写入并在 Komga 中加锁（标题、简介、发售日期、ISBN、作者、来源链接、序号等）。
- 可选快捷键：`Ctrl+Shift+S` 打开刮削菜单；`Ctrl+Shift+,` 打开设置面板。

> **自动刮削仅支持 Bangumi 源。** Fanza / DMM 源主要面向同人本，命名不规范且数量通常较少，因此不提供自动刮削；如需要请使用页面上的“刮削”按钮手动执行。

## 安装

1. 在浏览器中安装一个 Userscript 管理器，例如：
   - [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox）。
   - [Violentmonkey](https://violentmonkey.github.io/)（开源推荐）。
2. 把本仓库中的 [`komga-metadata-scraper.user.js`](./komga-metadata-scraper.user.js) 内容复制到管理器新建的脚本中，或通过 “从 URL 安装” 加载。
3. **重要：** 打开脚本、把顶部 `// @match {你自己的komga网站地址}` 替换为你自己的 Komga 地址（例如 `https://komga.example.com/*` 或 `http://192.168.0.10:25600/*`）。

4. 保存脚本，刷新 Komga 页面即可看到 “刮削” / “自动刮削” 按钮。

> 如果访问 `api.bgm.tv` 有困难，可在浏览器级别配置代理把 `api.bgm.tv` / `bgm.tv` 的请求走代理（脚本本身不再做代理处理）。

## 使用方式

### 1. 手动刮削

1. 打开一个**系列**或**书籍**详情页，点击右上角 “刮削”。
2. 在弹出菜单中选择数据源（Bangumi 或 Fanza）。
3. 确认搜索结果，脚本会自动填充标题、简介、出版日期、ISBN、作者、标签等字段。
4. 点击“写入”后，字段会被写回 Komga，并自动在 Komga 侧锁定（`*Lock=true`），防止被 Komga 内置的元数据扫描覆盖。

### 2. 自动刮削（仅 Bangumi，仅限系列页）

**前置条件：** 该系列必须先被手动刮削过（或手动在 metadata.links 中添加 `https://bgm.tv/subject/{id}` 的链接），这样脚本才能知道它在 Bangumi 上的 subject id。

**步骤：**
1. 进入系列详情页，点击 "自动刮削" 按钮。
2. 脚本先读取该系列下的全部书籍，再从 `GET https://api.bgm.tv/v0/subjects/{seriesSubjectId}/subjects` 读取系列中的分卷 / 章节条目。
3. 弹出**确认对话框**，显示系列名、书籍总数、匹配数、跳过数。点击 "开始" 进入批处理。
4. 逐本进行：按 Komga 书籍的 `number`（卷号）与 Bangumi 条目中解析出的卷号匹配；匹配成功后调用 `GET https://api.bgm.tv/v0/subjects/{id}` 拉取详细元数据，**直接写入并加锁**（不再要求手动确认）。
5. 每本书的详情拉取失败会自动**最多重试 2 次**（间隔 1.5 秒）。
6. 最后弹出**汇总对话框**：成功写入 / 跳过（未匹配） / 失败 / 总计。

**匹配规则：** 优先匹配 Bangumi 标题中明确标识的 "第 N 卷" / "Vol.N" / "Volume N"；未找到时再取标题里出现的首个整数（1–999 之间，排除像年份这样的误匹配）。Komga 的 `number` 必须**完全相等**才会被写入。不匹配的书籍会报告为"跳过"，不会被动写入。

**字段加锁策略：** 自动刮削写入的所有字段（title、summary、releaseDate、isbn、authors、links、number、numberSort 等）会被自动附加 `*Lock=true`，避免被 Komga 内置扫描覆盖。

### 3. 快捷键

- `Ctrl + Shift + S`：在系列 / 书籍页面打开刮削菜单。
- `Ctrl + Shift + ,`：打开脚本设置面板。

设置面板允许调整：
- 默认刮削源（bangumi / fanza）；
- 输出语言；
- 调试模式开关；
- 频率限制（对外部 API 做节流，避免被拦截）。

## 写回的字段与加锁

脚本向 Komga 写入的字段包括：

| 字段（key） | 说明 | 是否加锁 |
| --- | --- | --- |
| `title` | 书名 / 系列名 | 是 |
| `summary` | 简介 | 是 |
| `status` | 连载状态（仅系列） | 是 |
| `releaseDate` | 发售 / 出版日期（若可解析） | 是 |
| `isbn` | ISBN（若可解析，统一转换为 ISBN-13） | 是 |
| `authors` | 作者 / 作画（以 name + role 列表写入） | 是 |
| `tags` | 标签（与现有 tag 合并去重） | 否 |
| `links` | 来源链接（`Bangumi` 或 `Fanza`） | 否 |
| `readingDirection` | 阅读方向（系列级可选） | 是 |
| `number` | 卷号（仅自动刮削时保持 Komga 值并加锁） | 是 |
| `numberSort` | 排序用卷号（同上） | 是 |

> 脚本通过在 PATCH 请求中附加 `*Lock=true` 的方式完成锁定；Komga 若已存在该字段的锁定状态则保持不变。

## 兼容性与依赖

- **浏览器：** 现代浏览器（Chrome / Edge / Firefox / Safari 最新一两个版本）。
- **Userscript 管理器：** 必须支持 `GM_xmlhttpRequest` / `GM_setValue` / `GM_getValue` / `GM_registerMenuCommand`。
- **Komga 版本：** 任何暴露 `/api/v1/series/{id}`、`/api/v1/books/{id}`、以及对应 `PATCH /metadata` 接口的版本。
- **Bangumi API：** 使用官方 `https://api.bgm.tv/v0/...`，无需鉴权（公开数据）；脚本在请求头中使用 `User-Agent: KomgaMetadataScraper/1.2.0` 标注自身。

## 注意事项

- 脚本不会上传任何数据到第三方；所有请求均在浏览器（通过 GM_xmlhttpRequest）发出，并直接作用于你自己的 Komga 实例。
- 刮削结果**仅供你个人整理馆藏使用**，请遵守相关网站的 robots 与使用条款。
- 自动刮削的默认节流为 **2 秒 / 请求**，可以在设置面板中调节 `rateLimit.minInterval`；若需要更激进的抓取，请自行承担被远端限流的风险。
- **Fanza / DMM 页面可能会随时变更 DOM 结构**，一旦解析失败请在本仓库提出 Issue；Fanza 不支持自动刮削。


