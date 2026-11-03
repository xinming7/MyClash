# MyClash

## 这是什么

面向 mihomo 内核客户端的**覆写脚本 + 静态配置**仓库，是 `AIsouler/MyClash` 的 fork（remote 为 https://github.com/xinming7/MyClash.git，分支 `main`，工作区干净）。它在配置加载期把机场订阅重写成策略组 + 路由，不预生成任何产物；分发靠客户端直接导入 raw URL。入口文件：`Script/mihomoScript.js`（完整版，1959 行）与 `Script/Script.js`（lite 版，1545 行）。同步上游用 `Tools/sync-upstream.js`（见下文）。

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
  - 回放校验：`node Tools/sync-upstream.js replay [--ref upstream/main] [--json]`，确认「脚本 == 上游 + 清单」，非 0 退出即有未声明漂移
  - 锚点体检：`node Tools/audit-anchors.js [--json] [--strict] [--no-history]`，逐个锚点查「在上游还能不能命中 / 上游历史上被改过几次 / 是否依赖别的补丁的产物」，有死锚点即非 0 退出
  - 文档行号：`node Tools/check-doc-refs.js [--strict] [--fix]`，校验文档里的 `文件:行号` 是否仍指向预期代码；`--fix` 按特征串重新定位（仅唯一命中时改写）
  - 发布漂移：`node Tools/check-release-drift.js [--max-lag-days 7] [--stable ref] [--json]`，查 `stable` 落后 `main` 多少、是否分叉、最新 tag 有没有发出去
  - 首次需配 upstream：`git remote add upstream https://github.com/AIsouler/MyClash.git`
- 配置校验：`/opt/homebrew/bin/mihomo -d <tmpdir> -f <cfg.yaml> -t`（本机 mihomo 1.19.33）
  - 生成待校验产物：`node Tools/gen-config.js Script/mihomoScript.js /tmp/full.json '{"VG":true}'` 与 `node Tools/gen-config.js Script/Script.js /tmp/lite.json`
  - 产物是 JSON 但可直接喂 mihomo（JSON ⊂ YAML）；生成器遇空策略组即非 0 退出
- 构建：（无）
- 发布/部署：客户端直接导入 raw URL，**一律走本仓库 `xinming7/MyClash` 的 `stable` 分支**（`main` 是开发分支，见「分发与发布」）：
  - `https://raw.githubusercontent.com/xinming7/MyClash/stable/Script/mihomoScript.js`
  - `https://raw.githubusercontent.com/xinming7/MyClash/stable/Script/Script.js`
  - `https://raw.githubusercontent.com/xinming7/MyClash/stable/Config/mihomoConfig.yaml`
  - `https://raw.githubusercontent.com/xinming7/MyClash/stable/Config/mihomoConfigLite.yaml`
  - 发布 = 打 tag：`git tag -a vX.Y.Z && git push origin vX.Y.Z`，`release` workflow 自动把 `stable` 快进过去（不再需要手工 push stable）。
  - 两个脚本头部的「源仓库 / 脚本链接」由清单里的 `brand` 特性改写（`brand-header` / `brand-header-lite`），**两版都必须改**：lite 版曾长期漏改，用户打开脚本看到的仍是上游地址。
  - 上游 `AIsouler/MyClash` 的同类链接只作对照，不含本 fork 特性，**不要写进给用户的说明里**。

## 改动流程（用户明确要求）

**每次改完代码，在 commit / push 之前先告诉用户 `README.md` 要不要更新、具体改哪几行、改成什么，
等用户确认后再提交。** README 里的部署方式、配置项、API 端点、可靠性行为都可能随改动过期。

同理，`AGENTS.md` 本身记录的环境事实（部署方式、凭据状态、已知坑）如果被改动影响，也要一并更新。

**改完 `Script/*.js` 后、提交前跑一次 `node Tools/check-doc-refs.js --fix --strict`**：脚本行数一变，
文档里的 `文件:行号` 就可能指向别的代码，肉眼重算靠不住（2026-11-03 那次 18 处里有 10 处要改）。

## 部署与 CI

四个 workflow：`format_and_test.yaml`（校验）、`upstream-sync.yaml`（自动同步上游）、`release.yaml`（打 tag 后快进 stable）、`release-drift.yaml`（stable 积压告警）。

