'use strict';

const { withOptions } = require('../lib/options');

/**
 * 本 fork 独有的断言。
 *
 * 为什么单独成文件：`suites/unit.js` 与 `suites/integration.js` 是上游的施工区，
 * 上游会持续「清理无意义与冗余测试用例」（2026-11-05 那次就删了 119 行）。
 * fork 的用例混在里面，每次同步都要人工解冲突——2026-11-05 的自动同步失败正是
 * 因为 `Test/README.md`、`Test/lib/scripts.js`、`Test/suites/unit.js` 三处冲突
 * 落在「非注入目标」上，触发了 L1 的人工分支。
 *
 * 把 fork 用例放进上游不存在的文件里，冲突面就归零：上游怎么改自己的 suite
 * 都不会碰到这里。代价是这个文件要自己复制少量 helper（groupByName、vgHomeSubscription 等）。
 *
 * 2026-11-06 完成收口：`integration.js` 里最后 9 条 fork 用例已全部迁到这里，
 * 该文件现在与上游逐字节相同——上游再动它也不会产生合并冲突。
 *
 * 这里锁的都是「上游行为」而不是「fork 行为」——上游一旦改变语义，应先让用例变红，
 * 再由人决定是跟还是保留差异。
 */
function runForkTests(h, api, ctx = {}) {
  const { fx, loadScript, scriptFile } = ctx;
  const isFull = /mihomoScript\.js$/.test(scriptFile || '');

  // 上游 integration.js 里的同名 helper，这里复制一份，避免依赖上游实现（它随时会重构）
  const groupByName = (groups, name) => (groups || []).find((g) => g.name === name);
  const proxyNames = (proxies) => proxies.map((p) => p.name);

  const mkCustomProxy = (name) => ({
    name,
    type: 'ss',
    server: 'x.example.com',
    port: 443,
    cipher: 'aes-256-gcm',
    password: 'x',
  });

  // 注入自定义节点（首个节点自带 dialer-proxy，用于验证覆盖行为；与订阅节点「香港 01 | 中转」标准化后重名）
  const chainCustomInjection = `const customizeProxies = [
    { name: '香港 01 | 中转', type: 'ss', server: 'custom1.example.com', port: 443, cipher: 'aes-256-gcm', password: 'x', 'dialer-proxy': '旧中转' },
    { name: '自建独享', type: 'vmess', server: 'custom2.example.com', port: 443, uuid: 'x', alterId: 0 },
    { name: '自建-日本-01', type: 'trojan', server: 'custom3.example.com', port: 443, password: 'x' },
  ];`;

  // 「🏠 XX-家宽-NN」是 VG 家宽的固定格式；第二条是上游家宽组的关键词语义，两者必须不互相污染
  const vgHomeSubscription = () => ({
    proxies: [
      { name: '🏠 HK-家宽-01', type: 'ss', server: 'g.example.com', port: 443, cipher: 'aes-256-gcm', password: 'x' },
      { name: '🇯🇵 日本 住宅 IP', type: 'ss', server: 'h.example.com', port: 443, cipher: 'aes-256-gcm', password: 'x' },
    ],
  });

  h.section('fork 校验 · 节点名零宽字符');

  const matched = (name) => api.getMatchedRegions(name).map((r) => r.name);

  h.test('逐字符插入零宽空格的节点名仍能匹配地区', () => {
    h.assert(matched('台\u200B湾 02').includes('台湾'), '台\u200B湾 应识别为台湾');
    h.assert(matched('香\u200B港 03').includes('香港'), '香\u200B港 应识别为香港');
  });

  // ---------------- GitHub 分流组：全量版跟随上游，精简版没有 ----------------
  h.section('fork 校验 · GitHub 分流组（全量版跟随上游，精简版无）');

  h.test('GitHub 开关关闭 → 不生成 GitHub 组、不注册 provider、不留悬空规则', () =>
    withOptions(api, { GitHub: false }, () => {
      const out = api.main(fx.typicalSubscription());
      h.assert(!groupByName(out['proxy-groups'], 'GitHub'), '不应生成 GitHub 组');
      h.assert(!out['rule-providers'].github, '不应注册 github provider');
      h.assert(!out.rules.some((rule) => rule.includes(',github,')), '不应残留 github 规则');
      // 精简版没有 Microsoft 组，只对全量版校验
      if (isFull) {
        h.assert(groupByName(out['proxy-groups'], 'Microsoft'), 'Microsoft 组应仍然存在');
      }
    }),
  );

  h.test('GitHub 开关开启 → 全量版生成 GitHub 组与对应 provider/规则', () => {
    const out = api.main(fx.typicalSubscription());
    if (!isFull) {
      // 2026-11-05 起精简版完全跟随上游：上游精简版本来就没有 GitHub 分流组，本 fork 不再补齐。
      // 想要 GitHub 分流请用全量版 Script/mihomoScript.js。
      h.assert(!groupByName(out['proxy-groups'], 'GitHub'), '精简版不应生成 GitHub 组');
      h.assert(!out['rule-providers'].github, '精简版不应注册 github provider');
      h.assert(!out.rules.includes('RULE-SET,github,GitHub'), '精简版不应有指向 GitHub 的规则');
      return;
    }
    h.assert(groupByName(out['proxy-groups'], 'GitHub'), '应生成 GitHub 组');
    h.assert(out['rule-providers'].github, '应注册 github provider');
    h.assert(out.rules.includes('RULE-SET,github,GitHub'), '应生成指向 GitHub 组的规则');
  });

  // ---------------- 自定义规则集：不受任何开关控制 ----------------
  h.section('fork 校验 · ruleset-builder 自定义规则集');

  h.test('自定义规则集：始终注册 provider 且规则成对，不依赖任何开关', () =>
    withOptions(api, { 极简国内外分流模式: false, VG: true }, () => {
      const out = api.main(fx.typicalSubscription());
      for (const name of ['custom_proxy', 'custom_direct', 'custom_direct_ip', 'custom_fakeip_filter']) {
        h.assert(out['rule-providers'][name], `应注册 ${name} provider`);
      }
      h.assert(out.rules.includes('RULE-SET,custom_proxy,默认代理'), 'custom_proxy 规则应存在');
      h.assert(out.rules.includes('RULE-SET,custom_direct,直连'), 'custom_direct 规则应存在');
      h.assert(out.rules.includes('RULE-SET,custom_direct_ip,直连,no-resolve'), 'custom_direct_ip 规则应存在');
      h.assert(
        out.dns['fake-ip-filter'].includes('rule-set:custom_fakeip_filter'),
        'custom_fakeip_filter 应注册进 fake-ip-filter',
      );
      // 规则集源域名必须走直连，否则拉取时会走代理形成循环依赖。
      // 只断言本 fork 自有的 gh-proxy 源：上游的 CDN 直连条目已于 2026-11-06 随 CDN 切换删除，
      // 且上游明确表示不再为 CDN 域名补直连规则。
      for (const host of ['v6.gh-proxy.org', 'gh-proxy.org', 'static-file-global.353355.xyz']) {
        h.assert(out.rules.includes(`DOMAIN,${host},直连`), `${host} 应在前置规则中直连`);
      }
    }),
  );

  // ---------------- VG 家宽：与上游「家宽节点组」是两套语义 ----------------
  h.section('fork 校验 · VG 家宽（仅全量版）');

  h.test('VG 开启：VG 格式家宽节点归 VG家宽，不重复进家宽节点/地区组', () => {
    if (!isFull) return; // 精简版无 VG 功能
    withOptions(api, { VG: true }, () => {
      const out = api.main(vgHomeSubscription());
      const vgGroup = groupByName(out['proxy-groups'], 'VG家宽');
      const homeGroup = groupByName(out['proxy-groups'], '家宽节点');
      h.assert(vgGroup, '应生成 VG家宽组');
      h.assert(
        vgGroup.proxies.some((n) => n.includes('HK-家宽-01')),
        'VG 格式家宽节点应入 VG家宽组',
      );
      h.assert(!homeGroup.proxies.some((n) => n.includes('HK-家宽-01')), 'VG 格式家宽节点不应重复进上游家宽节点组');
      h.assert(homeGroup.proxies.includes('🇯🇵 日本 住宅 IP'), '上游语义的家宽节点仍应入家宽节点组');
      // 直接列出该节点的组只应是 VG 相关组（GLOBAL/分流组引用的是组名，不会命中节点名）
      const hosts = out['proxy-groups']
        .filter((g) => (g.proxies || []).some((n) => n.includes('HK-家宽-01')))
        .map((g) => g.name)
        .sort();
      h.assertDeep(hosts, ['VG家宽', '🏠 家宽自动']);
    });
  });

  h.test('VG 关闭：VG 格式家宽节点不丢失，回落进家宽节点与地区组', () =>
    withOptions(api, { VG: false }, () => {
      const out = api.main(vgHomeSubscription());
      const names = proxyNames(out.proxies);
      h.assert(
        names.some((n) => n.includes('HK-家宽-01')),
        '关闭 VG 后节点本身不应消失',
      );
      h.assert(!groupByName(out['proxy-groups'], 'VG家宽'), '关闭 VG 后不应生成 VG家宽组');
      h.assert(
        groupByName(out['proxy-groups'], '家宽节点').proxies.some((n) => n.includes('HK-家宽-01')),
        '关闭 VG 后应回落进上游家宽节点组',
      );
      h.assert(
        groupByName(out['proxy-groups'], '香港').proxies.some((n) => n.includes('HK-家宽-01')),
        '关闭 VG 后应回落进地区组',
      );
    }),
  );

  // ---------------- 特性正交性：VG × 链式代理 ----------------
  // 这两套功能都改 buildFunctionalGroups 的返回值与 main() 的装配，历史上曾互相吞噬：
  // 上游 2026-11-03 恢复链式代理后，VG 的四处载荷（返回值 / GLOBAL / 解构 / proxy-groups）
  // 曾被链式补丁的 marker 误判为「已注入」而整块跳过，而 verify 与 replay 依然全绿。
  h.section('fork 校验 · VG 与链式代理互不吞噬');

  h.test('VG 与链式代理同时开启：VG 组、链式中转、链式落地同时存在', () => {
    if (!isFull) return; // 精简版无 VG 功能
    const customApi = loadScript(scriptFile, (code) =>
      code.replace('const customizeProxies = [];', chainCustomInjection),
    );
    withOptions(customApi, { VG: true, 链式代理: true }, () => {
      const out = customApi.main(vgHomeSubscription());
      const global = groupByName(out['proxy-groups'], 'GLOBAL');
      const defaultGroup = groupByName(out['proxy-groups'], '默认代理');

      h.assert(groupByName(out['proxy-groups'], 'VG家宽'), 'VG 组不应因链式代理而消失');
      h.assert(groupByName(out['proxy-groups'], '🏠 家宽自动'), '家宽自动组不应因链式代理而消失');
      h.assert(groupByName(out['proxy-groups'], '链式中转'), '链式中转组应存在');
      h.assert(groupByName(out['proxy-groups'], '链式落地'), '链式落地组应存在');

      // GLOBAL 同时聚合 VG 组与链式两组
      for (const name of ['VG家宽', '链式中转', '链式落地']) {
        h.assert(global.proxies.includes(name), `GLOBAL 应含 ${name}`);
      }
      // 默认代理既含 VG 组也含链式落地（前者是 VG 载荷，后者是自定义节点入口）
      for (const name of ['VG家宽', '链式落地']) {
        h.assert(defaultGroup.proxies.includes(name), `默认代理应含 ${name}`);
      }

      // VG 组要真的落在 proxy-groups 列表里，而不是只在别处被引用
      const allNames = new Set(out['proxy-groups'].map((g) => g.name));
      for (const name of ['VG家宽', '🏠 家宽自动']) {
        h.assert(allNames.has(name), `${name} 应出现在 proxy-groups 中`);
      }

      // 链式中转仍只装订阅节点（含 VG 家宽节点），自定义节点靠 dialer-proxy 引用它
      const chain = groupByName(out['proxy-groups'], '链式中转');
      h.assert(
        chain.proxies.some((n) => n.includes('HK-家宽-01')),
        '链式中转应含订阅侧的 VG 节点',
      );
      h.assertEqual(
        out.proxies.find((x) => x.name === '自建独享')['dialer-proxy'],
        '链式中转',
        '自定义节点仍应接入链式中转',
      );
    });
  });

  h.test('极简国内外分流模式 + VG：不因缺少 vgCfGroups 字段而崩溃，且不生成 VG 组', () => {
    if (!isFull) return; // 精简版无 VG 功能
    withOptions(api, { 极简国内外分流模式: true, VG: true }, () => {
      // 极简国内外分流模式在 VG 组构造前就 return，main() 靠解构默认值兜底；漏了就是 TypeError
      const out = api.main(vgHomeSubscription());
      h.assert(groupByName(out['proxy-groups'], 'GLOBAL'), '极简国内外分流模式应生成 GLOBAL');
      h.assert(!groupByName(out['proxy-groups'], 'VG家宽'), '极简国内外分流模式不生成 VG 组');
      h.assert(!groupByName(out['proxy-groups'], '🏠 家宽自动'), '极简国内外分流模式不生成家宽自动组');
    });
  });

  // ---------------- 链式代理：锁定上游语义，防止静默变更 ----------------
  h.section('fork 校验 · 链式代理（锁定上游语义，防止静默变更）');

  h.test('启用：已有 dialer-proxy 会被覆盖为「链式中转」', () => {
    withOptions(api, { 链式代理: true }, () => {
      // 未指定 dialer-proxy 的节点自动接入链式中转
      const added = api.buildCustomizeGroups([], [mkCustomProxy('自建独享')]);
      h.assertEqual(added.customProxies[0]['dialer-proxy'], '链式中转', '未指定时应自动接入链式中转');

      // 上游用 `!== dialerProxyName` 判断后直接覆盖，用户手写的多级链路会被改写。
      // 本 fork 曾改成「只补未指定的」，2026-11-03 起改为跟随上游，这里锁住当前语义。
      const overwritten = api.buildCustomizeGroups([], [{ ...mkCustomProxy('自建独享'), 'dialer-proxy': '旧中转' }]);
      h.assertEqual(overwritten.customProxies[0]['dialer-proxy'], '链式中转', '已有值应被覆盖为链式中转');
    });
  });

  h.test('关闭：不清洗指向「链式中转」的悬空引用（上游行为，属已知限制）', () => {
    withOptions(api, { 链式代理: false }, () => {
      const r = api.buildCustomizeGroups(
        [],
        [
          { ...mkCustomProxy('自建独享'), 'dialer-proxy': '链式中转' },
          { ...mkCustomProxy('自建-二级'), 'dialer-proxy': '自建-落地' },
        ],
      );
      // 关闭时「链式中转」组不存在，这条引用是悬空的；上游不做清理，mihomo 加载会报
      // `dialer-proxy not found`。锁住上游行为：一旦上游补上清理逻辑，本用例会红，
      // 届时应改回「应被清除」并删掉 AGENTS.md 里的风险提示。
      h.assertEqual(r.customProxies[0]['dialer-proxy'], '链式中转', '上游不清洗悬空引用');
      h.assertEqual(r.customProxies[1]['dialer-proxy'], '自建-落地', '指向自建节点的引用原样保留');
    });
  });

  h.test('关闭链式代理（端到端）：手写 dialer-proxy 原样保留，不生成链式中转', () => {
    const danglingInjection = `const customizeProxies = [
      { name: '自建-手写中转', type: 'ss', server: 'c1.example.com', port: 443, cipher: 'aes-256-gcm', password: 'x', 'dialer-proxy': '链式中转' },
      { name: '自建-二级链路', type: 'ss', server: 'c2.example.com', port: 443, cipher: 'aes-256-gcm', password: 'x', 'dialer-proxy': '自建-落地' },
    ];`;
    const customApi = loadScript(scriptFile, (code) => code.replace('const customizeProxies = [];', danglingInjection));
    // 链式代理默认关闭
    const out = customApi.main(fx.typicalSubscription());

    h.assert(!groupByName(out['proxy-groups'], '链式中转'), '前置：关闭时不应生成链式中转组');

    // 上游不清理：手写的「链式中转」引用会保留，此时组不存在 → mihomo 加载会报
    // `dialer-proxy not found`。这是跟随上游后接受的已知限制（见 AGENTS.md），
    // 用例锁住它，避免上游哪天补了清理逻辑而这里无人察觉。
    h.assertEqual(
      out.proxies.find((x) => x.name.includes('手写中转'))['dialer-proxy'],
      '链式中转',
      '上游不清洗指向链式中转的引用',
    );
    // 指向其他自建节点的合法链式配置原样保留
    h.assertEqual(
      out.proxies.find((x) => x.name.includes('二级链路'))['dialer-proxy'],
      '自建-落地',
      '指向自建节点的 dialer-proxy 应保留',
    );
  });

  h.test('启用链式代理（端到端）：用户手写的多级链路会被覆盖为链式中转', () => {
    const mixedInjection = `const customizeProxies = [
      { name: '自建-落地', type: 'ss', server: 'c1.example.com', port: 443, cipher: 'aes-256-gcm', password: 'x' },
      { name: '自建-多级', type: 'ss', server: 'c2.example.com', port: 443, cipher: 'aes-256-gcm', password: 'x', 'dialer-proxy': '自建-落地' },
    ];`;
    const customApi = loadScript(scriptFile, (code) => code.replace('const customizeProxies = [];', mixedInjection));
    withOptions(customApi, { 链式代理: true }, () => {
      const out = customApi.main(fx.typicalSubscription());

      h.assertEqual(
        out.proxies.find((x) => x.name.includes('落地'))['dialer-proxy'],
        '链式中转',
        '未指定 dialer-proxy 的节点应自动接入链式中转',
      );
      h.assertEqual(
        out.proxies.find((x) => x.name.includes('多级'))['dialer-proxy'],
        '链式中转',
        '上游会把手写的多级链路一并覆盖为链式中转',
      );
    });
  });
}

module.exports = { runForkTests };
