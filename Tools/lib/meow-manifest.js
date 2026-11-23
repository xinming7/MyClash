'use strict';

/**
 * Meow-RS 方言补丁清单
 *
 * 与 `feature-manifest.js` 同一套机制、不同的目标：本清单只用于把
 * `Script/mihomoScript.js` 派生出 `Script/meowScript.js`（由 `Tools/build-meow.js` 执行），
 * 不参与 `sync-upstream.js` 的 4 个派生目标，也不会被注入到 mihomo 版脚本里。
 *
 * 为什么用补丁而不是维护一份手写副本：`Script/concordScript.js` 就是手写副本的下场——
 * 上游改脚本时没人会记得同步它，它也不在任何 CI 里，最后两份文件语义悄悄分叉。
 * 这里把「meow 与 mihomo 的差异」写成数据，上游同步后重跑一次生成即可。
 *
 * 约束：
 *  - 每条 feature 必须标 `only: 'meow'`，否则 `featureAppliesTo` 会把它放进 full/lite 目标。
 *  - 锚点取能唯一定位目标块的连续行（trim 后比较，缩进无关）；锚点找不到会直接抛错，不会静默跳过。
 *  - 每项改动的原因与影响范围见 `Docs/MeowRS适配方案.md` 第 5 节（M1–M10 与这里一一对应）。
 */

// meow-rs 不支持的协议类型（21 种类型逐个探测的结论，见 Docs/MeowRS适配方案.md 实证 #18）
const UNSUPPORTED_PROXY_TYPES = [
  'openvpn',
  'ssr',
  'hysteria',
  'tuic',
  'wireguard',
  'ssh',
  'masque',
  'tailscale',
  'zerotier',
  'mieru',
  'sudoku',
];

