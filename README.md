# MyClash

基于 [Mihomo](https://github.com/MetaCubeX/mihomo/tree/Alpha) 的**覆写脚本与配置文件**，仅适用于 mihomo 内核的代理客户端

> [!IMPORTANT]
>
> ⚠️ 使用脚本或配置时，请关闭代理软件的 DNS 覆写功能，以确保功能正常

## 特色功能

- 🧩 **丰富的分流策略组**：内置 AI、GitHub、YouTube、Google、Telegram、Steam、Netflix、Spotify 等常用分流组，可按需启用
- 🎨 **精美图标**：策略组采用精心绘制的 SVG 图标，支持无损缩放与高清渲染，任意尺寸下均保持清晰
- 🌏 **地区节点自动分组**：自动识别香港、日本、美国、新加坡、台湾等地区，并生成对应策略组
- 🧹 **节点智能整理**：自动补国旗、优化节点名称、过滤无效节点，并按倍率自动分类
- ✨ **精准国内外分流**：区别于常见的 `cn-domain,直连` 分流方案，本仓库采用优化后的 `cn-ip,直连` 作为兜底规则，结合 `cn-domain` 国内 DNS 分流，减少国内流量误走代理、国外流量误判直连的情况，让分流更精准
- 🪶 **轻量规则方案**：采用 `rule-set` 按需加载规则，减少配置体积与内存占用
- 🛡️ **无 DNS 泄露**：DNS 配置与路由规则配套设计，解决 DNS 泄露问题
- 🔧 **私有 DNS 自动处理**：自动处理机场私有 DNS 与节点域名 hosts 映射，无需手动修改
- 🪜 **高级代理功能**：支持自定义节点、链式代理、IPv4 / IPv6 优先及屏蔽代理 QUIC 流量
- 📱 **适配 [Bettbox](https://github.com/appshubcc/Bettbox) 图形化配置**：可直接在图形界面中开关策略组和功能选项，无需手动修改代码

## 本 Fork 的改动

本仓库 fork 自 [AIsouler/MyClash](https://github.com/AIsouler/MyClash)。改动集中在全量版脚本 `Script/mihomoScript.js`；精简版脚本 `Script/Script.js` 只额外接入自定义规则集与「屏蔽代理QUIC流量」默认值，其余（含 `GitHub` 分流组）完全跟随上游。链式代理两版都由上游提供，本 fork 不做任何改动。

- **`GitHub` 分流策略组跟随上游**：该组由上游提供，且**只有全量版有**。本 fork 自 2026-11-05 起不再为精简版补齐——精简版没有 `GitHub` 组，需要请在 Bettbox 里切换到全量版脚本
- **同步上游增强**：零宽/不可见字符节点名匹配、公共 DNS 过滤项扩充（全量版与精简版均已同步）
- **同步上游规则修复**：移除「圣地亚哥」地区匹配词；`屏蔽代理QUIC流量` 改用 `RULE-SET,cn` + `cn_ip` 判定（上游 2026-11-05）；开关名跟随上游 2026-11-06 的统一命名（原 `屏蔽国外QUIC`）
- **CDN 跟随上游**：图标与规则集 CDN 自 2026-11-06 起随上游切到 `fastly.jsdelivr.net`（原 `cdn.jsdmirror.com`）；上游同时删掉了 `DOMAIN,cdn.jsdmirror.com,直连` 前置规则，本 fork 只保留自有规则集源（gh-proxy）的直连条目
- **`屏蔽代理QUIC流量` 默认开启**：上游 2026-11-05 把默认值从 `true` 改成 `false`，本 fork 两版脚本都**保持默认开启**（QUIC 走 UDP，屏蔽后回落 TCP 通常更稳），两个静态 `Config/*.yaml` 里那条规则也已取消注释。不想要可在 Bettbox 里关掉（静态配置则手动注释该行），规则实现本身完全跟随上游
- **同步上游 DNS 调整**：`fake-ip-filter` 里的 `rule-set:geolocation-cn` 换成 `rule-set:cn`（上游 2026-11-05），本 fork 的自定义过滤集 `custom_fakeip_filter` 仍注册在该数组尾部
- **修复极简国内外分流模式崩溃**：修复开启「极简国内外分流模式」（上游 2026-11-06 前叫「极简模式」）时的 `TypeError: vgCfGroups is not iterable`
- **链式代理完全跟随上游**：上游曾于 `cf3d3f6a` 移除、又于 `e0eb0da` 恢复；本 fork 不再维护自有实现，开关、`dialer-proxy` 处理、以及「链式中转」/「链式落地」两个策略组一律用上游代码（2026-11-03 已移除此前的本地语义改动）。**注意上游的两个既有行为**：①开关开启时会把自定义节点已写的 `dialer-proxy` 直接覆盖为「链式中转」，手写的多级链路不保留；②开关关闭后不会清理指向「链式中转」的引用，若自定义节点里手写过该值，mihomo 加载会报 `dialer-proxy not found`
- **分发与开发分离**：客户端导入的 raw 链接指向 `stable` 分支，`main` 是开发分支。自动同步、日常提交都只动 `main`；只有打了 `vX.Y.Z` tag，`release` workflow 才会把 `stable` 快进到该 tag 指向的提交——一次误提交不会再直接推给所有客户端
- **VG 开关职责收敛**：`VG` 只控制家宽相关策略组及其节点排除，不再控制自定义规则集；关闭 VG 时家宽/优选节点会正常归入地区组，而不会凭空消失
- **新增自定义规则集**：接入 `custom_proxy` / `custom_direct` / `custom_direct_ip` 分流规则与 `custom_fakeip_filter` 假 IP 过滤，来自 [ruleset-builder](https://github.com/xinming7/ruleset-builder)，不受任何开关控制、始终生效（全量版与精简版均已接入）
- **修复基础组为空导致的校验失败**：订阅仅含家宽/优选节点时，`VG` 过滤会让 `includeAll` 分流组变成空数组，mihomo 校验会拒绝；现由空组回退兜底（全量版）
- **补全规则集下载直连域名**：`v6.gh-proxy.org`、`gh-proxy.org`、`static-file-global.353355.xyz` 加入前置直连，避免规则集拉取时走代理形成循环依赖（这三条是本 fork 自有源；上游的 CDN 直连条目已于 2026-11-06 随 CDN 切换删除，不再补回）
- **家宽节点并存两套语义**：上游的「家宽节点」组按 `家宽|住宅|原生IP|家庭宽带|ISP|RES|residential` 关键词归类；本 fork 的 `VG家宽` / `🏠 家宽自动` 只认 `🏠 XX-家宽-NN` 固定格式。`VG` 开启时家宽/优选节点不会重复进「家宽节点」与地区组（由 `VG家宽`、`⚡ CF前置` 承载）；关闭 `VG` 时这些节点会正常回落到「家宽节点」与地区组，不会消失（全量版）

使用本 fork 的改动时，请导入以下脚本链接（脚本与配置文件**一律走本仓库**，上游 `AIsouler/MyClash` 的链接只作对照，不含下述特性）：

```text
https://raw.githubusercontent.com/xinming7/MyClash/stable/Script/mihomoScript.js
https://raw.githubusercontent.com/xinming7/MyClash/stable/Script/Script.js
```

> [!NOTE]
>
> 分发走 `stable` 分支，与 `main` 分离：`main` 是开发分支，合并/推送不会自动影响已导入的客户端；只有打了 `vX.Y.Z` tag，`release` workflow 才会把 `stable` 快进到该提交（只做快进，不是 tag 祖先就失败）。想尝鲜可把链接里的 `stable` 换成 `main`，但不要在日常使用中这么做。

## 版本选择

提供**全量版**和**精简版**，两者功能基本一致，仅分流策略组数量不同：

- **全量版**：包含完整的分流策略组，适合需要精细分流的用户
- **精简版**：仅保留常用分流策略组，配置更加简洁

---

## 覆写脚本

> [!IMPORTANT]
>
> - 脚本仅用于覆写机场提供的配置文件，请勿用于覆写自行编写的配置
> - 脚本已处理部分机场私有 DNS 和节点域名 hosts 映射导致的解析问题，请关闭代理软件的 DNS 覆写功能
> - 在 Windows 上如需解决 DNS 泄露，需关闭系统“智能多宿主名称解析”，或在代理软件中开启 [严格路由](https://wiki.metacubex.one/config/inbound/tun/#strict-route)

### DNS 处理（核心特色功能）

越来越多的机场开始使用私有 DNS 解析节点域名，普通公共 DNS 无法正确解析，更有甚者通过 hosts 映射节点域名，再通过本地监听回环到 DNS 解析，普通覆写手段根本无法处理，本项目脚本针对以上情况做了完善的处理，避免覆写后节点无法解析或被解析到垃圾线路（也就是常说的内鬼组），如果遇到解析问题请反馈

### 可配置功能

使用 **[Bettbox](https://github.com/appshubcc/Bettbox)** 时，可以直接通过图形界面管理这些选项

| 分类     | 功能                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| 策略组   | 内置多个分流策略组，每个都可单独开关，根据节点自动生成地区策略组，可选择地区自动选择、手动选择及高 / 低倍率组、家宽组 |
| 节点处理 | 过滤高倍率、低倍率及非地区节点，可统一设置 IPv4 / IPv6 优先                                                           |
| 分流     | 可将全部节点加入分流策略组，也可启用极简国内外分流模式                                                                |
| 网络     | 可选屏蔽代理 QUIC 流量                                                                                                |
| 高级     | 支持自定义节点与链式代理                                                                                              |
| 兼容     | 自动处理节点 hosts 映射及机场私有 DNS                                                                                 |

### 使用方法（脚本）

选择对应版本，将链接或完整代码按如图所示步骤导入支持脚本覆写的客户端即可

- **全量版**

[mihomoScript.js](/Script/mihomoScript.js)，复制下面这个链接使用👇👇👇

```text
https://raw.githubusercontent.com/xinming7/MyClash/stable/Script/mihomoScript.js
```

- **精简版**

[Script.js](/Script/Script.js)，复制下面这个链接使用👇👇👇

```text
https://raw.githubusercontent.com/xinming7/MyClash/stable/Script/Script.js
```

|                                                                                   |
| --------------------------------------------------------------------------------- |
| ![img](Image/import.webp) |

---

## 配置文件

配置文件与覆写脚本的整体效果基本一致，但由于 YAML 是静态配置，无法像脚本那样灵活处理

因此存在以下限制：

- 没有自定义配置项
- 无法根据节点动态生成地区策略组，未匹配到节点的地区会回退到 `REJECT`
- 使用私有 DNS 或 hosts 节点域名映射的机场，需要手动写入配置

### 使用方法（配置）

选择对应版本，将链接或完整代码导入 mihomo 客户端即可

- **全量版**

[mihomoConfig.yaml](/Config/mihomoConfig.yaml)，复制下面这个链接使用👇👇👇

```text
https://raw.githubusercontent.com/xinming7/MyClash/stable/Config/mihomoConfig.yaml
```

- **精简版**

[mihomoConfigLite.yaml](/Config/mihomoConfigLite.yaml)，复制下面这个链接使用👇👇👇

```text
https://raw.githubusercontent.com/xinming7/MyClash/stable/Config/mihomoConfigLite.yaml
```

---

## 上游同步工具

本 fork 自带一批上游没有的特性（VG 家宽三组、自定义规则集、倍率组默认关闭等）。同步上游时手工在冲突里保住这些特性很容易漏，因此提供了 `Tools/sync-upstream.js` 把「对比 → 注入 → 校验」固化下来。

```bash
# 1. 对比：上游领先哪些提交（标出哪些改了脚本）+ 本 fork 特性是否还在位
node Tools/sync-upstream.js compare --fetch

# 2. 注入：把本 fork 特性幂等地注入 Script/ 下两个脚本（先 dry-run 看改动）
node Tools/sync-upstream.js apply --dry-run
node Tools/sync-upstream.js apply

# 3. 校验：只检查特性完整性，可用于 CI
node Tools/sync-upstream.js verify

# 4. 回放：确认「当前脚本 == 上游原版 + 特性清单」，无未声明漂移
node Tools/sync-upstream.js replay

# 5. 体检：上游大改前先看哪些锚点已经贴近断裂边缘（死锚点会非 0 退出）
node Tools/audit-anchors.js
```

`audit-anchors.js` 做的是「提前发现」而不是「事后救火」：同步失败有 `replay` 兜底，但那是等到失败那一刻才知道；体检把上游原版直接喂给注入引擎（此时 marker 不会命中，锚点必须真的存在），再叠加上游历史统计与跨补丁依赖分析，输出每个锚点的风险等级（P0 死锚点 / P1 高风险 / P2 低风险）。加 `--strict` 时，「依赖别的补丁产物」和「从未被验证过」也判失败。

- 补丁是**行级锚点**匹配（忽略缩进），每个补丁带 marker，已注入过会自动跳过，重复执行安全
- 锚点找不到或命中多处会**直接报错并打印锚点首行**，绝不静默跳过；单个文件有补丁失败则整文件不落盘
- 特性清单在 `Tools/lib/feature-manifest.js`，新增 fork 特性请改这里，而不是直接手改上游代码
- 注入完成后建议跑 `node Test/run-tests.js` 验证

### 自动同步

仓库已配置 `.github/workflows/upstream-sync.yaml`：每天北京时间 04:00 检查上游，也可在 Actions 页手动触发（支持 `ref` 与 `dry_run`）。

因为 `replay` 能证明两个脚本等于「上游原版 + 特性清单」，脚本被当作**派生产物**而非合并对象：遇到冲突时不做人工式合并，而是取上游侧后重新注入，正确性由 `replay` 逐字节保证。流程全程在临时分支，五项校验（verify / 幂等 / replay / 测试 / mihomo -t）未全部通过不会推送 `main`；失败会开 issue 附排查顺序与回滚命令，`main` 保持原样。

> 分发走 `@stable`，同步 workflow 只推 `main`，所以自动同步不会直接影响客户端；但打 tag 发布时 `stable` 会快进到 tag 指向的提交，校验顺序仍不可省。首次真推已于 2026-11-01 演练通过（零变更、238 项测试与 mihomo `-t` 四份配置全绿）；`dry_run` 留给「先看差异再决定推不推」的场景。2026-11-03 起内核校验扩到八份（新增「极简国内外分流模式 + VG」「VG + 链式代理 + 自定义节点」「全量版关闭 VG」「精简版 + 链式代理」），用来守住这几条只有真跑装配才会暴露的路径。

### 发布（tag 驱动）

`stable` 不再手动快进：推一个 `vX.Y.Z` tag 就会触发 `.github/workflows/release.yaml`。

```bash
git tag v1.7.1 && git push origin v1.7.1
```

workflow 依次做四件事：解析 tag 指向的提交（`-rc` 预发布 tag 直接跳过）→ 校验 `stable` 是该提交的祖先（保证只做快进；不是祖先就硬失败并打印回滚命令，绝不强推）→ `git push <sha>:stable` → `ls-remote` 回读确认 `stable` 真的落在目标提交上。若 tag 打在 `main` 历史之外（例如直接打在别的分支上）只给 warning，不阻断。想先看效果可手动触发并勾 `dry_run`。

### 漂移告警

发布流程之外的另一条保险是 `.github/workflows/release-drift.yaml`：每天北京时间 05:00 跑 `Tools/check-release-drift.js`，对比 `stable` 与 `main` 落后了多少提交、落后多少天，超过阈值就同时开 issue、发 Telegram、并让 job 失败（`continue-on-error` 只作用于采集步骤，告警步骤必跑）。想验证告警链路本身，可在 Actions 里手动触发并填 `now`（把「当前时间」往后挪，本仓库提交时间往往集中在同一天，否则积压天数恒为 0）。本地也能跑：

```bash
node Tools/check-release-drift.js                  # 默认阈值
node Tools/check-release-drift.js --max-lag-days 14
node Tools/check-release-drift.js --now 2026-12-01  # 用指定时间算「落后天数」，方便测告警
```

AGENTS.md 里引用的脚本行号由 `Tools/check-doc-refs.js` 守着：它把每条「文件:行号 + 特征串」登记在 `Tools/lib/doc-refs.json`，断言特征串必须出现在被引用的那一行（跨行特征串会报歧义）。`--strict` 让未登记的裸引用也报错（CI 用），`--fix` 把漂了的行号就地改回去。


---

## 效果预览

推荐使用 [Bettbox](https://github.com/appshubcc/Bettbox) 管理覆写脚本，可通过图形界面调整策略组和配置项

|                   |                   |                   |                   |
| ----------------- | ----------------- | ----------------- | ----------------- |
| ![img](Image/IMG_1.webp) | ![img](Image/IMG_2.webp) | ![img](Image/IMG_3.webp) | ![img](Image/IMG_4.webp) |
| ![img](Image/IMG_5.webp) | ![img](Image/IMG_6.webp) | ![img](Image/IMG_7.webp) | ![img](Image/IMG_8.webp) |

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=aisouler/myclash&type=date&legend=top-left)](https://www.star-history.com/?repos=aisouler%2Fmyclash&type=date&legend=top-left)

## 致谢

感谢以下项目以及所有上游项目：

- [dahaha-365/YaNet](https://github.com/dahaha-365/YaNet)
- [YiXuanZX/rules](https://github.com/YiXuanZX/rules)
- [appshubcc/bett-rules](https://github.com/appshubcc/bett-rules)
- [Koolson/Qure](https://github.com/Koolson/Qure)
