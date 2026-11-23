# 为 Meow-RS 新增适配脚本的改动方案

> 基线：`main` @ `48a5e10`（v1.9.0），`Script/mihomoScript.js` 2054 行、`Script/Script.js` 1643 行。
> 文中行号均为该基线快照，改代码后会漂移；引用前按锚点重新定位（`node Tools/check-doc-refs.js` 只覆盖根目录/`Test`/`Tools` 的 md，不含 `Docs/`）。
> 事实依据：2026-11-23 用 `meow-rs v0.29.0`（aarch64-darwin 官方二进制）+ `mihomo 1.19.34` 对照实测，见文末「实测记录」。

---

## 0. 结论摘要

1. **meow-rs 内核不执行 JS 覆写脚本**。二进制里没有 QJS / Boa / JavaScriptCore / Rhai 符号，README 与 meow-android 的导入方式只有「Clash YAML 订阅 / YAML 编辑 / 文件导入」。所以「适配脚本」不可能在 meow 内核里跑，只能：
   - 跑在**支持脚本模式但内核换成 meow** 的客户端（FlClash / Clash Party / SubStore 这类），或
   - 作为**离线生成器**，把订阅洗成 meow 能吃的 YAML，供官方 Meow 客户端/内核导入。
2. 本方案的产物同时服务这两种场景：**一份生成式脚本 + 一个 Node 侧生成器**，避免像 `concordScript.js` 那样手写副本、长期漂移。
3. 真正必须改的是 **8 个方言语义点 + 2 个结构点**（节点类型白名单、空组引用完整性）；其余（`.mrs` 规则集、`path-in-bundle`、`hidden`、`empty-fallback`、`find-process-mode`、`ntp`、`unified-delay`、`tcp-concurrent`、`?proxy=` 语法本身）实测 meow 都能接受，**不要动**。
4. 最大的隐性风险不是"报错"，而是 **meow 静默吞掉**：规则指向不存在的组时只打一行 WARN 就继续匹配下一条；`-t` 通过但启动即死（`nameserver-policy: system` 就是这样漏掉的）。所以必须有「真启动探活 + 产物断言」两道 CI 闸。

---

## 1. 实测到的 meow 方言差异（决定改动清单）

| #   | 现象                                                               | meow 行为                                                                         | mihomo 行为                     | 证据                                                                                                                                      |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `default-nameserver` 带 `#DIRECT`                                  | **拒绝加载**，进程退出                                                            | 接受                            | `ERROR ... default-nameserver may not use #PROXY or ?proxy=`                                                                              |
| 2   | `proxy-server-nameserver` 带 `#DIRECT`                             | 同上                                                                              | 接受                            | 同上                                                                                                                                      |
| 3   | 加密条目 `#默认代理`                                               | `#` 被当 **SNI**，不是出口                                                        | `#` 是出口                      | `WARN ... \`#X\` on encrypted entries is SNI — did you mean \`?proxy=X\`?`                                                                |
| 4   | 加密条目 `?proxy=默认代理`                                         | 正确识别为出口                                                                    | 未作断言（mihomo 不是兼容目标） | 实测 `?proxy=` 无告警、正常加载                                                                                                           |
| 5   | `nameserver-policy: 'system'`                                      | **启动即死**（Class A，不降级）                                                   | 支持                            | `ERROR ... has no valid nameservers` + `nameserver-policy: not found rule-set: private`                                                   |
| 6   | 逻辑规则内嵌 `RULE-SET`                                            | 整条丢弃                                                                          | 支持                            | `unknown rule type: RULE-SET`                                                                                                             |
| 7   | `SUB-RULE,块名,组名`                                               | 不支持带 target                                                                   | 支持                            | `SUB-RULE takes exactly <block-name> — trailing fields are not supported`                                                                 |
| 8   | `AND,((NETWORK,UDP),(DST-PORT,443)),REJECT`                        | **支持**                                                                          | 支持                            | `/rules` 回读为 `AND \| UDP AND 443 -> REJECT`                                                                                            |
| 9   | `load-balance strategy: sticky-sessions`                           | 整组丢弃                                                                          | 支持                            | `unknown strategy 'sticky-sessions'`                                                                                                      |
| 10  | `openvpn` 节点                                                     | 不支持，整条丢弃                                                                  | 支持                            | `unsupported proxy type: openvpn`                                                                                                         |
| 11  | `hysteria2` + `ech-opts`                                           | 整条丢弃（其它协议 ECH 可用）                                                     | 支持                            | `'ech-opts' is not supported by the Rust backend`                                                                                         |
| 12  | `tun.stack / auto-redirect / strict-route / auto-detect-interface` | 忽略 + 告警                                                                       | 生效                            | `field is not supported in meow-rs and will be ignored`                                                                                   |
| 13  | `keep-alive-interval`                                              | 忽略（提示改用 `tcp-keepalive-interval`）                                         | 生效                            | 同上                                                                                                                                      |
| 14  | `format: mrs` 规则集                                               | **支持**                                                                          | 支持                            | 本地托管真 `.mrs`：domain 250 条、ipcidr 9681 条解析成功                                                                                  |
| 15  | `path-in-bundle`（45 处）                                          | 静默忽略                                                                          | 使用                            | 无告警、无错误                                                                                                                            |
| 16  | 规则 target 指向不存在的组                                         | **静默跳过该规则**，继续下一条                                                    | 启动报错                        | `rule DOMAIN matched target 'GhostGroup' which is unavailable ... skipping it`                                                            |
| 17  | `-t` 校验                                                          | 只做 offline validation，**漏检 DNS 致命项**                                      | 接近完整                        | `-t` 通过、`meow -f` 启动退出                                                                                                             |
| 18  | 协议支持面                                                         | ss / vmess / vless / trojan / hysteria2 / snell / anytls / http / socks5 / direct | 更宽                            | 21 类型逐个探测：ssr / hysteria(1) / tuic / wireguard / ssh / openvpn / masque / tailscale / zerotier / mieru / sudoku 全部 `unsupported` |

