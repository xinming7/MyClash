# MyClash

## 这是什么
面向 mihomo 内核客户端的**覆写脚本 + 静态配置**仓库，是 `AIsouler/MyClash` 的 fork（remote 为 https://github.com/xinming7/MyClash.git，分支 `main`，工作区干净）。它在配置加载期把机场订阅重写成策略组 + 路由，不预生成任何产物；分发靠客户端直接导入 raw URL。入口文件：`Script/mihomoScript.js`（完整版，1750 行）与 `Script/Script.js`（lite 版，1317 行）。

## 技术栈
- JavaScript ES2020：由 mihomo 的覆写脚本引擎执行，必须保持 ES2020 兼容
- YAML：mihomo 配置（proxy-providers / proxy-groups / rule-providers / rules / DNS）
- Node.js 测试套件：`espree`（ES2020 语法检查）+ `quickjs-emscripten`（真实引擎跑 `main()`），只是 devDependencies
- Prettier（`.prettierrc.json`）+ GitHub Actions
- 无构建步骤、无运行时依赖；38 对 SVG/PNG 图标在 `Icons/svg`、`Icons/png`

## 常用命令
- 安装依赖：`npm --prefix Test install`（只装测试依赖；根目录没有 package.json）
- 测试/校验：`node Test/run-tests.js`（CI 同款）
  - 单跑某项：`node Test/run-tests.js --node`、`--es2020`、`--quickjs`
  - npm 别名：`npm --prefix Test test`、`npm --prefix Test run test:quickjs`、`npm --prefix Test run test:es2020`
- 构建：（无）
- 发布/部署：（无构建、无发版）客户端直接导入 raw URL：
  - `https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/mihomoScript.js`
  - `https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/Script.js`
  - `https://raw.githubusercontent.com/AIsouler/MyClash/main/Config/mihomoConfig.yaml`
  - `https://raw.githubusercontent.com/AIsouler/MyClash/main/Config/mihomoConfigLite.yaml`
  - 脚本头部自述的 fork URL：`https://raw.githubusercontent.com/xinming7/MyClash/refs/heads/main/Script/mihomoScript.js`

## 改动流程（用户明确要求）
**每次改完代码，在 commit / push 之前先告诉用户 `README.md` 要不要更新、具体改哪几行、改成什么，
等用户确认后再提交。** README 里的部署方式、配置项、API 端点、可靠性行为都可能随改动过期。

同理，`AGENTS.md` 本身记录的环境事实（部署方式、凭据状态、已知坑）如果被改动影响，也要一并更新。

## 部署与 CI
只有一个 workflow：`.github/workflows/format_and_test.yaml`。
- 触发：`push`（限定 `main` + 路径 `Script/*`、`Test/**`、`**/*.yaml`、`**/*.yml`、`.prettierrc*`）、同样路径的 `pull_request`、`workflow_dispatch`。**没有 cron，也没有 release/artifact**，合并到 `main` 不会自动发版。
- job `format`（PR 时跳过，`contents: write`）：装 prettier 后对受控 `.js/.yml/.yaml` 跑 `prettier --write`，有 diff 就以 `github-actions[bot]` 提交 `chore: auto format` 并 push。
- job `test`（`needs: format`）：`npm --prefix Test install` 后跑 `node Test/run-tests.js`。
- 产物：无。dist 就是 raw URL 本身；图标与规则源走 jsDelivr（`cdn.jsdmirror.com`），改动必须 commit+push 后客户端才拿得到。

