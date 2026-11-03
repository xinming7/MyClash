'use strict';

/**
 * 本 fork 自定义特性清单（声明式补丁）
 *
 * 每条特性 = 一组补丁；每个补丁 = 一个「锚点 → 新文本」的替换/插入动作。
 * 补丁的 marker 命中即视为已注入并跳过，因此对同一份脚本重复执行是安全的。
 *
 * 维护约定：
 *  - 新增 fork 特性时，在这里加一条，不要直接手改上游代码——否则下次同步又会被覆盖。
 *  - anchor 只取能唯一定位目标块的连续几行（trim 后比较，缩进无关）。
 *  - 上游改了目标代码导致锚点找不到时，工具会明确报错并打印锚点首行，按提示更新即可。
 *
 * 文本里若出现 ${...} 或反斜杠正则，注意转义（\${ } 与 \\）。
 */

const FEATURES = [
  {
    id: 'brand',
    title: '脚本头部作者、源仓库与图标基址指向本 fork',
    patches: [
      {
        id: 'brand-header',
        why: '客户端直接导入本 fork 的 raw URL，头部信息需指向 fork',
        only: 'full',
        marker: /源仓库：https:\/\/github\.com\/xinming7\/MyClash/,
        op: 'replace',
        anchor: [
          ' * 作者：AIsouler',
          ' * 源仓库：https://github.com/AIsouler/MyClash',
          ' * 脚本链接：https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/mihomoScript.js',
        ],
        text: [
          ' * 作者：AIsouler，xinming7',
          ' * 源仓库：https://github.com/xinming7/MyClash',
          ' * 脚本链接：https://raw.githubusercontent.com/xinming7/MyClash/refs/heads/stable/Script/mihomoScript.js',
        ].join('\n'),
      },
      {
        id: 'brand-header-lite',
        why: '同上，精简版头部与全量版只差脚本文件名，但同样是分发出去的地址',
        only: 'lite',
        marker: /源仓库：https:\/\/github\.com\/xinming7\/MyClash/,
        op: 'replace',
        anchor: [
          ' * 作者：AIsouler',
          ' * 源仓库：https://github.com/AIsouler/MyClash',
          ' * 脚本链接：https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/Script.js',
        ],
        text: [
          ' * 作者：AIsouler，xinming7',
          ' * 源仓库：https://github.com/xinming7/MyClash',
          ' * 脚本链接：https://raw.githubusercontent.com/xinming7/MyClash/refs/heads/stable/Script/Script.js',
        ].join('\n'),
      },
      {
        id: 'brand-icons',
        why: '图标基址原指向上游 AIsouler 仓库（本仓库内 80 个图标文件等于没用上）；改指本仓库后图标自持，不再依赖上游仓库存在',
        marker: /gh\/xinming7\/MyClash@stable\/Icons\/svg\//,
        op: 'replace',
        anchor: "const iconBaseUrl = 'https://cdn.jsdmirror.com/gh/AIsouler/MyClash@main/Icons/svg/';",
        text: "const iconBaseUrl = 'https://cdn.jsdmirror.com/gh/xinming7/MyClash@stable/Icons/svg/';",
      },
    ],
  },

  {
    id: 'rate-default-off',
    title: '「生成倍率组」默认关闭（仅全量版）',
    only: 'full',
    patches: [
      {
        id: 'rate-default-off',
        why: '上游默认开启倍率组，本 fork 全量版改为默认关闭以精简策略组（精简版保持上游默认）',
        marker: /生成倍率组: false,/,
        op: 'replace',
        anchor: '  生成倍率组: true, // 是否生成低倍率/高倍率策略组',
        text: '  生成倍率组: false, // 是否生成低倍率/高倍率策略组（本 fork 默认关闭）',
      },
    ],
  },

  // 锚点仍绑「代理IPV6优先」（上游长期稳定的一行），因此 VG 开关落在
  // 「代理IPV6优先 → VG → 链式代理」之间，与早期的「链式代理 → VG」顺序不同。
  // 这里刻意不锚 `链式代理:` 那一行：上游 2026-11 恢复链式代理时，同一行的注释文本
  // 就与本地版本不一致（”链式中转” vs “链式中转”），锚它会平白多一处失效点。
  // 选项对象的字段顺序对 mihomo 无影响，仅影响阅读顺序。
  {
    id: 'vg-switch',
    title: 'VG 家宽 / CF前置 开关',
    only: 'full',
    patches: [
      {
        id: 'vg-switch',
        why: '本 fork 独有的 VG 三类策略组总开关',
        marker: /^\s*VG: true,/m,
        op: 'insertAfter',
        anchor: '  代理IPV6优先: false, // 是否将订阅节点统一为 IPv6 优先（与“代理IPV4优先”同时开启时不生效）',
        text: '\n  // 以下为 VG 家宽策略配置\n  VG: true, // 是否启用 VG家宽 / ⚡CF前置 / 🏠家宽自动 策略组',
      },
    ],
  },

  {
    id: 'prefix-direct-comment',
    title: '规则集下载域名直连的说明注释',
    only: 'full',
    patches: [
      {
        id: 'prefix-comment',
        why: '说明这些域名为何必须直连，防止后人误删',
        marker: /这些域名必须直连/,
        op: 'insertBefore',
        anchor: "  'DOMAIN,cdn.jsdmirror.com,直连',",
        text: '  // 这些域名必须直连，否则规则集拉取会走代理形成循环依赖（节点不可用时全部拉取失败）',
      },
    ],
  },

  {
    id: 'prefix-direct-hosts',
    title: '规则集下载域名前置直连',
    patches: [
      {
        id: 'prefix-domains',
        why: '本 fork 的规则集源走 gh-proxy / 自建 CDN，域名漏加会形成循环依赖',
        marker: /'DOMAIN,v6\.gh-proxy\.org,直连'/,
        op: 'insertAfter',
        anchor: "  'DOMAIN,cdn.jsdmirror.com,直连',",
        text: [
          "  'DOMAIN,v6.gh-proxy.org,直连',",
          "  'DOMAIN,gh-proxy.org,直连',",
          "  'DOMAIN,static-file-global.353355.xyz,直连',",
        ].join('\n'),
      },
    ],
  },

  {
    id: 'custom-ruleset',
    title: 'ruleset-builder 自定义规则集（始终生效）',
    patches: [
      {
        id: 'custom-ruleset-rules',
        why: '自定义规则集对应的分流规则，必须与 provider 同时存在',
        marker: /'RULE-SET,custom_proxy,默认代理'/,
        // 锚点取「私有网络直连」这组的开头（空行 + 注释 + 首条规则），全部是上游原文。
        // 曾经锚 `'DOMAIN,static-file-global.353355.xyz,直连',`——那是 prefix-domains 注入的产物，
        // 等于把本补丁的存活押在另一个补丁上。改成 insertBefore 后插入位置不变，但不再有跨补丁依赖。
        op: 'insertBefore',
        anchor: ['', '  // 私有网络直连', "  'RULE-SET,private,直连',"],
        text: [
          '',
          '  // 自定义规则集（ruleset-builder 产物，独立维护，始终生效）',
          "  'RULE-SET,custom_proxy,默认代理',",
          "  'RULE-SET,custom_direct,直连',",
          "  'RULE-SET,custom_direct_ip,直连,no-resolve',",
        ].join('\n'),
      },
    ],
  },

  // 链式代理的开关（`链式代理: false,`）、常数（`dialerProxyName`）、策略组构造与
  // `dialer-proxy` 处理自 2026-11-03 起全部由上游原生提供（上游 e0eb0da 恢复了
  // cf3d3f6 删掉的链式代理），因此这里不再注入任何链式补丁。本 fork 曾有的
  // `chain-customize`（只补不覆盖 + 关闭时清悬空引用）已按「优先复用上游」删除。

  {
    id: 'vg-regex',
    title: 'VG 家宽 / 优选节点识别正则',
    only: 'full',
    patches: [
      {
        id: 'vg-regex',
        why: 'VG 家宽按「🏠 XX-家宽-NN」固定格式识别，优选按关键词识别',
        marker: /const vgRegex = /,
        op: 'insertBefore',
        anchor: '// 定义基础策略组',
        text: [
          '// VG 家宽节点正则（匹配国旗前缀可选：🇭🇰 🏠 HK-家宽-01 或 🏠 HK-家宽-01）',
          'const vgRegex = /^(?:[\\u{1F1E6}-\\u{1F1FF}]{2}\\s)?🏠 [A-Z]{2}-家宽-\\d{2}$/u;',
          '',
          '// 自动选择/负载均衡需要排除的节点关键词（VG 家宽格式由 vgRegex 独立判断）',
          'const autoExcludeRegex = /优选/;',
          '',
        ].join('\n'),
      },
    ],
  },

  {
    id: 'auto-select-first',
    title: '地区组内「自动选择」排首位（仅全量版）',
    only: 'full',
    patches: [
      {
        id: 'auto-select-first',
        why: '上游把自动选择排在末位，本 fork 全量版排首位便于默认命中（精简版保持上游顺序）',
        marker: /proxies: \[urlTestName, \.\.\.proxies\]/,
        op: 'replace',
        anchor: '        proxies: [...proxies, urlTestName],',
        text: '        proxies: [urlTestName, ...proxies], // 自动选择排在第一位',
      },
    ],
  },

  {
    id: 'lite-github-group',
    title: '精简版补齐 GitHub 分流组',
    only: 'lite',
    patches: [
      {
        id: 'lite-github-switch',
        why: '上游只在全量版加了 GitHub 开关，精简版需补齐才能生成对应分流组',
        marker: /^\s*GitHub: true,/m,
        op: 'insertAfter',
        anchor: '  Google: true, // Google服务',
        text: '  GitHub: true, // GitHub代码托管平台',
      },
      {
        id: 'lite-github-service',
        why: 'GitHub 分流组定义（provider + 规则）；锚点取 Telegram 组开头，避开上游调整 AI 组 rules 时失效',
        marker: /name: 'GitHub',/,
        op: 'insertBefore',
        anchor: ['  {', "    name: 'Telegram',"],
        text: [
          '  {',
          "    name: 'GitHub',",
          '    baseOption: selectBaseOption,',
          '    providers: {',
          '      github: {',
          '        ...ruleProviderCommonDomain,',
          '        url: `${ruleSetBaseUrl}geosite/github.mrs`,',
          "        path: './ruleset/github.mrs',",
          "        'path-in-bundle': 'geo/geosite/github.mrs',",
          '      },',
          '    },',
          '    icon: `${iconBaseUrl}GitHub.svg`,',
          "    rules: ['RULE-SET,github,GitHub'],",
          '  },',
        ].join('\n'),
      },
    ],
  },

  {
    id: 'vg-region-filter',
    title: 'VG 开启时家宽/优选节点不进地区组',
    only: 'full',
    patches: [
      {
        id: 'vg-region-filter',
        why: '这些节点由 VG家宽 / ⚡CF前置 承载，且必须有 VG 门控，否则关闭 VG 会凭空消失',
        marker: /ruleOptionsEnable\.VG && \(autoExcludeRegex\.test\(proxy\.name\)/,
        op: 'insertBefore',
        anchor: '    const matchedRegions = getMatchedRegions(proxy.name);',
        text: [
          '    // 仅启用 VG 时才排除家宽/优选节点，避免关闭 VG 后这些节点凭空消失',
          '    if (ruleOptionsEnable.VG && (autoExcludeRegex.test(proxy.name) || vgRegex.test(proxy.name))) continue;',
          '',
        ].join('\n'),
      },
    ],
  },

  {
    id: 'custom-providers',
    title: '自定义规则集 provider 注册',
    patches: [
      {
        id: 'custom-providers',
        why: 'ruleset-builder 四份规则集的 provider 定义（与前置规则成对存在）',
        marker: /custom_proxy: \{/,
        op: 'replace',
        anchor: "  newConfig['rule-providers'] = finalRuleProviders;",
        text: [
          "  newConfig['rule-providers'] = {",
          '    ...finalRuleProviders,',
          '    // 自定义规则集（ruleset-builder 产物，独立维护，始终生效）',
          '    custom_proxy: {',
          '      ...ruleProviderCommonDomain,',
          "      url: 'https://v6.gh-proxy.org/https://github.com/xinming7/ruleset-builder/raw/refs/heads/rules/mihomo/custom_proxy.mrs',",
          "      path: './ruleset/custom_proxy.mrs',",
          '    },',
          '    custom_direct: {',
          '      ...ruleProviderCommonDomain,',
          "      url: 'https://v6.gh-proxy.org/https://github.com/xinming7/ruleset-builder/raw/refs/heads/rules/mihomo/custom_direct.mrs',",
          "      path: './ruleset/custom_direct.mrs',",
          '    },',
          '    custom_fakeip_filter: {',
          '      ...ruleProviderCommonDomain,',
          "      url: 'https://v6.gh-proxy.org/https://github.com/xinming7/ruleset-builder/raw/refs/heads/rules/mihomo/custom_fakeip_filter.mrs',",
          "      path: './ruleset/custom_fakeip_filter.mrs',",
          '    },',
          '    custom_direct_ip: {',
          '      ...ruleProviderCommonIpcidr,',
          "      url: 'https://v6.gh-proxy.org/https://github.com/xinming7/ruleset-builder/raw/refs/heads/rules/mihomo/custom_direct_ip.mrs',",
          "      path: './ruleset/custom_direct_ip.mrs',",
          '    },',
          '  };',
        ].join('\n'),
      },
      {
        id: 'custom-fakeip-filter',
        why: 'custom_fakeip_filter 是域名规则集，需注册进 fake-ip-filter 而非 rules',
        marker: /'rule-set:custom_fakeip_filter'/,
        only: 'full',
        // 锚 fake-ip-filter 里最闲的一行：`'rule-set:geolocation-cn',` 在上游历史上只被碰过 1 次
        // （2026-08-19 引入），而同数组的 `'rule-set:private',` 与 `'rule-set:fakeip_filter',` 各被改过 3 次
        // —— 后两者所在的这一段正是上游「补充/调整 DNS 过滤项」的施工区。
        // fake-ip-filter 是集合语义，插在 geolocation-cn 之前与插在 fakeip_filter 之后完全等价。
        op: 'insertBefore',
        anchor: "      'rule-set:geolocation-cn',",
        text: "      'rule-set:custom_fakeip_filter',",
      },
      {
        id: 'custom-fakeip-filter-lite',
        why: '精简版此处是单行数组，注册新规则集需展开为多行写法',
        marker: /'rule-set:custom_fakeip_filter'/,
        only: 'lite',
        op: 'replace',
        anchor:
          "    'fake-ip-filter': ['rule-set:private', 'rule-set:fakeip_filter', 'rule-set:geolocation-cn', ...proxyFakeIpFilter],",
        text: [
          "    'fake-ip-filter': [",
          "      'rule-set:private',",
          "      'rule-set:fakeip_filter',",
          "      'rule-set:custom_fakeip_filter',",
          "      'rule-set:geolocation-cn',",
          '      ...proxyFakeIpFilter,',
          '    ],',
        ].join('\n'),
      },
    ],
  },

  {
    id: 'vg-groups',
    title: 'VG家宽 / ⚡CF前置 / 🏠家宽自动 三类策略组',
    only: 'full',
    patches: [
      {
        id: 'vg-groups-build',
        why: 'VG 三组的构造与默认代理装配',
        marker: /const vgCfGroups = \[\];/,
        op: 'replace',
        anchor: [
          '  functionalGroups.push({',
          '    ...selectBaseOption,',
          "    name: '默认代理',",
          '    proxies: [...groupNamesOfSelect, ...baseGroupNames, ...customGroupNames],',
          '    icon: `${iconBaseUrl}Proxy.svg`,',
          '  });',
        ],
        text: [
          '  // --- VG / CF 前置策略组 ---',
          '  const vgCfGroups = [];',
          '  const vgCfGroupNames = [];',
          '  if (ruleOptionsEnable.VG) {',
          '    const allProxiesWithVg = allProxiesNames.filter((name) => vgRegex.test(name));',
          '    const cfProxies = allProxiesNames.filter((name) => autoExcludeRegex.test(name));',
          '',
          '    if (cfProxies.length > 0) {',
          '      vgCfGroups.push({',
          '        ...groupBaseOption,',
          "        type: 'url-test',",
          '        tolerance: 50,',
          "        'exclude-type': 'DIRECT',",
          "        name: '⚡ CF前置',",
          '        proxies: cfProxies,',
          "        icon: 'https://v6.gh-proxy.org/https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/cloudflare-color.png',",
          '        hidden: false,',
          '      });',
          "      vgCfGroupNames.push('⚡ CF前置');",
          '    }',
          '    if (allProxiesWithVg.length > 0) {',
          '      const homeAuto = {',
          '        ...groupBaseOption,',
          "        type: 'url-test',",
          '        tolerance: 50,',
          "        'exclude-type': 'DIRECT',",
          "        name: '🏠 家宽自动',",
          '        proxies: allProxiesWithVg,',
          '        icon: `${iconBaseUrl}Auto.svg`,',
          '        hidden: false,',
          '      };',
          '      vgCfGroups.push({',
          '        ...selectBaseOption,',
          "        name: 'VG家宽',",
          '        proxies: [homeAuto.name, ...allProxiesWithVg],',
          "        icon: 'https://v6.gh-proxy.org/https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Clubhouse_1.png',",
          '      });',
          '      vgCfGroups.push(homeAuto);',
          "      vgCfGroupNames.push('VG家宽');",
          '    }',
          '  }',
          '',
          '  functionalGroups.push({',
          '    ...selectBaseOption,',
          "    name: '默认代理',",
          '    proxies: [...vgCfGroupNames, ...groupNamesOfSelect, ...baseGroupNames, ...customGroupNames],',
          '    icon: `${iconBaseUrl}Proxy.svg`,',
          '  });',
        ].join('\n'),
      },
      {
        id: 'vg-service-allnodes',
        why: '「分流组添加所有节点」开启时，自动选择类组也要排除家宽/优选节点',
        marker: /groupProxies = ruleOptionsEnable\.VG/,
        op: 'replace',
        anchor: '      groupProxies = [...allProxiesNames];',
        text: [
          '      groupProxies = ruleOptionsEnable.VG',
          '        ? allProxiesNames.filter((name) => !autoExcludeRegex.test(name) && !vgRegex.test(name))',
          '        : [...allProxiesNames];',
        ].join('\n'),
      },
      {
        id: 'vg-service-inject',
        why: '分流策略组注入 VG 组名，并给 includeAll 组加空组兜底',
        marker: /\? \[\n\s*'默认代理',\n\s*\.\.\.vgCfGroupNames,/,
        op: 'replace',
        anchor: [
          '      groupProxies = !addAllNodesToServiceGroupsEnabled',
          "        ? ['默认代理', ...customGroupNames, ...baseGroupNames, ...groupNamesOfSelect, ...(svc.direct ? ['直连'] : [])]",
          '        : [',
          "            '默认代理',",
          '            ...customGroupNames,',
          '            ...baseGroupNames,',
          '            ...groupNamesOfSelect,',
          '            ...allProxiesNames,',
          "            ...(svc.direct ? ['直连'] : []),",
          '          ];',
          '    }',
        ],
        text: [
          '      groupProxies = !addAllNodesToServiceGroupsEnabled',
          '        ? [',
          "            '默认代理',",
          '            ...vgCfGroupNames,',
          '            ...customGroupNames,',
          '            ...baseGroupNames,',
          '            ...groupNamesOfSelect,',
          "            ...(svc.direct ? ['直连'] : []),",
          '          ]',
          '        : [',
          "            '默认代理',",
          '            ...vgCfGroupNames,',
          '            ...customGroupNames,',
          '            ...baseGroupNames,',
          '            ...groupNamesOfSelect,',
          '            ...allProxiesNames,',
          "            ...(svc.direct ? ['直连'] : []),",
          '          ];',
          '    }',
          '',
          '    // includeAll 组不能为空：VG 开启时若订阅全是家宽/优选节点，过滤后会是空数组，',
          '    // 而 mihomo 校验阶段要求 select/url-test/load-balance 组必须有 proxies 或 use',
          '    if (svc.includeAll && groupProxies.length === 0) groupProxies = [...allProxiesNames];',
        ].join('\n'),
      },
      {
        id: 'vg-leak-group',
        why: '漏网之鱼组注入 VG 组名',
        marker: /'默认代理', \.\.\.vgCfGroupNames, '直连'/,
        op: 'replace',
        anchor: "    proxies: ['默认代理', '直连', ...groupNamesOfSelect],",
        text: "    proxies: ['默认代理', ...vgCfGroupNames, '直连', ...groupNamesOfSelect],",
      },
      // --- 以下是「把 VG 组接到上游既有的链式代理骨架上」的四处载荷 ---
      // 2026-11-03 之前，这四处是寄居在 chain-groups / chain-main 两个特性里的：那些补丁的
      // marker 形如 `finalRuleProviders,\n chainGroup,\n directGroup,`，靠同时命中上游的链式代码
      // 来判定「已注入」。上游恢复链式代理后，原生代码把这些 marker 全部抢先命中，补丁被判「已存在」
      // 而跳过，VG 组随之整块消失（verify 与 replay 都是绿的，因为清单本身也一起失效了）。
      // 现在把 VG 载荷与链式代理彻底解耦：每条补丁的 marker 只认 VG 自己的产物。
      {
        id: 'vg-return',
        why: '全量版返回值带上 VG 组（极简模式提前 return，由 main() 的解构默认值兜底）',
        only: 'full',
        // marker 只认「单独一行的 vgCfGroups,」，与 `...vgCfGroups,`、`vgCfGroups = [],` 区分开
        marker: /^\s*vgCfGroups,$/m,
        op: 'replace',
        // 整段取值字段 + 结尾 `};`：`};` 把 full 的 return 与 main() 的解构区分开，
        // `functionalGroups,` 把 full 的 return 与极简模式的 return 区分开。
        // 上游若在返回值中间插字段，这里会响亮失败——按提示补一行即可。
        anchor: [
          'functionalGroups,',
          'functionalRules,',
          'functionalIpRules,',
          'finalRuleProviders,',
          'chainGroup,',
          'directGroup,',
          '};',
        ],
        text: [
          '    functionalGroups,',
          '    functionalRules,',
          '    functionalIpRules,',
          '    finalRuleProviders,',
          '    chainGroup,',
          '    directGroup,',
          '    vgCfGroups,',
          '  };',
        ].join('\n'),
      },
      {
        id: 'vg-global',
        why: '全量版 GLOBAL 组也要能选到 VG 组',
        only: 'full',
        // 必须带上 `...functionalGroups.map(...)` 这一行：分流组里的 `...vgCfGroupNames,` 后面
        // 也紧跟 `...customGroupNames,`，只写后两行会把分流组误判成 GLOBAL。
        marker: /\.\.\.functionalGroups\.map\(\(g\) => g\.name\),\n\s*\.\.\.vgCfGroupNames,/,
        op: 'insertAfter',
        anchor: '      ...functionalGroups.map((g) => g.name),',
        text: '      ...vgCfGroupNames,',
      },
      {
        id: 'vg-destructure',
        why: '解构时给 vgCfGroups 空数组默认值，极简模式不必再在返回值里伪造该字段',
        only: 'full',
        marker: /vgCfGroups = \[\],/,
        op: 'replace',
        anchor: [
          'chainGroup,',
          'directGroup,',
          '} = buildFunctionalGroups(filteredProxies, generatedRegionGroups, { customProxyNames, customGroup });',
        ],
        text: [
          '    chainGroup,',
          '    directGroup,',
          '    vgCfGroups = [],',
          '  } = buildFunctionalGroups(filteredProxies, generatedRegionGroups, { customProxyNames, customGroup });',
        ].join('\n'),
      },
      {
        id: 'vg-main-groups',
        why: '把 VG 组插入最终 proxy-groups（位于直连组之后、地区组之前）',
        only: 'full',
        marker: /^\s*\.\.\.vgCfGroups,$/m,
        op: 'insertAfter',
        // 锚点尾部必须是 directGroup,（insertAfter 插在锚点最后一行的后面）：
        // 若把 `...generatedRegionGroups,` 也写进锚点，VG 组会跑到地区组之后，与历史产物顺序不符。
        anchor: ['...(chainGroup ? [chainGroup] : []),', 'directGroup,'],
        text: '    ...vgCfGroups,',
      },
    ],
  },
];

module.exports = { FEATURES };