> 注意 #18：meow-android 的 README 把协议面写成 **Shadowsocks / Trojan / AnyTLS / Direct**，比桌面内核窄。若目标是手机端，VLESS / VMess / Hysteria2 是否可用必须先真机确认，这会直接决定"这份配置对手机端还剩多少价值"。

---

## 2. 方案选型

| 方案              | 做法                                                                                                                                         | 代价                                                                                                  | 结论                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| A. 手写整份副本   | 复制 `mihomoScript.js` 改 10 处（8 方言 + 2 结构），像 `concordScript.js` 那样独立维护                                                       | 上游每次改脚本都要手工重放；无 CI 覆盖（concord 现状：不在 `Test/lib/scripts.js`、不在任何 workflow） | ❌ 不采纳，这是漂移的根源                  |
| B. 生成式（推荐） | `Script/meowScript.js` 由 `Tools/build-meow.js` 从 **`mihomoScript.js` + 补丁清单**生成；生成物入库供 raw URL 分发；CI 校验"重新生成无 diff" | 需要一个新工具 + 一份补丁清单                                                                         | ✅ 采纳，与 `sync-upstream` 同一套心智模型 |
| C. 只做静态 YAML  | 手写 `Config/meowConfig.yaml`                                                                                                                | 无法按订阅动态生成组；家宽/地区组全废                                                                 | 作为 B 的补充（手机端只能吃 YAML 时需要）  |

方案 B 的关键收益：上游同步后只需 `node Tools/build-meow.js`，**没有人工合并**；补丁锚点失效时工具明确报错（复用 `patch-engine` 的"不猜"策略），而不是静默生成一份缺功能的脚本。

---

## 3. 目标产物与分发

| 场景                                 | 产物                                                | 分发方式                                        |
| ------------------------------------ | --------------------------------------------------- | ----------------------------------------------- |
| 客户端支持脚本模式、内核是 meow      | `Script/meowScript.js`（+ `meowScriptLite.js`）     | raw URL（`stable` 分支），与现有脚本并列        |
| 官方 Meow 客户端/纯内核（只吃 YAML） | 由 `Tools/meow-emit.js` 从脚本+订阅现生成 YAML/JSON | 用户本地生成后导入 / 交给 SubStore 之类的处理端 |

全部走 `stable` 分支，发布仍靠打 tag，**不新增发布通道**。

> 2026-11-23 决策：**不做静态 `Config/meowConfig*.yaml`**。静态配置无法按订阅动态生成地区/家宽组，与 meow 版的价值点（订阅驱动）冲突；只吃 YAML 的场景统一走 `meow-emit.js`。

---

## 4. 改动清单

### 4.1 新增文件