## 改这个项目时的坑
- **图标与规则源基址硬编码指向上游 fork**：`Script/mihomoScript.js:149` 与 `Script/Script.js:125` 的 `iconBaseUrl` 指向 `cdn.jsdmirror.com/gh/AIsouler/MyClash@main/...`，规则源基址在 `Script/mihomoScript.js:152` / `Script/Script.js:128`（`appshubcc/bett-rules@meta/geo/`）。所以在自己 fork 里改图标不会被实际引用，改图标必须**同时改掉脚本里的基址**。
- **完整版 / lite 版是两份脚本**：`Script/mihomoScript.js`（`function main(config)` 在 `Script/mihomoScript.js:1651`）与 `Script/Script.js`（`main` 在 `Script/Script.js:1235`）。改一处必须同步改另一处，否则两版行为分叉。
- **下游消费 ruleset-builder 的产物**：完整版脚本在 `Script/mihomoScript.js:1725`（`custom_proxy.mrs`）与 `:1730`（`custom_direct.mrs`）拉取 ruleset-builder 的 `rules` 分支产物，由 `ruleOptionsEnable.VG`（`Script/mihomoScript.js:19`）门控；lite 版与两个 `Config/*.yaml` 完全没有这些引用。
- **空占位必须用户自填**：`Config/mihomoConfig.yaml:29` 的 `url` 与 `:30` 的 `age-secret-key` 是空串占位（`Config/mihomoConfigLite.yaml:29-30` 同样），分别填机场订阅链接与解密私钥；仓库内没有任何已提交的订阅或密钥。
- **改了不 push 等于没改**：jsDelivr 服务的是 `@main`，`AGENT.md:815` 明确要求 commit+push 后改动才生效。
- **测试依赖不装会静默跳过**：`Test/package.json` 的 devDeps（`espree@^9.6.1`、`quickjs-emscripten@^0.32.0`）缺失时，ES2020/QuickJS 检查直接略过，看起来仍然"通过"。
- **静默跳过的第二种形态：依赖装了但损坏**。`Test/lib/es2020-check.js:45` 的 `tryLoadEspree()` 只在 `e.code === 'MODULE_NOT_FOUND'` 时返回 `null`（跳过），但 `require('espree')` 依赖链里任意一个包损坏同样抛 `MODULE_NOT_FOUND`，表现仍是"已跳过"而非报错。实测过一次：`Test/node_modules/eslint-visitor-keys/dist/` 是空目录（缺 `eslint-visitor-keys.cjs`），ES2020 检查全程跳过、`--es2020` 单独跑还打印"全部测试通过 ✅"。**看到"未安装 espree 依赖，已跳过"时先核对依赖是否真完整**：`ls Test/node_modules/eslint-visitor-keys/dist/` 应有 `eslint-visitor-keys.cjs`；不可信就 `rm -rf Test/node_modules && npm --prefix Test install` 重装（别删 `Test/package-lock.json`）。
- **`Test/package-lock.json` 用 npm 11 安装会多一行**：`npm --prefix Test install` 后 `git status` 会出现该文件的 `M`（1 行变更，lockfileVersion 相关）。提交前用 `git checkout -- Test/package-lock.json` 还原，不要混进功能提交。
- **npm 全局缓存不可写**：`~/.npm` 属主不是当前用户，直接 `npm install` / `npx` 会报 `sudo chown -R 501:20 "/Users/liujiaming/.npm"` 并失败。加 `--cache /tmp/npm-cache`（或 `npm_config_cache=/tmp/npm-cache npx ...`）绕过，不要照提示去 sudo chown。
- **`buildFunctionalGroups()` 的返回值必须与 `main()` 的解构对齐**：`Script/mihomoScript.js:1283` 返回 `{ globalGroup, functionalGroups, functionalRules, finalRuleProviders, chainGroup, directGroup, vgCfGroups }`，`main()` 在 `Script/mihomoScript.js:1773` **无条件**解构这 7 个字段。函数里每个提前 `return` 的分支都必须返回同构对象——2026-10 就踩过一次：极简模式分支漏了 `vgCfGroups`，导致 `TypeError: vgCfGroups is not iterable`（`75550f2` 起存在，`v1.0.0` 修复）。**上游 `AIsouler/MyClash` 没有这个 bug，是本 fork 合并 VG 功能时引入的回归**，别拿"上游也这样"当不改的理由。新增提前分支时记得同步补齐。

## 相关
- 详细档案：`/Users/liujiaming/Documents/deepseek-harness/default-workspace/project-kb/MyClash.md`
- 项目总索引：`/Users/liujiaming/Documents/deepseek-harness/default-workspace/project-kb/INDEX.md`