- `format_and_test` 触发：`push`（限定 `main` + 路径 `Script/*`、`Test/**`、`Tools/**`、`**/*.md`、`**/*.yaml`、`**/*.yml`、`.prettierrc*`）、同样路径的 `pull_request`、`workflow_dispatch`。**没有 release/artifact**：产物就是 raw URL 本身。
- job `format`（PR 时跳过，`contents: write`）：装 prettier 后对受控 `.js/.yml/.yaml` 跑 `prettier --write`，有 diff 就以 `github-actions[bot]` 提交 `chore: auto format` 并 push。
- job `test`（`needs: format`）：`npm --prefix Test install` → `node Tools/sync-upstream.js verify` → `node Test/run-tests.js`。**verify 放在测试前**，因为它秒级返回，且是唯一能发现「特性被上游删掉但测试仍全绿」的检查。
- job `doc-refs`（并行，无依赖）：`node Tools/check-doc-refs.js --strict`。文档行号漂移在这里变红；`--strict` 会把「文档里出现未登记的行号引用」也判成失败，防止有人绕过校验表直接写行号。改 `.md` 也会触发本 workflow（`**/*.md` 在 paths 里），所以纯文档改动同样会被检查。
- `release` 与 `release-drift` 的细节见「分发与发布」。
- 产物：无。dist 就是 raw URL 本身；图标与规则源走 jsDelivr（`cdn.jsdmirror.com`），改动必须 commit+push 后客户端才拿得到。

## 分发与发布（2026-11-03 起 `main` 不再直接对外）

客户端导入的地址指向 **`stable` 分支**，`main` 是开发分支：

| 分支/引用 | 用途 | 谁改 |
| --- | --- | --- |
| `main` | 开发主干，自动同步落在它上面 | 人工提交 + `upstream-sync` workflow |
| `stable` | **客户端实际拉取的分支**，只在发布时快进 | 人工，见下 |
| `vX.Y.Z` tag | 发布快照，回滚用 | 人工 |