| 文件                                                    | 作用                                                                                                                   | 为什么必须新增                                                                  | 影响范围                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| `Tools/lib/meow-manifest.js`                            | `MEOW_FEATURES`：12 条补丁的声明（8 方言 + 4 结构，锚点对齐 `mihomoScript.js`）                                        | 把"改哪几行"变成数据，可重复执行、可失败上报                                    | 仅新工具读取                           |
| `Tools/build-meow.js`                                   | 读 `Script/mihomoScript.js` → 应用 `MEOW_FEATURES` → 写 `Script/meowScript.js`；`--check` 只比对不落盘                 | 生成式方案的执行体；`--check` 给 CI 用                                          | 只写 `Script/meow*.js`                 |
| `Script/meowScript.js`                                  | **生成物**，meow 方言全量版（约 1900 行）                                                                              | 分发载体                                                                        | 新入口，不影响现有脚本                 |
| `Tools/meow-emit.js`                                    | Node 侧跑 `meowScript.js` 的 `main()`（复用 `Test/lib/loader.js` 的 vm 沙箱，或 `quickjs-emscripten`）→ 输出 YAML/JSON | 手机端/纯内核只吃 YAML；同时给 CI 提供"可被 `meow -t` 校验的产物"               | 只写指定输出路径                       |
| `Tools/meow-verify.js`                                  | 启动真内核 → 探活 `/version` `/proxies` → 断言组/规则数 → 退出；带超时与端口隔离                                       | `-t` 漏检 DNS 致命项（#17），必须真启动                                         | 仅 CI/本地校验                         |
| `Test/suites/meow.js`                                   | meow 方言断言（见 §8）                                                                                                 | fork 用例只放 `suites/fork.js`（AGENTS.md 约定）；meow 用例体量独立成文件更清晰 | 由 `run-fork-tests.js` 挂载            |
| `Docs/MeowRS.md`                                        | 面向用户的使用说明 + 「与 mihomo 版的区别」                                                                            | 对标 `Docs/FlClashConcord.md`，说明哪些能力必然缩水                             | 文档                                   |
| `Config/meowConfig.yaml`、`meowConfigLite.yaml`（可选） | 静态配置（无脚本场景）                                                                                                 | 手机端只能导入 YAML                                                             | 手工低频维护，需在文档标注"不含动态组" |

### 4.2 修改文件

| 文件                             | 改动                                                                                                                                                                          | 原因                                                                                 | 影响范围                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| `Test/run-fork-tests.js`         | 加入 meow 脚本清单（本文件内定义数组），逐个 `loadScript` + 跑 `suites/meow.js`                                                                                               | 它是 fork 自有文件，改它不会碰上游；**绝不能改 `Test/lib/scripts.js`**（上游施工区） | 只影响 fork 测试入口       |
| `.github/workflows/fork-ci.yaml` | 加 4 步：①`node Tools/build-meow.js --check` ②`node Tools/meow-emit.js` ③`node Tools/meow-verify.js`（下载 meow 二进制，带 sha256 校验、cache）④产物断言 `grep`               | 生成物漂移与方言回退只有 CI 能拦住                                                   | 只加新 step，不动既有 5 步 |
| `README.md`                      | 内核支持表格加一行 Meow；分发说明区分「脚本模式」与「YAML 导入」                                                                                                              | 用户要能选对文件                                                                     | 第 66 行附近的表格         |
| `AGENTS.md`                      | 新增：meow 生成链路、校验命令、已知坑（`-t` 漏检、悬空组静默跳过、`?proxy=` 语法、协议白名单）                                                                                | 记录环境事实，避免下次重新踩                                                         | 文档                       |
| `Tools/lib/doc-refs.json`        | 目前**不需要动**：`check-doc-refs.js` 的 `SCAN_DIRS` 只有 `.`、`Test`、`Tools` 三层顶层，`Docs/` 不在扫描范围；若将来把 `Docs/` 纳入扫描，再登记 `meowScript.js` 的行号特征串 | 避免为一个不存在的校验提前埋配置                                                     | 无（现状）                 |

### 4.3 明确「不修改」的文件与原因