const MEOW_FEATURES = [
  {
    id: 'meow-brand',
    title: '头部改为 meow 版 + 生成物声明',
    only: 'meow',
    patches: [
      {
        id: 'meow-brand-header',
        why: '客户端导入的是 meow 版 raw URL；同时标明本文件由工具生成，避免被手改',
        marker: /本文件由 Tools\/build-meow\.js 生成/,
        op: 'replace',
        anchor: [
          '/**',
          ' * mihomo配置覆写脚本（全量版）',
          ' * 作者：AIsouler，xinming7',
          ' * 源仓库：https://github.com/xinming7/MyClash',
          ' * 脚本链接：https://raw.githubusercontent.com/xinming7/MyClash/refs/heads/stable/Script/mihomoScript.js',
          ' * 友情推荐，非常好用、省电且内存占用低的代理软件：https://github.com/appshubcc/Bettbox',
          ' */',
        ],
        text: [
          '/**',
          ' * meow配置覆写脚本（全量版）',
          ' * 作者：AIsouler，xinming7',
          ' * 源仓库：https://github.com/xinming7/MyClash',
          ' * 脚本链接：https://raw.githubusercontent.com/xinming7/MyClash/refs/heads/stable/Script/meowScript.js',
          ' * 兼容说明：已按 meow-rs 兼容性测试裁剪不支持的写法（DNS 出口标签、nameserver-policy 的 system、',
          ' *           内嵌 RULE-SET 的 QUIC 规则、sticky-sessions、TUN 扩展键、openvpn 等协议）',
          ' *',
          ' * 本文件由 Tools/build-meow.js 生成，请勿手工修改——改 Tools/lib/meow-manifest.js 后重跑生成。',
          ' * 差异清单与实测依据见 Docs/MeowRS适配方案.md。',
          ' *',
          ' * 友情推荐，非常好用、省电且内存占用低的代理软件：https://github.com/appshubcc/Bettbox',
          ' */',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'meow-dns-default-ns',
    title: 'default-nameserver 去掉代理标签（否则拒绝加载）',
    only: 'meow',
    patches: [
      {
        id: 'meow-default-ns-untagged',
        why: 'meow 明确禁止 default-nameserver 使用 #PROXY/?proxy=，命中即整份配置失败（实证 #1）',
        marker: /const defaultDNS = \['114\.114\.114\.114',/,
        op: 'replace',
        anchor:
          "const defaultDNS = ['114.114.114.114#DIRECT', 'tls://223.5.5.5#DIRECT', 'https://1.12.12.12/dns-query#DIRECT'];",
        text: "const defaultDNS = ['114.114.114.114', 'tls://223.5.5.5', 'https://1.12.12.12/dns-query'];",
      },
    ],
  },
  {
    id: 'meow-dns-proxy-ns',
    title: 'proxy-server-nameserver 去掉代理标签（否则拒绝加载）',
    only: 'meow',
    patches: [
      {
        id: 'meow-proxy-ns-untagged',
        why: '同 meow 对 default-nameserver 的限制，proxy-server-nameserver 带 #DIRECT 同样致命（实证 #2）',
        marker: /const proxyServerDNS = \['114\.114\.114\.114',/,
        op: 'replace',
        anchor:
          "const proxyServerDNS = ['114.114.114.114#DIRECT', 'tls://223.5.5.5#DIRECT', 'https://doh.pub/dns-query#DIRECT'];",
        text: "const proxyServerDNS = ['114.114.114.114', 'tls://223.5.5.5', 'https://doh.pub/dns-query'];",
      },
    ],
  },
  {
    id: 'meow-dns-proxy-tag',
    title: '加密 DNS 的出口标签改 ?proxy=（# 在 meow 里是 SNI）',
    only: 'meow',
    patches: [
      {
        id: 'meow-foreign-dns-proxy-tag',
        why: 'https://...#默认代理 会被 meow 当成 SNI，DNS 静默不走代理（实证 #3）；?proxy= 才是出口（实证 #4）',
        marker: /const foreignDNS = \['https:\/\/cloudflare-dns\.com\/dns-query\?proxy=/,
        op: 'replace',
        anchor:
          "const foreignDNS = ['https://cloudflare-dns.com/dns-query#默认代理', 'https://dns.google/dns-query#默认代理'];",
        text: "const foreignDNS = [\n  'https://cloudflare-dns.com/dns-query?proxy=默认代理',\n  'https://dns.google/dns-query?proxy=默认代理',\n];",
      },
      {
        id: 'meow-strip-dns-suffix',
        why: '订阅自带的私有 DNS 会经这个函数产出加密条目，仍拼 #DIRECT 会退化成 SNI',
        marker: /return prefix \+ '\?proxy=DIRECT';/,
        op: 'replace',
        anchor: "if (suffix.includes('direct') || suffix.includes('直连')) return prefix + '#DIRECT';",
        text: "  if (suffix.includes('direct') || suffix.includes('直连')) return prefix + '?proxy=DIRECT';",
      },
    ],
  },
  {
    id: 'meow-dns-no-system',
    title: 'nameserver-policy 不用 system（meow 启动即死）',
    only: 'meow',
    patches: [
      {
        id: 'meow-ns-policy-explicit',
        why: "meow 不认 'system' 且按 Class A 直接退出、不降级，且 -t 检不出来（实证 #5/#17）",
        marker: /'rule-set:private': \['223\.5\.5\.5', '119\.29\.29\.29'\],/,
        op: 'replace',
        anchor: "'rule-set:private': 'system',",
        text: "      'rule-set:private': ['223.5.5.5', '119.29.29.29'],",
      },
    ],
  },
  {
    id: 'meow-quic-rule-removed',
    title: '删除 QUIC 屏蔽规则（内嵌 RULE-SET 不被支持）',
    only: 'meow',
    patches: [
      {
        id: 'meow-quic-rule-empty',
        why:
          'meow 不解析逻辑规则里的 RULE-SET，整条规则被丢弃（实证 #6）；SUB-RULE 也不接受 target（实证 #7），' +
          '无法等价改写。按项目决定直接删除，开关保留但对该版本无效',
        marker: /const blockForeignQuic = \[\];/,
        op: 'replace',
        anchor: [
          '// 屏蔽代理QUIC流量',
          'const blockForeignQuic = [',
          "  'AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((RULE-SET,cn),(RULE-SET,cn_ip,no-resolve)))))),REJECT',",
          '];',
        ],
        text: [
          '// 屏蔽代理QUIC流量',
          '// meow 不解析逻辑规则内的 RULE-SET，这条规则会被内核整条丢弃，故 meow 版删除（见 Docs/MeowRS.md）',
          'const blockForeignQuic = [];',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'meow-load-balance-strategy',
    title: '负载均衡策略改 consistent-hashing',
    only: 'meow',
    patches: [
      {
        id: 'meow-lb-strategy',
        why: 'meow 只认 round-robin/consistent-hashing，sticky-sessions 会让整个策略组被丢弃（实证 #9）',
        marker: /strategy: 'consistent-hashing',/,
        op: 'replace',
        anchor: "strategy: 'sticky-sessions',",
        text: "  strategy: 'consistent-hashing',",
      },
    ],
  },
  {
    id: 'meow-tun-keys',
    title: '删除 TUN 的不支持字段',
    only: 'meow',
    patches: [
      {
        id: 'meow-tun-strip',
        why:
          'stack / auto-redirect / strict-route / auto-detect-interface 在 meow 里全部被忽略（实证 #12），' +
          '留着只是噪音；注意这是能力差异，不是语法等价',
        marker: /newConfig\['tun'\] = \{\n    enable: true,\n    'auto-route': true,/,
        op: 'replace',
        anchor: [
          "newConfig['tun'] = {",
          '  enable: true,',
          "  stack: 'mips',",
          "  'auto-route': true,",
          "  'strict-route': true,",
          "  'auto-redirect': true,",
          "  'auto-detect-interface': true,",
          "  'dns-hijack': ['any:53', 'tcp://any:53'],",
          '};',
        ],
        text: [
          "  newConfig['tun'] = {",
          '    enable: true,',
          "    'auto-route': true,",
          "    'dns-hijack': ['any:53', 'tcp://any:53'],",
          '  };',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'meow-keepalive-key',
    title: 'keep-alive-interval 改名 tcp-keepalive-interval',
    only: 'meow',
    patches: [
      {
        id: 'meow-keepalive-rename',
        why: 'meow 忽略旧键并提示改用 tcp-keepalive-interval（实证 #13），改名后才真正生效',
        marker: /newConfig\['tcp-keepalive-interval'\] = 60;/,
        op: 'replace',
        anchor: "newConfig['keep-alive-interval'] = 60;",
        text: "  newConfig['tcp-keepalive-interval'] = 60;",
      },
    ],
  },
  {
    id: 'meow-proxy-type-filter',
    title: '剔除 meow 不支持的协议类型',
    only: 'meow',
    patches: [
      {
        id: 'meow-unsupported-types-const',
        why: '在脚本侧提前剔除，避免内核逐个丢节点刷日志、并让「组会不会变空」变得可预判',
        marker: /const meowUnsupportedProxyTypes = new Set\(\[/,
        op: 'insertBefore',
        anchor: [
          '/**',
          ' * 过滤并标准化节点：剔除内置/信息节点、按配置过滤、去重、修复 dialer-proxy 引用，空列表时抛错',
          ' */',
          'function filterAndNormalizeProxies(config) {',
        ],
        text: [
          '// meow-rs 不支持的协议类型：脚本侧提前剔除（类型清单见 Docs/MeowRS适配方案.md 实证 #18）',
          'const meowUnsupportedProxyTypes = new Set([',
          ...UNSUPPORTED_PROXY_TYPES.map((t) => `  '${t}',`),
          ']);',
          '',
        ].join('\n'),
      },
      {
        id: 'meow-unsupported-types-apply',
        why: '接在现有过滤链上，保持 direct/reject/rematch 的既有语义不变',
        marker: /if \(meowUnsupportedProxyTypes\.has\(type\)\) return false;/,
        op: 'replace',
        anchor: [
          '  const filteredRawProxies = originalProxies.filter((proxy) => {',
          "  const type = String(proxy.type ?? '').toLowerCase();",
          "  if (type === 'direct' || type === 'reject' || type === 'rematch') return false;",
        ],
        text: [
          '  const filteredRawProxies = originalProxies.filter((proxy) => {',
          "    const type = String(proxy.type ?? '').toLowerCase();",
          "    if (type === 'direct' || type === 'reject' || type === 'rematch') return false;",
          '    if (meowUnsupportedProxyTypes.has(type)) return false;',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'meow-proxy-field-sanitize',
    title: 'hysteria2 去掉 ech-opts（否则整条节点被丢弃）',
    only: 'meow',
    patches: [
      {
        id: 'meow-hysteria2-no-ech',
        why:
          "meow 的 hysteria2 不支持 'ech-opts'，命中即整条节点丢弃（实证 #11）；" +
          '删字段比丢节点划算，其它协议的 ECH 仍然保留',
        marker: /delete proxy\['ech-opts'\];/,
        op: 'insertAfter',
        anchor:
          'const filteredProxies = normalizedProxies.map((proxy) => fixDialerProxy(proxy, renameMap, normalizedProxyNames));',
        text: [
          '',
          '  // meow 的 hysteria2 不支持 ECH：去掉该字段，避免整条节点被内核丢弃',
          '  for (const proxy of filteredProxies) {',
          "    if (String(proxy.type ?? '').toLowerCase() === 'hysteria2') delete proxy['ech-opts'];",
          '  }',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'meow-group-reference-guard',
    title: '产物收口：空组补 REJECT、剔除悬空成员引用',
    only: 'meow',
    patches: [
      {
        id: 'meow-prune-groups-fn',
        why:
          'meow 会丢弃空策略组，且对「引用不存在的组」只告警并跳过（实证 #16）——两者都是静默失效，' +
          '必须在产物上先自洽。补 REJECT 与配置本身的 empty-fallback 语义一致',
        marker: /function pruneUnavailableGroups\(config\) \{/,
        op: 'insertBefore',
        anchor: '// --- 主入口 ---',
        text: [
          '/**',
          ' * meow 版兜底：保证策略组之间、组与节点之间的引用全部有效。',
          ' * 空组补 REJECT（与 empty-fallback: REJECT 同义），悬空成员名直接剔除。',
          ' */',
          'function pruneUnavailableGroups(config) {',
          "  const groups = config['proxy-groups'] || [];",
          '  const available = new Set([',
          '    ...groups.map((g) => g.name),',
          '    ...(config.proxies || []).map((p) => p.name),',
          "    'DIRECT',",
          "    'REJECT',",
          "    'REJECT-DROP',",
          "    'PASS',",
          "    'GLOBAL',",
          "    'COMPATIBLE',",
          '  ]);',
          '',
          '  for (const group of groups) {',
          '    if (!Array.isArray(group.proxies)) continue;',
          '    group.proxies = group.proxies.filter((name) => available.has(name));',
          "    if (group.proxies.length === 0) group.proxies = ['REJECT'];",
          '  }',
          '}',
          '',
        ].join('\n'),
      },
      {
        id: 'meow-prune-groups-call',
        why: '在 main 返回前执行，确保产出即自洽',
        marker: /pruneUnavailableGroups\(newConfig\);/,
        op: 'replace',
        anchor: 'return newConfig;',
        text: ['  pruneUnavailableGroups(newConfig);', '  return newConfig;'].join('\n'),
      },
    ],
  },
];

module.exports = { MEOW_FEATURES, UNSUPPORTED_PROXY_TYPES };