**发布流程**（`main` 校验全绿之后）只需打一个 tag：

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "release: vX.Y.Z"
git push origin vX.Y.Z        # 触发 release workflow，它把 stable 快进到这个 tag
```

`release.yaml` 做的事：校验 tag 形态（必须是 `vX.Y.Z`）→ 确认 `stable` 是目标提交的祖先（**只做快进，非快进直接失败并给出回滚命令**）→ `git push origin <sha>:stable` → 用 `ls-remote` 回读确认。带 `-` 的预发布 tag（`v1.7.1-rc1`）只打印 notice、不动 stable。也可以用 `workflow_dispatch` 指定任意 ref 并勾 `dry_run` 先看会推什么。

要点：

- **`stable` 只通过 release workflow 移动**。不要在本地 `git push origin main:stable`——那会绕过 tag 与快进校验，出现「客户端版本比最新 tag 还新」这种对不上的状态。
- 分支保护：`main` 禁强推禁删除；`stable` 禁删除但**允许强推**，因为强推是回滚的专用路径，由人手动执行。
- 回滚：`git push --force-with-lease origin vX.Y.(Z-1):stable`（**唯一允许强推 stable 的场景**，要让客户端回到旧代码）。回滚后 `stable` 不再是 `main` 的祖先，`release-drift` 会立刻报 error，这是预期行为，处理方式是重新打 tag 或接受分叉。
- 想让所有人立刻拿到某次改动，就必须打 tag；**只推 `main` 等于没发布**。校验顺序仍然不可省——发布把 `stable` 指过去，也就把 `main` 上的一切交给了所有客户端。
- 浏览器/客户端对 raw URL 有缓存（通常几分钟），换 tag 或换分支会立刻绕开缓存。

**漂移告警**：`release-drift.yaml` 每天 21:00 UTC（北京时间 05:00，排在自动同步之后）跑 `Tools/check-release-drift.js`，三档判定——`stable` 不是 `main` 祖先（error）、待发布提交积压超过 7 天（warn）、最新 tag 没落到 stable 上（notice）。error/warn 会让 job 失败，并按与 `upstream-sync` 相同的三路告警（issue / Telegram / 运行失败邮件）。阈值可用 `workflow_dispatch` 的 `max_lag_days` 临时收紧；填 `now`（如 `2026-12-01`）可把「当前时间」往后挪来复现积压——本仓库提交时间常集中在同一天，否则积压天数恒为 0，warn 分支永远测不到。**这是「推送不再等于发布」之后唯一的兜底**：没有它，忘记打 tag 就等于客户端长期停在旧版本，而且无人察觉。判定详情：`--json` 可看结构化结论；「最新 tag」只看正式 tag，预发布 tag 不算（它按设计就不推进 stable）。

## 自动同步上游

`.github/workflows/upstream-sync.yaml` 每天 20:00 UTC（北京时间次日 04:00）检查上游，也支持手动 `workflow_dispatch`（可指定 `ref`，可勾 `dry_run` 只验证不推送）。

**核心思路：两个脚本是「上游原版 + 特性清单」的派生产物，不是合并对象。** 因此冲突时不做人工式合并，而是取上游侧再重新注入，正确性由 `replay` 逐字节保证。

流程：预检（`replay` 基准 = 上次已合并的上游提交）→ 建临时分支 `sync/upstream-<时间戳>` → 合并 → 注入 → verify → 幂等二次 apply → `replay --ref upstream` → 跑测试 → **内核校验八份配置** → 全绿才 merge 到 main 并 push（推的是 `main`，不是 `stable`，所以这一步不会直接影响客户端）。

内核校验用 `Tools/gen-config.js` 生成六份动态产物，连同两个静态 YAML 一起交给 mihomo `-t`（共八份）：`full`（全量开 `VG`）、`full-noVG`（全量默认，`VG` 关——最常用的形态，早期漏了这条等于默认路径没进过内核）、`full-minimal`（`极简模式` + `VG`，验解构默认值兜底）、`full-chain`（`VG` + `链式代理`，并用第 4 个参数注入自定义节点与 🏠/优选 节点，验两套特性共存）、`lite`（精简版默认）、`lite-chain`（精简版 + `链式代理`，链式是两版共有的上游功能，只验全量版容易漏掉精简版）。第 4 个参数支持 `{custom:[...],subscription:[...]}`：前者写进脚本的 `customizeProxies`，后者追加进订阅节点——链式代理在没有自定义节点时会直接抛错，VG 三组也要订阅里真有对应节点才会生成，没有这个入口这两条路径永远进不了内核校验。产物直接输出 JSON —— JSON 是 YAML 1.2 子集，mihomo 可直接解析，所以不需要引入 YAML 依赖。内核版本固定 `1.19.33` 并缓存。这一步补的是「单元测试全绿但配置非法」的盲区：测试验的是逻辑，验不了内核认不认。

三级降级：

| 级别 | 条件 | 动作 |
| --- | --- | --- |
| L0 直合 | `git merge` 无冲突 | 直接注入 + 五项校验 |
| L1 重建 | 冲突**只在** `Script/mihomoScript.js`、`Script/Script.js` | `merge --abort` → `git merge -X theirs` → `apply` 重新注入。**前置条件：预检 `replay` 通过**（否则说明 main 有未声明漂移，重建会丢代码，此时直接失败转人工） |
| L2 人工 | 冲突含其他文件，或任一补丁 anchor 失败 | 中止，main 不动，开 issue |

**失败与回滚**：全程在临时分支，未通过校验不碰 main，失败即丢弃分支 —— 天然回滚，无需 reset。已合并后发现问题的回退方式：`git revert -m 1 <merge-sha>`。已知良好版本看 tag（`v1.2.0` 起）。

**告警有三路**：① 开 issue（label `upstream-sync-failed`，已有 open issue 则追加评论），正文含运行链接、排查顺序与回滚命令；② Telegram 推送（需 secrets `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`，未配置时静默跳过）；③ GitHub 运行失败邮件。任一通道自身失败只打 warning，不会盖掉原始错误。

**推送前会对齐远程**：校验期间若有其他 workflow（如 `format_and_test` 的自动格式化）或人工提交推进了 main，直接 push 会因非快进失败。workflow 改为失败后 `fetch` + `merge` 再推，最多 3 次，且对齐后**重跑** verify / replay / 测试，避免推出没验过的组合。

**演练真推（零变更）**：上游没有新提交时想验证推送段，可造一个「main + 空提交」的临时分支当模拟上游，再手动 `workflow_dispatch` 真跑：

```bash
git checkout -b test/upstream-sim origin/main
git commit --allow-empty -m "test(sim): 上游模拟更新（空提交）"
git push -u origin test/upstream-sim && git checkout main

gh workflow run upstream-sync.yaml --repo xinming7/MyClash --ref main \
  -f ref=origin/test/upstream-sim -f dry_run=false
