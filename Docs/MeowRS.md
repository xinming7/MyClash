# 在 Meow（meow-rs 内核）中使用

[Meow](https://github.com/meow-rs/meow-rs) 的内核 `meow-rs` 是 mihomo 的 Rust 重写版：绝大多数 mihomo 配置能直接跑，但**有几处写法会让整份配置被拒绝**，还有几处在 meow 里会被**静默忽略**（不报错、行为却变了）。因此本仓库为它单独生成了一套脚本：`Script/meowScript.js`。

> [!IMPORTANT]
>
> **meow-rs 内核不执行 JS 覆写脚本。** 它只吃 YAML 配置，官方的 Meow 客户端（Android / iOS）也只提供「订阅 / YAML 编辑 / 文件导入」。所以 `meowScript.js` 不能直接导入 Meow，必须先变成 YAML——见下面两种用法。

---

## 用法一：脚本模式客户端 + Meow（推荐）

适合用 [SubStore](https://github.com/sub-store-org/Sub-Store)、Clash Party 等「订阅处理」工具的用户：让工具用本脚本处理机场订阅，产出的配置再交给 Meow 导入。

```text
https://raw.githubusercontent.com/xinming7/MyClash/stable/Script/meowScript.js
```

1. 在 SubStore 里给该订阅加一条「脚本操作」，填入上面的链接（或把脚本下载到本地后上传）；
2. 刷新订阅，得到处理后的配置；
3. 在 Meow 里「订阅 → 添加」，粘贴上一步的订阅地址；
4. 连上后到「代理组」确认节点与分组是否正常。

## 用法二：本地生成 YAML 再导入

适合只在手机上用、没有订阅处理服务的用户。在电脑上（需要 Node.js）执行：

```bash
git clone https://github.com/xinming7/MyClash.git
cd MyClash
npm --prefix Test install

# 用夹具生成一份可参考的产物（真实使用时把第 4 个参数换成你的订阅节点 JSON）
node Tools/meow-emit.js Script/meowScript.js /tmp/meow.json '{"VG":true}'

# 起一次内核确认这份产物真的能被接受（需要本机有 meow 二进制）
MEOW_BIN=/path/to/meow node Tools/meow-verify.js /tmp/meow.json
```

产物是 JSON（JSON 是 YAML 的子集），Meow 能直接解析；把 `/tmp/meow.json` 传到手机，在 Meow 的「订阅 → 导入 → 从文件」里选中即可。

> [!TIP]
>
> 本仓库**暂不提供** `Config/meowConfig.yaml` 这类静态配置。静态配置无法按订阅动态生成地区/家宽分组，对 Meow 这种只吃 YAML 的客户端来说价值有限，先用上面两条路径。

---

## 与 mihomo 版的区别

meow 版不是新写的脚本，而是从 `mihomoScript.js` **按补丁清单生成**的（`Tools/lib/meow-manifest.js`），策略组、规则集、DNS 分流的整体结构完全一致，只改了 meow 不认的部分。

| 被改动的写法                                                                  | 原因                                                             | 你会感知到什么                                                            |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `default-nameserver` / `proxy-server-nameserver` 去掉 `#DIRECT`               | meow 明确禁止这两个列表带代理标签，命中则**整份配置拒绝加载**    | 无感知（这些 DNS 本来就是直连）                                           |
| 加密 DNS 的出口标签 `#默认代理` → `?proxy=默认代理`                           | meow 把 `#` 当 SNI，不当作出口                                   | 境外 DNS 仍走代理；不改会静默退化成直连解析                               |
| `nameserver-policy` 的 `system` → `223.5.5.5` / `119.29.29.29`                | meow 不认 `system`，且**启动即退出**（`-t` 还检不出来）          | 内网域名改由公共 DNS 解析，需要内网解析的用户请自行补 `nameserver-policy` |
| 删除 QUIC 屏蔽规则                                                            | meow 不支持在逻辑规则里嵌 `RULE-SET`，`SUB-RULE` 也不能替代      | **非国内 QUIC 不再被拦截**，YouTube 等可能走 UDP 443 而不是 TCP           |
| 负载均衡策略 `sticky-sessions` → `consistent-hashing`                         | meow 只认 `round-robin` / `consistent-hashing`，否则整个组被丢弃 | `负载均衡` 组保留，但"同一目标固定同一节点"的粘性弱一些                   |
| 删除 `tun.stack` / `auto-redirect` / `strict-route` / `auto-detect-interface` | meow 不读取，只会告警                                            | TUN 行为由内核固定，macOS 上不再有 pf 自动重定向                          |
| `keep-alive-interval` → `tcp-keepalive-interval`                              | meow 只认新键名                                                  | 保活真正生效                                                              |
| 剔除 `openvpn` 等不被支持的节点                                               | meow 不支持这些协议，节点会被内核逐个丢弃                        | `VG家宽` / `🏠 家宽自动` 组在没有可用家宽节点时不会出现                   |

## 用起来会不太一样的地方

这些是 meow-rs 与 mihomo 的固有差异，和本仓库的配置无关，遇到时不必当成故障：

- **不支持的节点会被丢弃**：`openvpn`、`ssr`、`hysteria`(v1)、`tuic`、`wireguard`、`ssh`、`masque`、`tailscale`、`zerotier`、`mieru`、`sudoku`。本仓库已在脚本侧提前剔除，所以「节点比 mihomo 版少」是预期行为。支持的协议为 SS / VMess / VLESS / Trojan / Hysteria2 / Snell / AnyTLS / HTTP / SOCKS5 / DIRECT。
- **手机端协议面还需确认**：`meow-android` 的说明里只列了 Shadowsocks / Trojan / AnyTLS / Direct。若你的订阅以 VLESS 或 Hysteria2 为主，建议先在真机上验证再决定是否切换。
- **`hysteria2` + `ech-opts` 的节点会被丢弃**：meow 对这类节点不支持 ECH，其它协议的 ECH 仍可用。
- **规则指向不存在的策略组时，meow 只告警不报错**：该条规则会被跳过，流量落到后面的规则。本仓库已在生成时保证引用自洽（空组补 `REJECT`），自行改配置时请注意。
- **`meow -t` 不能当作「能用」的判据**：它只做离线校验，`nameserver-policy` 这类致命项检不出来。改完配置请真的启动一次。
- **TUN 与透明代理**：meow 的 TUN 行为比 mihomo 更"自决"，`strict-route`、`auto-redirect` 这类开关不存在；需要精细控制时以 meow 官方文档为准。

## 常见问题

**导入后提示配置被拒绝 / 内核起不来**

先看内核日志里的 `ERROR` 行。最常见的是 DNS 段被改回了 `#DIRECT` 或 `system`——这两个在 meow 里都是致命项。

**策略组少了一个**

`负载均衡` 组只有在策略被支持时才存在；`VG家宽` / `🏠 家宽自动` 需要订阅里存在家宽节点（且协议受支持）。

**想回到 mihomo**

把配置里的脚本换回 `mihomoScript.js` / `Script.js`，或导入 `Config/mihomoConfig.yaml` 即可，两套文件互不影响。

**规则集 / 图标加载慢**

两者都走 jsDelivr 的 `fastly.jsdelivr.net`，国内网络不佳时属于 CDN 问题，不是内核问题。

---

参考：[meow-rs 仓库](https://github.com/meow-rs/meow-rs) · 本仓库的适配取舍与实测依据见 [Meow-RS 适配方案](./MeowRS适配方案.md)