| 文件                                                                                                    | 不改的原因                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Script/mihomoScript.js`、`Script/Script.js`                                                            | 不引入方言开关。多一个 `if (KERNEL === 'meow')` 分支，等于让所有 mihomo 用户承担回归风险，且与"生成式"方案冲突                                                                                                 |
| `Tools/lib/patch-engine.js`                                                                             | 无需改：`applyFeaturesToContent(content, flavor, FEATURES)` 的 `flavor` 已是入参，传 `'meow'` 即可；`featureAppliesTo` 只按 `target`/`only` 过滤，`MEOW_FEATURES` 全部标 `only:'meow'` 就不会串到现有 4 个目标 |
| `Tools/lib/feature-manifest.js`、`Tools/sync-upstream.js` 的 `DEFAULT_FILES`                            | 不把 meow 纳入 4 目标派生体系：`replay` 的基准是 `upstream/main:<file>`，上游没有 `meowScript.js`，模型不成立。强行加入会让 `replay` 永久报 `missing-in-ref`                                                   |
| `Test/lib/scripts.js`、`Test/run-tests.js`、`suites/unit.js`、`suites/integration.js`、`Test/README.md` | 上游施工区，历史上已因此触发过 L2 人工冲突（2026-11-05、2026-11-13）                                                                                                                                           |
| `Config/mihomoConfig*.yaml`                                                                             | meow 的静态配置是**另一份**，不复用不改写                                                                                                                                                                      |
| `format_and_test.yaml`                                                                                  | 上游文件，保持逐字节相同                                                                                                                                                                                       |

---

## 5. 八个必须适配的点（逐项：原因 / 改法 / 影响）

> 编号对应 `Tools/lib/meow-manifest.js` 的 feature id。

### M1 `meow-dns-default-ns` — `default-nameserver` 去标签

- **位置**：`Script/mihomoScript.js:1517`（`defaultDNS`）
- **原因**：实证 #1，meow 把 `#DIRECT` 当非法代理引用，**整份配置拒绝加载**（exit 1）
- **改法**：`['114.114.114.114', 'tls://223.5.5.5', 'https://1.12.12.12/dns-query']`
- **影响**：致命项；去掉标签后语义不变（这些 DNS 本来就是直连出口）

### M2 `meow-dns-proxy-ns` — `proxy-server-nameserver` 去标签

- **位置**：`:1518`（`proxyServerDNS`）
- **原因**：实证 #2，同 M1
- **改法**：同上，三条去 `#DIRECT`
- **影响**：致命项；`buildDnsAndHostsConfig` 的 `shouldRewriteByListen` / hosts 改写逻辑不受影响（它只读订阅里的原始值）

### M3 `meow-dns-proxy-tag` — 加密条目的出口标签改 `?proxy=`

- **位置**：`:1516` `foreignDNS`（**必须改**）、`:1735` `stripDnsSuffix`（订阅自带 DNS 走这里，可能产出加密条目 → 必须改）；`:1515` `chinaDNS` 与 `:1911-1914` 的明文 IP 条目（可选）
- **原因**：实证 #3/#4。`#默认代理` 落在 `https://` 这种加密条目上时，meow 会把 `#` 当 **SNI**，`?proxy=` 才是出口——DNS 查询不再走代理，等于静默丢掉了"境外 DNS 走代理"的设计，弱网下表现为解析失败或回退系统解析（DNS 泄露）。而明文 IP 条目（`223.5.5.5#DIRECT`、`180.184.1.1#DIRECT`）实测被正常当作出口标签，**不改也不报错**
- **改法**：加密条目 `#NAME` → `?proxy=NAME`；`stripDnsSuffix` 的拼接改为 `prefix + '?proxy=DIRECT'`。明文 IP 条目为保持两边一致也建议一并改成 `?proxy=DIRECT`，但**不属于必须项**
- **影响**：中高。必须改的部分不报错、只静默降级，是最难排查的一类；改动只在 DNS 字符串，不涉及函数结构

### M4 `meow-dns-no-system` — `nameserver-policy` 的 `'system'`

- **位置**：`:1910` `'rule-set:private': 'system'`
- **原因**：实证 #5，meow 不支持 `system` 且按 Class A **直接退出**，不降级。更坑的是 **`-t` 检不出来**
- **改法**：换成一个显式直连 DNS（建议 `['223.5.5.5', '119.29.29.29']`），或 `?proxy=DIRECT` 形式
- **影响**：致命项。语义从"系统解析器"变成"指定公共 DNS"，内网域名解析行为会变——必须在文档里写明，并建议内网用户自行补 `nameserver-policy`

### M5 `meow-quic-rule-flatten` — QUIC 屏蔽规则去掉内嵌 `RULE-SET`

- **位置**：`:126-128` `blockForeignQuic`；插入点 `:2044`
- **原因**：实证 #6，meow 不支持逻辑规则里嵌 `RULE-SET`，整条规则被丢（`ruleOptionsEnable.屏蔽代理QUIC流量` 在本 fork 默认 **true**，所以这条是默认生效路径）
- **改法**（三选一，需产品决策）：
  1. **删掉该规则**：最保守，放弃 QUIC 屏蔽（UDP 443 走代理，Youtube 等可能变慢）
  2. **降级为 `AND,((NETWORK,UDP),(DST-PORT,443)),REJECT`**：实证 #8 可用，但失去"排除国内"的条件，会误杀国内 QUIC（视频/直播回退 TCP）
  3. **用顺序近似**：把 `AND,((NETWORK,UDP),(DST-PORT,443)),REJECT` 放在所有国内直连规则之后。域名类 CN 已被 `geolocation-cn` 命中直连，效果接近原意；缺点是纯 IP 的 CN 目标仍可能误杀