```

`AHEAD=1` 能过 gate，合并 → 注入 → 五项校验 → commit → push 全部真实执行，但产物与 main 逐字节相同，raw URL 客户端无感知。确认零变更的方式：`git diff --stat <基线tag> origin/main` 应输出为空。演练完记得删掉远程与本地 `test/upstream-sim`。

2026-11-01 用此法完成首推演练：运行 `41257242980`，L0 直合、注入 0 处/跳过 48 处、238 项测试全过、mihomo `-t` 四份全过，`efbf2e9..60fcf9b main -> main` **第 1 次推送即成功**（未走非快进重试）。代价是 main 多两个提交（空提交 + merge commit），文件不变。

**局限**：零 diff 不满足 `format_and_test` 的 paths 过滤，所以那次没触发它；也验不到「推送带真实文件变更」和「分支保护拒绝后 3 次重试是否生效」。加了分支保护后建议再演练一次。

**注意**：客户端拉的是 `stable` 分支，同步 workflow 只推 `main`，所以它**不会**直接影响客户端（2026-11-03 之前是 @main，推送即发布）。校验顺序仍不可省：发布时 `stable` 会快进到 `main`，等于把这里验过的全部内容交给客户端。首次真推已验证通过（见上），`dry_run` 现在留给「想先看差异再决定推不推」的场景。改 workflow 时别动 `concurrency: upstream-sync`，并发的两次同步会在 push 时互相打断。

## 改这个项目时的坑

- **图标基址指向本仓库，规则源基址仍指上游**：两版脚本里的 `const iconBaseUrl` 由补丁 `brand-icons` 改成 `cdn.jsdmirror.com/gh/xinming7/MyClash@stable/Icons/svg/`（这样仓库里 80 个图标文件才真的被用到；改之前指向上游 `AIsouler/MyClash@main`，本地那份等于死重量）。**但 `Config/*.yaml` 两个静态配置里的图标 URL 仍写死 `AIsouler/MyClash@main/Icons/svg/...`**——它们是上游维护的样例配置，改 20 行会和上游的图标改动反复冲突，故有意不动；两侧图标不完全同步属已知差异。规则源基址由 `const ruleSetBaseUrl` 给出（两版同值 `appshubcc/bett-rules@meta/geo/`），仍是上游的。
- **完整版 / lite 版是两份脚本**：`Script/mihomoScript.js` 与 `Script/Script.js`，各有自己的 `function main(config)`。改一处必须同步改另一处，否则两版行为分叉。
- **下游消费 ruleset-builder 的产物**：完整版脚本从 `xinming7/ruleset-builder` 的 `rules` 分支拉取 4 份规则集（URL 全部走 `v6.gh-proxy.org` 前缀），在 `newConfig['rule-providers']` 里登记：`custom_proxy`（domain/`默认代理`）、`custom_direct`（domain/`直连`）、`custom_direct_ip`（**ipcidr**，规则带 `no-resolve`）、`custom_fakeip_filter`（domain，注册进 `dns.fake-ip-filter` 而非 `rules`）。这 4 个**不受任何开关控制、始终生效**。`ruleOptionsEnable.VG`（开关字段 `VG:`）只控制三件事：家宽/CF 前置策略组的生成（`buildFunctionalGroups` 里 `const vgCfGroups = []` 起的那段）、`vgRegex` 与 `autoExcludeRegex` 的节点排除（`Script/mihomoScript.js:1045`、`Script/mihomoScript.js:1283`）、`vgCfGroupNames` 注入。lite 版与两个 `Config/*.yaml` 完全没有这些引用。
- **规则集下载域名必须走前置直连**：`prefixRules`（`const prefixRules = [`）开头的 `DOMAIN,...,直连` 不是可有可无的优化，是防循环依赖的必需品。provider 下载时要走规则匹配，域名不在直连名单里就会命中 `MATCH,漏网之鱼` 走代理；节点不可用时所有规则集全部拉取失败（实测日志：`[TCP] dial 漏网之鱼 (match Match/) mihomo --> v6.gh-proxy.org:443 error: ... i/o timeout`）。当前已覆盖 `cdn.jsdmirror.com`、`v6.gh-proxy.org`、`gh-proxy.org`、`static-file-global.353355.xyz`（`prefixRules` 里开头那 4 条 `DOMAIN,...,直连`）。**新增任何非 jsDelivr 的规则集源，必须同时把域名加进这个名单**，否则只在节点全挂时才暴露，极难排查。
- **配置校验会被两件事打挂，`empty-fallback` 兜不住**：mihomo `-t` 阶段会拒绝 ①`rules` 里引用了未注册的 rule-provider（删 provider 时必须连规则一起删），②`select`/`url-test`/`load-balance` 组 `proxies` 为空数组（`empty-fallback: 'REJECT'` 只在运行时生效）。第 ① 条典型踩法：`GitHub` 开关关掉后 provider 不注册，但 Microsoft 组曾被误留在规则里（`name: 'Microsoft'` 的规则已删）。第 ② 条典型触发：VG 开启且订阅节点全部命中家宽/优选正则（`if (svc.includeAll && groupProxies.length === 0)` 的空组回退兜底）。**验证方式**：`/opt/homebrew/bin/mihomo -d <tmpdir> -f <cfg.yaml> -t`。
- **同步上游时不能只 diff 一个文件**：上游经常一个提交同时改 `Script/mihomoScript.js`、`Script/Script.js`、`Config/mihomoConfig.yaml`、`Config/mihomoConfigLite.yaml`。2026-10 就漏过一次：上游 `badd718b`「显式定义规则集下载域名规则，避免出现鸡蛋问题」四个文件各 +3 行（在两处 `prefixRules` 与两处 YAML `rules:` 段首插入 `DOMAIN,cdn.jsdmirror.com,直连`），本 fork 当时只 diff 了全量版脚本，整条漏掉，两天后才发现。**正确做法**：先 `curl -s "https://api.github.com/repos/AIsouler/MyClash/commits?per_page=20"` 列出上游提交，再对可疑提交取 `commits/<sha>` 看 `files` 数组，逐个文件核对，而不是只看 `Script/mihomoScript.js`。现在可直接 `node Tools/sync-upstream.js compare --fetch`，它会打印上游每个提交改到的文件并标出 `[改脚本]`。
- **fork 仓库的 Issues 默认是关闭的，issue 告警会稳定失败**：GitHub 对 fork 出来的仓库把 `has_issues` 设为 `false`，此时 `gh issue create` 报 `the '<owner>/<repo>' repository has disabled issues`。2026-10 排查时先误判成 `gh` 按 remote 猜错仓库（那个问题真实存在，已修），其实根因是功能没开。现已启用，workflow 也加了 `has_issues` 探测：未启用时跳过并给 notice，不刷无意义警告。**排查同类问题时先查 `gh api repos/<owner>/<repo> --jq .has_issues`，别急着怀疑权限。**
- **workflow 里 `$变量` 后面紧跟中文会把中文并进变量名**：`echo "fail=$fail（应为 1）"` 在 bash 下会去找名为 `fail（` 的变量，展开为空。写带中文的日志时务必用 `${VAR}` 花括号形式，或让变量后跟空格/标点。同理，`if "$BIN" ... -t | tail -1; then` 的退出码是 `tail` 的而非内核的——**校验类命令绝不能接管道后判 `if`**，否则校验形同虚设。
- **上游「删代码」的提交最阴险：声明被自动合并删掉，而使用点还在**。2026-10 同步上游 `cf3d3f6a`（移除链式代理）时，`链式代理` 开关、`dialerProxyName`、`const chainEnabled`、`const chainGroup` 这些**声明行**在无冲突的情况下被自动删除，而冲突区里保留下来的 `chainEnabled` / `chainGroup` **使用点**还在，于是报 `chainEnabled is not defined` / `chainGroup is not defined`。精简版更隐蔽：`链式代理` 开关被删后，默认值恰好都是 falsy，功能测试仍然全绿，只有 `node Tools/sync-upstream.js compare` 才看得出缺参。**结论**：删功能的提交必须把「声明」和「使用」成对核对，别只看冲突标记。**后续**：上游 `e0eb0da`（2026-11-03）又把链式代理整体恢复了，所以现在这套代码是上游原生的；本 fork 原有的「`dialer-proxy` 只补不覆盖」语义补丁已于同日删除，链式代理完全跟随上游（见下一条）。
- **本 fork 有意偏离上游的地方**（同步时别顺手改回去）：`生成倍率组` 默认 `false`（上游 `true`，**仅全量版**，精简版保持上游的 `true`）；新增 VG 家宽功能（`vgRegex`、`autoExcludeRegex`、`vgCfGroups`，**仅全量版**），其中 `vgCfGroupNames`（`Script/mihomoScript.js:1262` `默认代理`、`Script/mihomoScript.js:1292` / `Script/mihomoScript.js:1300` 分流组、`Script/mihomoScript.js:1327` `漏网之鱼`、`Script/mihomoScript.js:1344` GLOBAL）**有意注入所有分流策略组**，便于把家宽节点作为任意分流目标，不是遗漏；自动选择组里「自动选择」排在 `proxies` 首位（上游排末位，**仅全量版**）；精简版额外补了上游只给全量版的 `GitHub` 分流组。**链式代理已不在偏离清单里**：2026-11-03 起完全跟随上游，连 `dialer-proxy` 语义也不改（上游会覆盖用户已有值、且关闭后不清洗悬空引用，这两点作为已知限制记录在 README）。
- **上游家宽节点组与本 fork VG 家宽是两套语义，别合并**：上游 `d906c45` 的「家宽节点」组用关键词归类（`homeRegionDefinitions` 正则 `家宽|住宅|原生\s*IP|家庭宽带|ISP|RES|residential`），受 `生成家宽节点组` 开关控制；本 fork 的 `VG家宽` / `🏠 家宽自动` 只认 `vgRegex` 的 `🏠 XX-家宽-NN` 固定格式，受 `VG` 开关控制。两者靠「VG 开启时 `buildRegionGroups` 先跳过 VG 节点」保证不重复收录（`Test/suites/integration.js` 有对应用例锁定）。**改任意一边都要先跑这两条用例**。
- **`Tools/sync-upstream.js` 的特性清单是唯一真源**：新增 fork 特性时改 `Tools/lib/feature-manifest.js`，不要只手改脚本——否则下次同步会被上游覆盖。判断注入器是否还准确的方法：把两个脚本临时换成 `git show upstream/main:Script/xxx.js` 后跑 `apply`，结果应与当前合并后的脚本**逐字节一致**（2026-10 实测两版 diff 均为 0）。
- **VG 开关的职责边界是收敛过的，别再把无关东西塞进去**：2026-10 做过一次收敛——`custom_proxy` / `custom_direct` 曾和 VG 绑在同一个三元表达式里（关 VG 就整条规则消失），现已解绑为独立「ruleset-builder 自定义规则集」块；`vgRegex` / `autoExcludeRegex` 的节点排除也加了 VG 门控（`Script/mihomoScript.js:1045`、`Script/mihomoScript.js:1283`），否则关闭 VG 时家宽/优选节点会从所有策略组里凭空消失。判断标准：**VG 只管家宽与 CF 前置相关的东西**；自定义规则集、地区组归属、通用节点过滤都与家宽无关，不该受它控制。
- **空占位必须用户自填**：两个 `Config/*.yaml` 的 `provider1:` 下，`url` 与 `age-secret-key` 都是空串占位，分别填机场订阅链接与解密私钥；仓库内没有任何已提交的订阅或密钥。
- **改了不 push 等于没改，push 了不发布也等于没改**：jsDelivr 与 raw URL 都按分支/提交取内容。脚本与配置走 `@stable`，图标走 `@stable` 的 `Icons/svg/`；只推 `main` 时客户端拿到的仍是上一个 `stable` 提交。发布动作见「分发与发布」一节。
- **测试依赖不装会静默跳过**：`Test/package.json` 的 devDeps（`espree@^9.6.1`、`quickjs-emscripten@^0.32.0`）缺失时，ES2020/QuickJS 检查直接略过，看起来仍然"通过"。
- **静默跳过的第二种形态：依赖装了但损坏**。`Test/lib/es2020-check.js` 的 `tryLoadEspree()` 只在 `e.code === 'MODULE_NOT_FOUND'` 时返回 `null`（跳过），但 `require('espree')` 依赖链里任意一个包损坏同样抛 `MODULE_NOT_FOUND`，表现仍是"已跳过"而非报错。实测过一次：`Test/node_modules/eslint-visitor-keys/dist/` 是空目录（缺 `eslint-visitor-keys.cjs`），ES2020 检查全程跳过、`--es2020` 单独跑还打印"全部测试通过 ✅"。**看到"未安装 espree 依赖，已跳过"时先核对依赖是否真完整**：`ls Test/node_modules/eslint-visitor-keys/dist/` 应有 `eslint-visitor-keys.cjs`；不可信就 `rm -rf Test/node_modules && npm --prefix Test install` 重装（别删 `Test/package-lock.json`）。
- **`Test/package-lock.json` 用 npm 11 安装会多一行**：`npm --prefix Test install` 后 `git status` 会出现该文件的 `M`（1 行变更，lockfileVersion 相关）。提交前用 `git checkout -- Test/package-lock.json` 还原，不要混进功能提交。
- **npm 全局缓存不可写**：`~/.npm` 属主不是当前用户，直接 `npm install` / `npx` 会报 `sudo chown -R 501:20 "/Users/liujiaming/.npm"` 并失败。加 `--cache /tmp/npm-cache`（或 `npm_config_cache=/tmp/npm-cache npx ...`）绕过，不要照提示去 sudo chown。
- **`buildFunctionalGroups()` 的返回值与 `main()` 的解构要保持对齐，但极简模式已不再靠「伪造字段」兜底**：全量版 `buildFunctionalGroups` 返回 8 个字段（末项是 `vgCfGroups,`），`main()` 解构同一组字段，并给 `vgCfGroups` 写了 `= []` 默认值。**为什么改成默认值**：2026-10 曾因极简模式分支漏返回 `vgCfGroups` 报 `TypeError: vgCfGroups is not iterable`，当时靠给极简分支补 `vgCfGroups: []` 修好，但那条补丁每次都得上游返回值中间去找锚点，2026-11-03 同步时正好被上游新增的 `chainGroup` 挤掉。现在由解构默认值兜住，极简模式不必再返回该字段，**新增提前 `return` 分支时也不用同步补齐**；代价是「字段漏返回」不再报错，所以必须靠集成测试断言组真的生成出来（`Test/suites/integration.js` 的「极简模式 + VG」与「VG 与链式代理互不吞噬」两条）。

- **补丁锚点别绑上游会改的业务内容，要绑稳定结构**：`anchor` 匹配的是**上游原版**里的连续行，上游一动那段代码锚点就失效。2026-11-01 就踩了：lite 版补 GitHub 分流组的补丁 `lite-github-service` 把 `rules: ['RULE-SET,ai,AI'],` 当锚点，上游 `170f615`「补充 Claude 第三方组件域名」把它改成了多行数组，同步直接失败。这个失败很阴险：**merge 无冲突 → `apply` 报「注入 0 处」→ `verify` 全绿**（`marker: /name: 'GitHub',/` 命中就 `skipped`，根本不校验锚点），只有 `replay` 才报「锚点未找到」。**别把 `verify` 通过当成锚点没问题的证据。** 修法是换锚点：现改为锚 Telegram 组开头 `['  {', "    name: 'Telegram',"]` + `insertBefore`，插入位置不变，但不再受 AI 组规则变化牵连。**新写补丁时优先锚注释、组名、`const` 声明，不要锚规则数组、开关默认值这类上游常动量。**

- **锚点还分「锚上游原文」和「锚别的补丁的产物」，后者是更隐蔽的失败源**：如果补丁 A 的锚点那一行是补丁 B 注入的（上游原版里根本没有），那 A 的存活就押在 B 身上 —— B 一旦被删/改，A 会跟着炸，而且报错指向 A，排查方向会被带偏。2026-11-02 全量体检（`node Tools/audit-anchors.js`）在 48 个「补丁 × 版本」组合里查出 3 处这种依赖并已消除：`vg-switch`（原来锚 `chain-switch` 注入的 `链式代理: false,`，改锚上游原文的 `代理IPV6优先: false,`——`chain-switch` 已于 2026-11-03 随上游恢复链式代理而删除，锚点留在上游原文上所以不受影响，只是新增的 `VG` 开关现在排在 `链式代理` 之前）、`custom-ruleset-rules`（原来锚 `prefix-domains` 注入的 `DOMAIN,static-file-global.353355.xyz,直连`，改 `insertBefore` 锚「私有网络直连」这组的上游原文）、`custom-fakeip-filter`（原来锚 `'rule-set:fakeip_filter',`，上游「优化/补充 DNS 过滤项」正是在这一段施工，改 `insertBefore` 锚同数组里最闲的 `'rule-set:geolocation-cn',`）。**当时删掉的 `vg-main-groups` 已于 2026-11-03 以「VG 自有载荷」的身份重新加回**（见下一条）：它的锚点改成上游原文的 `...(chainGroup ? [chainGroup] : []),` + `directGroup,`，marker 改成只认 `...vgCfGroups,`，不再押在 `main-groups` 身上。**加新补丁前先跑一遍 `audit-anchors.js --strict`，它会把这类依赖直接判成非 0。**

- **上游重排代码时，同一处会同时存在两种形态——补丁要用「多候选锚点 + 候选级 text」**：2026-11-02 上游 `6bc887c`「代理 IP 规则去掉 no-resolve 并延后到域名规则之后」给 `buildFunctionalGroups` 返回值新增了 `functionalIpRules`，并把 `main()` 里的调用从 5 行折成 2 行，一次打断 3 个补丁 ×2 版本 = 6 个锚点（`chain-return` / `main-destructure` / `chain-minimal-return`）。麻烦点在于**预检 `replay` 用的是 `git merge-base`（旧基线）**，所以 `main` 上的脚本必须仍能被旧形态重建，而合并后又要能被新形态重建——单一锚点做不到。现在 `Tools/lib/patch-engine.js` 支持两种写法：① `substring: true` + 单行片段锚点（只替换行内片段，上游往字段列表中间加东西不受影响）；② `anchor: [{ anchor: [...], text }, ...]` 多候选，按顺序试第一个命中，**每个候选可带自己的 `text`**（旧形态没有 `functionalIpRules`，不能凭空插入；新形态漏了它就会 `functionalIpRules is not defined`）。写多候选时注意 `printWidth: 120`——5 行折行的第一行只要超 120，prettier 就会折回 2 行，所以 `main` 侧只能保留 2 行形态。**2026-11-03 上游恢复链式代理后，`chain-return` / `main-destructure` / `chain-minimal-return` / `chain-groups` / `chain-main` 这些补丁已整体删除**（上游原生具备），多候选能力本身保留备用。

- **比「锚点失效」更隐蔽的是「marker 被上游原生代码抢先命中」**：补丁先查 marker，命中就跳过，根本不走锚点。如果 marker 绑的是一段**上游也可能出现**的写法，那上游一旦写出同样结构，补丁会被判「已存在」，功能整块丢失，而 `verify`（只查 marker）与 `replay`（marker 也命中，回放自然一致）**双双全绿**。2026-11-03 同步上游 `e0eb0da`（恢复链式代理）时就是这样翻车的：`chain-minimal-return` / `chain-full-global` / `main-destructure` / `main-groups` / `chain-return` 的 marker 都是「上游链式代码的产物」，上游把这套代码写回来后全部命中，`vgCfGroups` / `vgCfGroupNames` 的四处载荷被静默丢弃，**VG 功能整个消失且没有任何一个校验步骤报警**。修法是两条：① marker 只写本 fork 独有的文本（例如 `vg-leak-group` 用 `'默认代理', ...vgCfGroupNames, '直连'`，而不是上游也有的 `'默认代理', '直连', ...`）；② **本地特性的载荷必须回归到「自己的特性」名下**，不要寄居在别人的特性里顺带注入（VG 的四处载荷现在独立成 `vg-return` / `vg-global` / `vg-destructure` / `vg-main-groups`，见 `vg-groups`）。**判断某个补丁是否安全的方法：把上游原版单独跑一遍 `apply`，若某补丁被 skip，问一句「上游真的有这个东西吗」——有就必须删掉该补丁，没有就必须收紧 marker。** 按这条规则，`chain-customize`（本 fork 的 `dialer-proxy` 语义补丁）已于 2026-11-03 删除：上游自己就有这段代码，留在清单里只会制造假阳性。`Test/suites/integration.js` 的「VG 与链式代理互不吞噬」与「极简模式 + VG」就是为此加的组合用例。

- **「解构字段漏补」是五项校验里唯一只有测试能抓的错**：同一次上游重构中，如果只更新了锚点、忘记在 `main()` 的解构里补 `functionalIpRules`，会出现极其误导的组合：`replay` **逐字节一致**（它只比字节，不跑代码）、`verify` **特性齐全**、`mihomo -t` **四份全过**，但 `node Test/run-tests.js` 直接红 87 项，报 `functionalIpRules is not defined`。原因是上游 `main()` 的 `rules` 拼接里展开了 `...functionalIpRules`，解构漏了就是未定义变量。**教训：不要因为 replay 绿了就跳过测试；改 `buildFunctionalGroups` 的返回值/解构时，字段集合必须成对核对**（与上面那条「返回值必须与解构对齐」是同一类问题的上游版本）。

## 相关

- 详细档案：`/Users/liujiaming/Documents/deepseek-harness/default-workspace/project-kb/MyClash.md`
- 项目总索引：`/Users/liujiaming/Documents/deepseek-harness/default-workspace/project-kb/INDEX.md`
