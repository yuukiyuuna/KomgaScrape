# Userscript 维护规则

- `master` 同时提供双前端版 `komga-metadata-scraper.user.js` 和 Next UI 专用版 `komga-metadata-scraper-next.user.js`。双前端版沿用既有安装入口、脚本身份和配置键。
- 修改双前端版源码，把 Classic UI 的页面识别、操作区挂载和注册留在 `BEGIN CLASSIC UI` 与 `END CLASSIC UI` 之间。刮削、写回和配置逻辑由两份脚本共用。
- 每次修改后运行 `node scripts/sync-userscripts.mjs` 生成专用版，再运行 `node scripts/sync-userscripts.mjs --check` 和两份脚本的 `node --check`。将生成结果随源码一同提交。
- 发版时更新双前端版的 `@version` 并重新生成专用版，两份脚本使用同一版本。验证双前端版的两种界面，以及专用版的 Next UI 入口和 Classic UI 中的禁用行为。
- 等 Komga 正式发行版明确移除 Classic UI，再用独立变更将安装入口收敛为 Next UI 专用脚本。切换时沿用原安装文件名、脚本身份和配置键，`codex/legacy-ui` 作为归档保留。