- **影响**：中。**不要用 `SUB-RULE` 替代**——实证 #7，meow 的 `SUB-RULE` 不接受 target，`SUB-RULE,块,组` 整条被丢，等于没写

### M6 `meow-lb-strategy` — 负载均衡策略

- **位置**：`:368` `loadBalanceBaseOption.strategy = 'sticky-sessions'`
- **原因**：实证 #9，meow 只认 `round-robin` / `consistent-hashing`，`sticky-sessions` 让**整个 `负载均衡` 组被丢弃**，并连带 `默认代理`、`GLOBAL`、所有引用它的分流组少一个成员（实测：`默认代理` 成员 9 → 7）
- **改法**：`consistent-hashing`（最接近"同一目标走同一节点"的原意）
- **影响**：高。不改不报错但策略组静默消失，用户会在面板里找不到入口

### M7 `meow-tun-keys` — 删 TUN 的不可用字段

- **位置**：`:1996-2004`（`stack: 'mips'`、`auto-redirect`、`strict-route`、`auto-detect-interface`）
- **原因**：实证 #12，全部被忽略并告警。注意 `stack: 'mips'` 是 **mihomo 的合法值**（`mihomo -t` 通过，换成 `bogus` 会 `test failed`），所以它是"mihomo 有效、meow 无效"的字段，不是笔误
- **改法**：删这 4 个键，保留 `enable`、`auto-route`、`dns-hijack`
- **影响**：中。**这是能力差异不是语法差异**：macOS 上 `auto-redirect`（pf 重定向）在 meow 缺失，TUN 接管方式会变；`strict-route` 缺失意味着防泄露能力下降。必须在 `Docs/MeowRS.md` 的「用起来会不太一样的地方」里写明，而不是假装删字段就等价

### M8 `meow-keepalive-key` — `keep-alive-interval` → `tcp-keepalive-interval`

- **位置**：`:1976`
- **原因**：实证 #13，meow 忽略旧键并提示新键名
- **改法**：改键名（语义对齐后才是真的生效）
- **影响**：低，但改了就真生效，属于"顺手修好"

### M9 `meow-proxy-type-filter` — 节点类型白名单

- **位置**：`:908-970` `filterAndNormalizeProxies`（现有过滤只剔除 `direct/reject/rematch`）
- **原因**：实证 #10/#18。meow 不支持 `openvpn / ssr / hysteria(1) / tuic / wireguard / ssh / masque / tailscale / zerotier / mieru / sudoku`，逐个节点报 `unsupported proxy type` 后丢弃。实测这份订阅 320 个节点里 **62 个 openvpn 全丢（19%）**
- **改法**：在 `filterAndNormalizeProxies` 里加一份 meow 支持类型集合，非白名单节点**在脚本侧提前剔除**
- **影响**：高，但收益明确——①日志不再刷 62×N 行噪音；②**组是否为空变得可预判**（配合 M10）；③`手动选择`/地区组不会出现"面板里有、实际不可用"的假节点

### M10 `meow-empty-group-guard` — 空组兜底，保证引用完整

- **位置**：`main()` 末尾（`:2041-2054` 组装 `proxy-groups`/`rules` 之前），新增一个后处理函数
- **原因**：两层事实叠加：
  1. M9 剔除 openvpn 后，`VG家宽`、`🏠 家宽自动` 两个组**成员全空**，meow 会整组丢弃（`group has no valid proxies or providers`）；
  2. 实证 #16，meow 对「规则/组引用不存在的组」**只打一行 WARN 然后跳过该条**——分流静默走偏，不报错、`-t` 也过。
     实测结果：`默认代理` 成员 9→7、`GLOBAL` 少 2 项、40 组变 37 组，且没有任何致命信号
- **改法**（推荐）：**空组补一个 `REJECT` 成员**，而不是删组。理由：原配置的空组语义本来就是 `empty-fallback: REJECT`（`:341`），补 `REJECT` 既保住组不被 meow 删掉，又与原意一致，且引用关系不需要改
- **备选**：删空组 + 把引用它的组内成员与规则 target 改指 `默认代理`。**不推荐**：自动改指会静默改变分流归属
- **影响**：这是 meow 版**唯一需要新增逻辑**的地方（约 15-25 行），其余都是删/改字面量。必须配断言（§8）

### M11 `meow-proxy-field-sanitize` — hysteria2 去掉 `ech-opts`

