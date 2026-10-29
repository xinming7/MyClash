# MyClash

## 这是什么

面向 mihomo 内核客户端的**覆写脚本 + 静态配置**仓库，是 `AIsouler/MyClash` 的 fork（remote 为 https://github.com/xinming7/MyClash.git，分支 `main`，工作区干净）。它在配置加载期把机场订阅重写成策略组 + 路由，不预生成任何产物；分发靠客户端直接导入 raw URL。入口文件：`Script/mihomoScript.js`（完整版，1929 行）与 `Script/Script.js`（lite 版，1515 行）。同步上游用 `Tools/sync-upstream.js`（见下文）。

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
- 同步上游：`node Tools/sync-upstream.js compare --fetch`（差异报告 + 特性在位检查）
  - 注入特性：`node Tools/sync-upstream.js apply --dry-run` 确认后去掉 `--dry-run`
  - 只查不改：`node Tools/sync-upstream.js verify`（适合放进 CI）
  - 首次需配 upstream：`git remote add upstream https://github.com/AIsouler/MyClash.git`
- 配置校验：`/opt/homebrew/bin/mihomo -d <tmpdir> -f <cfg.yaml> -t`（本机 mihomo 1.19.33）
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
- **下游消费 ruleset-builder 的产物**：完整版脚本从 `xinming7/ruleset-builder` 的 `rules` 分支拉取 4 份规则集（URL 全部走 `v6.gh-proxy.org` 前缀），在 `newConfig['rule-providers']` 里登记：`custom_proxy`（domain/`默认代理`）、`custom_direct`（domain/`直连`）、`custom_direct_ip`（**ipcidr**，规则带 `no-resolve`）、`custom_fakeip_filter`（domain，注册进 `dns.fake-ip-filter` 而非 `rules`）。这 4 个**不受任何开关控制、始终生效**。`ruleOptionsEnable.VG`（`Script/mihomoScript.js:64`）只控制三件事：家宽/CF 前置策略组的生成（`Script/mihomoScript.js:1167` 起）、`vgRegex` 与 `autoExcludeRegex` 的节点排除（`Script/mihomoScript.js:1016`、`:1229`）、`vgCfGroupNames` 注入。lite 版与两个 `Config/*.yaml` 完全没有这些引用。
- **规则集下载域名必须走前置直连**：`prefixRules`（`Script/mihomoScript.js:68`）开头的 `DOMAIN,...,直连` 不是可有可无的优化，是防循环依赖的必需品。provider 下载时要走规则匹配，域名不在直连名单里就会命中 `MATCH,漏网之鱼` 走代理；节点不可用时所有规则集全部拉取失败（实测日志：`[TCP] dial 漏网之鱼 (match Match/) mihomo --> v6.gh-proxy.org:443 error: ... i/o timeout`）。当前已覆盖 `cdn.jsdmirror.com`、`v6.gh-proxy.org`、`gh-proxy.org`、`static-file-global.353355.xyz`（`Script/mihomoScript.js:72-74`）。**新增任何非 jsDelivr 的规则集源，必须同时把域名加进这个名单**，否则只在节点全挂时才暴露，极难排查。
- **配置校验会被两件事打挂，`empty-fallback` 兜不住**：mihomo `-t` 阶段会拒绝 ①`rules` 里引用了未注册的 rule-provider（删 provider 时必须连规则一起删），②`select`/`url-test`/`load-balance` 组 `proxies` 为空数组（`empty-fallback: 'REJECT'` 只在运行时生效）。第 ① 条典型踩法：`GitHub` 开关关掉后 provider 不注册，但 Microsoft 组曾被误留在规则里（`Script/mihomoScript.js:496` 已修）。第 ② 条典型触发：VG 开启且订阅节点全部命中家宽/优选正则（`Script/mihomoScript.js:1255-1257` 的空组回退兜底）。**验证方式**：`/opt/homebrew/bin/mihomo -d <tmpdir> -f <cfg.yaml> -t`。
- **同步上游时不能只 diff 一个文件**：上游经常一个提交同时改 `Script/mihomoScript.js`、`Script/Script.js`、`Config/mihomoConfig.yaml`、`Config/mihomoConfigLite.yaml`。2026-10 就漏过一次：上游 `badd718b`「显式定义规则集下载域名规则，避免出现鸡蛋问题」四个文件各 +3 行（在两处 `prefixRules` 与两处 YAML `rules:` 段首插入 `DOMAIN,cdn.jsdmirror.com,直连`），本 fork 当时只 diff 了全量版脚本，整条漏掉，两天后才发现。**正确做法**：先 `curl -s "https://api.github.com/repos/AIsouler/MyClash/commits?per_page=20"` 列出上游提交，再对可疑提交取 `commits/<sha>` 看 `files` 数组，逐个文件核对，而不是只看 `Script/mihomoScript.js`。现在可直接 `node Tools/sync-upstream.js compare --fetch`，它会打印上游每个提交改到的文件并标出 `[改脚本]`。
- **上游「删代码」的提交最阴险：声明被自动合并删掉，而使用点还在**。2026-10 同步上游 `cf3d3f6a`（移除链式代理）时，`链式代理` 开关、`dialerProxyName`、`const chainEnabled`、`const chainGroup` 这些**声明行**在无冲突的情况下被自动删除，而冲突区里保留下来的 `chainEnabled` / `chainGroup` **使用点**还在，于是报 `chainEnabled is not defined` / `chainGroup is not defined`。精简版更隐蔽：`链式代理` 开关被删后，默认值恰好都是 falsy，功能测试仍然全绿，只有 `node Tools/sync-upstream.js compare` 才看得出缺参。**结论**：删功能的提交必须把「声明」和「使用」成对核对，别只看冲突标记。
- **本 fork 有意偏离上游的地方**（同步时别顺手改回去）：`生成倍率组` 默认 `false`（上游 `true`，**仅全量版**，精简版保持上游的 `true`）；保留链式代理功能（上游 `cf3d3f6a` 已整体移除，含 100+ 行测试，**两版都保留**）；新增 VG 家宽功能（`vgRegex`、`autoExcludeRegex`、`vgCfGroups`，**仅全量版**），其中 `vgCfGroupNames`（`Script/mihomoScript.js:1195-1345` 区间）**有意注入所有分流策略组**，便于把家宽节点作为任意分流目标，不是遗漏；自动选择组里「自动选择」排在 `proxies` 首位（上游排末位，**仅全量版**）；精简版额外补了上游只给全量版的 `GitHub` 分流组。
- **上游家宽节点组与本 fork VG 家宽是两套语义，别合并**：上游 `d906c45` 的「家宽节点」组用关键词归类（`homeRegionDefinitions` 正则 `家宽|住宅|原生\s*IP|家庭宽带|ISP|RES|residential`），受 `生成家宽节点组` 开关控制；本 fork 的 `VG家宽` / `🏠 家宽自动` 只认 `vgRegex` 的 `🏠 XX-家宽-NN` 固定格式，受 `VG` 开关控制。两者靠「VG 开启时 `buildRegionGroups` 先跳过 VG 节点」保证不重复收录（`Test/suites/integration.js` 有对应用例锁定）。**改任意一边都要先跑这两条用例**。
- **`Tools/sync-upstream.js` 的特性清单是唯一真源**：新增 fork 特性时改 `Tools/lib/feature-manifest.js`，不要只手改脚本——否则下次同步会被上游覆盖。判断注入器是否还准确的方法：把两个脚本临时换成 `git show upstream/main:Script/xxx.js` 后跑 `apply`，结果应与当前合并后的脚本**逐字节一致**（2026-10 实测两版 diff 均为 0）。
- **VG 开关的职责边界是收敛过的，别再把无关东西塞进去**：2026-10 做过一次收敛——`custom_proxy` / `custom_direct` 曾和 VG 绑在同一个三元表达式里（关 VG 就整条规则消失），现已解绑为独立「ruleset-builder 自定义规则集」块；`vgRegex` / `autoExcludeRegex` 的节点排除也加了 VG 门控（`Script/mihomoScript.js:1016`、`:1229`），否则关闭 VG 时家宽/优选节点会从所有策略组里凭空消失。判断标准：**VG 只管家宽与 CF 前置相关的东西**；自定义规则集、地区组归属、通用节点过滤都与家宽无关，不该受它控制。
- **空占位必须用户自填**：`Config/mihomoConfig.yaml:29` 的 `url` 与 `:30` 的 `age-secret-key` 是空串占位（`Config/mihomoConfigLite.yaml:29-30` 同样），分别填机场订阅链接与解密私钥；仓库内没有任何已提交的订阅或密钥。
- **改了不 push 等于没改**：jsDelivr 服务的是 `@main`，`AGENT.md:815` 明确要求 commit+push 后改动才生效。
- **测试依赖不装会静默跳过**：`Test/package.json` 的 devDeps（`espree@^9.6.1`、`quickjs-emscripten@^0.32.0`）缺失时，ES2020/QuickJS 检查直接略过，看起来仍然"通过"。
- **静默跳过的第二种形态：依赖装了但损坏**。`Test/lib/es2020-check.js:45` 的 `tryLoadEspree()` 只在 `e.code === 'MODULE_NOT_FOUND'` 时返回 `null`（跳过），但 `require('espree')` 依赖链里任意一个包损坏同样抛 `MODULE_NOT_FOUND`，表现仍是"已跳过"而非报错。实测过一次：`Test/node_modules/eslint-visitor-keys/dist/` 是空目录（缺 `eslint-visitor-keys.cjs`），ES2020 检查全程跳过、`--es2020` 单独跑还打印"全部测试通过 ✅"。**看到"未安装 espree 依赖，已跳过"时先核对依赖是否真完整**：`ls Test/node_modules/eslint-visitor-keys/dist/` 应有 `eslint-visitor-keys.cjs`；不可信就 `rm -rf Test/node_modules && npm --prefix Test install` 重装（别删 `Test/package-lock.json`）。
- **`Test/package-lock.json` 用 npm 11 安装会多一行**：`npm --prefix Test install` 后 `git status` 会出现该文件的 `M`（1 行变更，lockfileVersion 相关）。提交前用 `git checkout -- Test/package-lock.json` 还原，不要混进功能提交。
- **npm 全局缓存不可写**：`~/.npm` 属主不是当前用户，直接 `npm install` / `npx` 会报 `sudo chown -R 501:20 "/Users/liujiaming/.npm"` 并失败。加 `--cache /tmp/npm-cache`（或 `npm_config_cache=/tmp/npm-cache npx ...`）绕过，不要照提示去 sudo chown。
- **`buildFunctionalGroups()` 的返回值必须与 `main()` 的解构对齐**：`Script/mihomoScript.js:1299` 返回 `{ globalGroup, functionalGroups, functionalRules, finalRuleProviders, chainGroup, directGroup, vgCfGroups }`，`main()` 在 `Script/mihomoScript.js:1790` **无条件**解构这 7 个字段。函数里每个提前 `return` 的分支都必须返回同构对象——2026-10 就踩过一次：极简模式分支漏了 `vgCfGroups`，导致 `TypeError: vgCfGroups is not iterable`（`75550f2` 起存在，`v1.0.0` 修复）。**上游 `AIsouler/MyClash` 没有这个 bug，是本 fork 合并 VG 功能时引入的回归**，别拿"上游也这样"当不改的理由。新增提前分支时记得同步补齐。

## 相关

- 详细档案：`/Users/liujiaming/Documents/deepseek-harness/default-workspace/project-kb/MyClash.md`
- 项目总索引：`/Users/liujiaming/Documents/deepseek-harness/default-workspace/project-kb/INDEX.md`