- **位置**：`filterAndNormalizeProxies` 里 `const filteredProxies = normalizedProxies.map(...)` 之后
- **原因**：实证 #11。meow 的 hysteria2 不支持 `ech-opts`，命中即**整条节点被丢弃**（其它协议的 ECH 可用）。这条不看脚本常量、看订阅内容——任何带 `ech-opts` 的 hysteria2 节点都会中招
- **改法**：在节点标准化之后对 hysteria2 节点 `delete proxy['ech-opts']`，保留节点
- **影响**：中。删字段 vs 丢节点的取舍明确选前者；这条是**唯一依赖订阅数据**的适配点，真实订阅（320 节点）实测命中 1 个（`中国-HY2-69`）

### M12 `meow-ws-no-early-data` — ws 节点把 `max-early-data` 置 0

- **位置**：`filterAndNormalizeProxies` 里 `const filteredProxies = normalizedProxies.map(...)` 之后
- **原因**：实证 #12。meow 的 ws 传输把 early data base64 后写进 `Sec-WebSocket-Protocol`（照抄 mihomo 的约定，`crates/meow-transport/src/ws.rs` 的 `build_request`），随后又把该请求交给 `tokio-tungstenite 0.29` 做 RFC 6455 握手校验；请求里带这个头即被视为「请求了子协议」，服务器不回就判 `SubProtocolError::NoSubProtocol`，日志为 `Server sent no subprotocol`。mihomo（Go）不做这个校验
- **改法**：`max-early-data` 置 0（保留 `early-data-header-name` 便于回退），`max_early_data == 0` 时 meow 不再写该头
- **影响**：中。代价是每个 ws 连接多 1 个 RTT；收益是带该字段的节点从「必挂」变「可用」。真实订阅 249 节点里有 132 个带 `max-early-data: 2048`（由订阅下发，非本脚本生成），实测可用数 `0/255 → 13/255`，`dial error` 归零

### 附带说明（不用改，但要知道）

| 项                                                                                                                                | 结论                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `.mrs` 规则集（45 个 provider）                                                                                                   | meow 原生支持（实证 #14），**保持 `format: mrs` 不动**，不要为 meow 换 `.yaml`                  |
| `path-in-bundle`（45 处）                                                                                                         | meow 静默忽略（实证 #15），保留即可；若想清日志可整条删，但会让 mihomo 版与 meow 版差异无谓变大 |
| `hidden` / `empty-fallback` / `exclude-type` / `max-failed-times` / `tolerance` / `lazy` / `interval`                             | 均被接受，不动                                                                                  |
| `select` 组的 `url`（实证：`select: 'url' is not used`，93 条告警）                                                               | 纯噪音。可选做法：meow 版 `selectBaseOption` 不写 `url`。收益只有日志干净，**列为可选项**       |
| `external-ui` / `external-ui-url` / `bind-address` / `find-process-mode` / `ntp` / `profile` / `unified-delay` / `tcp-concurrent` | 无告警，接受，不动                                                                              |

---

## 6. 与现有逻辑的隔离方式

四道闸，从粗到细：

1. **文件闸**：`Script/meowScript.js` 是生成物，不参与 `sync-upstream` 的 4 目标；`patch-engine.flavorOf()` 白名单里没有它 → 任何人误用 `sync-upstream --file Script/meowScript.js` 会直接报"无法识别的目标文件"，不会半注入。
2. **清单闸**：`MEOW_FEATURES` 每条都标 `only: 'meow'`，`applyFeaturesToContent(content, 'meow', MEOW_FEATURES)` 只匹配自己；现有 `FEATURES` 里 `only: 'full'/'lite'` 的补丁不会误入 meow 目标（反之亦然）。
3. **生成闸**：`Tools/build-meow.js --check` 在 CI 里重跑生成并 `git diff --exit-code`。任何"手改生成物"或"上游改了锚点导致补丁失效"都会被立刻挡下，而不是等到用户节点全挂。
4. **分发闸**：独立 raw URL + 独立文档 + README 表格里与 mihomo 版并列且注明"两套不要混用"，沿用 concord 版已有的用户心智。

---

## 7. 兼容性风险

| 等级 | 风险                            | 说明与缓解                                                                                                                                                                                   |
| ---- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 高   | **`-t` 通过 ≠ 能启动**          | 实证 #5/#17：`nameserver-policy: system` 是 `-t` 放行、启动即死。缓解：`Tools/meow-verify.js` 必须真启动探活；文档里明确禁止把 `-t` 当上线判据                                               |
| 高   | **悬空引用静默跳过**            | 实证 #16：规则 target 缺失只 WARN。缓解：M10 + 产物断言「rules 的 target ⊆ groups ∪ {DIRECT,REJECT,REJECT-DROP,PASS,GLOBAL}」                                                                |
| 高   | **手机端协议面更窄**            | meow-android README 只列 SS/Trojan/AnyTLS/Direct。若成立，VLESS/VMess/Hysteria2 在手机端全部不可用，这份配置对手机端价值有限。**必须先真机确认再决定是否投入**                               |
| 中   | **能力差异被"删字段"掩盖**      | M7 删掉 `auto-redirect/strict-route` 后配置能跑，但 macOS 上 TUN 接管与防泄露能力确实变弱。缓解：文档如实写差异，不做"已适配"的过度承诺                                                      |
| 中   | **`stripDnsSuffix` 的语义替换** | 它同时服务 `privateDNS` 与 `nameserver-policy`，改标签写法会波及「订阅里自带私有 DNS」的机场。缓解：meow 版保留原逻辑，只换标签字符串；`Test/suites/meow.js` 加一条针对含私有 DNS 夹具的断言 |
| 中   | **生成物 1900 行入库**          | 体积与 review 成本；生成物不该手改，但 git 里看不出来。缓解：文件头写一行 `// 本文件由 Tools/build-meow.js 生成，请勿手工修改（改 Tools/lib/meow-manifest.js）`                              |
| 低   | 规则集/图标源被墙               | 与内核无关（mihomo 同环境也只成功 4/49）；文档沿用 concord 版的说明                                                                                                                          |
| 低   | meow 版本漂移                   | 结论基于 v0.29.0；CI 里固定二进制版本 + sha256，升级时先跑 `meow-verify` 再改清单                                                                                                            |

---

## 8. 回归验证点

### 8.1 每次 `build-meow` 之后必跑

| 检查                   | 命令                                                                 | 通过标准                                                     |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| 生成物无漂移           | `node Tools/build-meow.js --check`                                   | 退出码 0                                                     |
| 语法 ES2020            | `node Test/run-tests.js`                                             | 全绿（它扫 `Test/lib/scripts.js`，需另加 meow 到 fork 入口） |
| 方言断言               | `node Test/run-fork-tests.js`                                        | 含 `suites/meow.js` 全部通过                                 |
| 现有 mihomo 版未受影响 | `node Test/run-fork-tests.js` + `node Tools/sync-upstream.js verify` | 全绿                                                         |

### 8.2 产物断言（`Tools/meow-emit.js --assert`，最划算的一组）

对生成的 YAML/JSON 做静态检查，任何一条命中即失败：

1. `dns.default-nameserver` / `dns.proxy-server-nameserver` 里**不得出现** `#` 或 `?proxy=`
2. 全文不得出现 `#DIRECT` / `#默认代理` / `'system'`
3. `proxy-groups[*].strategy` 不得为 `sticky-sessions`
4. 不得有 `tun.stack` / `tun.auto-redirect` / `tun.strict-route` / `tun.auto-detect-interface` / `keep-alive-interval`
5. `proxies[*].type` ⊆ 白名单（§7 #18）
6. `hysteria2` 节点不得带 `ech-opts`
7. **`rules[*].proxy` ⊆ `proxy-groups[].name` ∪ `{DIRECT,REJECT,REJECT-DROP,PASS,GLOBAL,COMPATIBLE}`**
8. 所有 `proxy-groups[].proxies` 里的组名引用必须存在
9. 不得存在内嵌 `RULE-SET` 的 `AND/OR/NOT` 规则

第 7、8 条是 meow 特有的"静默失效"防线，比任何日志都可靠。

### 8.3 内核级

```bash
node Tools/meow-emit.js Script/meowScript.js /tmp/meow.yaml '{"VG":true}'
./meow -f /tmp/meow.yaml -t          # 第一道，会漏检 DNS
node Tools/meow-verify.js /tmp/meow.yaml   # 第二道：真启动 + 探活 + 数断言
```

`meow-verify` 要断言：进程存活、`/version` 200、`/proxies` 组数 == 预期、`/rules` 条数 == 预期、**日志里无 `ERROR`**。

### 8.4 人工/对照

| 场景                   | 做法                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| 与 mihomo 版对照       | 同订阅分别生成，diff 组名/规则名，差异必须**只有** M5/M6/M9/M10 解释得通的那几项        |
| 家宽订阅（含 openvpn） | 用含 `🏠 XX-家宽-NN` 的夹具，确认 `VG家宽`/`🏠 家宽自动` 是"补 REJECT 保住"而不是"消失" |
| 私有 DNS 订阅          | 夹具里带 `dns.nameserver` 自定义条目，确认 `stripDnsSuffix` 改写正确                    |
| 真机                   | 手机端至少验证：SS/Trojan 各一条能通；VLESS/Hysteria2 是否可用（决定文档措辞）          |

---

## 9. 落地顺序（建议分 3 个 PR）

1. **P1 只做生成链路，不改行为**：`Tools/lib/meow-manifest.js`（仅 M1–M4，DNS 四项）+ `Tools/build-meow.js` + 生成 `Script/meowScript.js` + CI 的 `--check` 与 `meow-verify`。目标：能启动、DNS 正确。
2. **P2 修语义差异**：M5（QUIC 规则，需先定方案）、M6（负载均衡）、M7/M8（TUN 与 keepalive）+ 产物断言 1–6 条。
3. **P3 修节点与引用完整性**：M9（类型白名单）、M10（空组兜底）+ 断言 7–9 条 + `Docs/MeowRS.md` + README/AGENTS 更新 + 可选静态 `Config/meowConfig*.yaml`。

每个 PR 都要先回答 AGENTS.md 里那条约定：**README 要不要改、改哪几行**，等确认后再提交。

---

## 10. 已决策（2026-11-23）与落地状态

| 决策点             | 结论                                                            | 落地                                                                                                                      |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| QUIC 屏蔽规则      | **直接删除**（M5 方案 1）                                       | `blockForeignQuic` 置空数组，开关保留但对该版本无效；`meow-emit.js` 断言"逻辑规则不得内嵌 RULE-SET"                       |
| 手机端是否在目标内 | **在**。官方客户端只吃 YAML，故 `meow-emit.js` 是手机端的主路径 | `Docs/MeowRS.md` 的「用法一/用法二」都按"最终喂 YAML"写；VLESS/VMess/Hysteria2 在手机端的可用性仍需真机确认（见 §7 风险） |
| 静态 YAML          | **不做**                                                        | 不新增 `Config/meowConfig*.yaml`，避免与订阅驱动的价值点冲突                                                              |

落地状态（已完成）：

- `Tools/lib/meow-manifest.js`（12 条特性）+ `Tools/build-meow.js`（生成 / `--check` / `--only` / `--dry-run`）
- `Script/meowScript.js` 生成物（prettier 通过；`build-meow --check` 与工作区逐字节一致）
- `Tools/meow-emit.js`（10 条产断言）、`Tools/meow-verify.js`（真启动探活）
- `Test/suites/meow.js` 12 条用例，挂在 `Test/run-fork-tests.js`（未碰 `Test/lib/scripts.js`）
- `fork-ci.yaml` 新增 4 步：build 一致性 → 产物断言 → 下载固定版本 meow（sha256 校验）→ 内核验证
- 文档：`Docs/MeowRS.md`（用户向）、`README.md` 内核表格、`AGENTS.md` 变体说明与已知坑

实测结论：meow 版产物 `meow -t` 零告警通过、真启动 41 组/23 节点/55 规则全部被接受；
同一夹具下 mihomo 版被 `meow-emit` 的断言拦下 16 处、真启动直接退出——正反两边都有对照。

## 附：实测记录（可复现）

```bash
# 二进制与校验
curl -sL -o meow.tar.gz https://github.com/meow-rs/meow-rs/releases/download/v0.29.0/meow-v0.29.0-aarch64-apple-darwin.tar.gz
shasum -a 256 meow.tar.gz   # e5ed5ae6fa0981b5359065820d937d13f3cba5cb92a0b2533209bc120097dd08

# 协议白名单探测（21 类型）
./meow -f types.yaml -t      # 仅 ss/vmess/vless/trojan/hysteria2/snell/anytls/http/socks5/direct 通过类型检查

# .mrs 支持（本地托管真 mrs）
python3 -m http.server 18080 --bind 127.0.0.1   # 提供 private.mrs / cn_ip.mrs
./meow -f mrs-meow.yaml -d /tmp/home
curl -s http://127.0.0.1:19998/providers/rules  # p_domain ruleCount=250, p_ip ruleCount=9681

# ?proxy= 与 AND 规则
./meow -f probe2.yaml -d /tmp/homeA
curl -s http://127.0.0.1:19994/rules            # RULE-SET / AND(UDP AND 443) / MATCH 三条俱在

# 悬空组静默跳过
./meow -f probe3.yaml -d /tmp/homeE             # 规则 target=GhostGroup
# WARN ... which is unavailable for this connection ... skipping it
# 随后落到 MATCH(G)
```

同类报告见 `/Users/liujiaming/Downloads/meow-rs-兼容性测试报告.md`（本次兼容性测试的完整日志与原始配置的适配 diff）。
