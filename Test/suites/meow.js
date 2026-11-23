'use strict';

const { withOptions } = require('../lib/options');

/**
 * meow 版脚本的方言断言。
 *
 * 这些用例锁的是「meow 能吃什么」，不是「mihomo 该是什么」：每条都对应一次实测到的
 * 内核行为（见 Docs/MeowRS适配方案.md 的实证表），所以改这里之前先跑一遍真内核确认。
 *
 * 与 suites/fork.js 分开的理由：fork.js 跑的是 mihomo 两版脚本（含上游语义），
 * 本文件只跑 meow 生成物；混在一起会让 `isFull` 之类的分支判断失控。
 */
function runMeowTests(h, api, ctx = {}) {
  const { fx, scriptFile } = ctx;

  const tags = (list) => (list || []).map((d) => String(d));
  const hasTag = (list) => tags(list).some((d) => /[#?]/.test(d));

  h.section('meow 版 · DNS 方言');

  const build = (extra) =>
    withOptions(api, { VG: true }, () => api.main({ ...fx.typicalSubscription(), ...(extra || {}) }));

  const base = build();

  h.test('default-nameserver 不带任何代理标签（否则内核拒绝加载）', () => {
    h.assert(!hasTag(base.dns['default-nameserver']), `实际：${JSON.stringify(base.dns['default-nameserver'])}`);
  });

  h.test('proxy-server-nameserver 不带任何代理标签', () => {
    h.assert(
      !hasTag(base.dns['proxy-server-nameserver']),
      `实际：${JSON.stringify(base.dns['proxy-server-nameserver'])}`,
    );
  });

  h.test('加密 nameserver 的出口标签用 ?proxy=，不用 #（# 会被当 SNI）', () => {
    for (const ns of tags(base.dns.nameserver)) {
      if (!/^https?:\/\//.test(ns)) continue;
      h.assert(!ns.includes('#'), `仍在使用 #：${ns}`);
    }
  });

  h.test('nameserver-policy 不使用 system（meow 启动即死）', () => {
    for (const [key, value] of Object.entries(base.dns['nameserver-policy'] || {})) {
      const list = Array.isArray(value) ? value : [value];
      h.assert(!list.some((v) => String(v).trim() === 'system'), `nameserver-policy['${key}'] 仍是 system`);
    }
  });

  h.section('meow 版 · 顶层与策略组方言');

  h.test('负载均衡策略是内核支持的两种之一', () => {
    const lb = (base['proxy-groups'] || []).filter((g) => g.type === 'load-balance');
    h.assert(lb.length > 0, '夹具应生成负载均衡组');
    for (const g of lb) {
      h.assert(['round-robin', 'consistent-hashing'].includes(g.strategy), `${g.name} 的策略是 ${g.strategy}`);
    }
  });

  h.test('TUN 不含 meow 不支持的字段', () => {
    for (const key of ['stack', 'auto-redirect', 'strict-route', 'auto-detect-interface']) {
      h.assert(!(key in base.tun), `tun.${key} 仍存在`);
    }
    h.assert(base.tun.enable === true, 'tun.enable 应保留');
  });

  h.test('keep-alive-interval 已改名为 tcp-keepalive-interval', () => {
    h.assert(!('keep-alive-interval' in base), '旧键仍存在');
    h.assert('tcp-keepalive-interval' in base, '新键缺失');
  });

  h.test('逻辑规则不再内嵌 RULE-SET（QUIC 屏蔽规则已删除）', () => {
    const nested = (base.rules || []).filter((r) => /^(AND|OR|NOT),/.test(r) && r.includes('RULE-SET,'));
    h.assert(nested.length === 0, `仍有 ${nested.length} 条`);
  });

  h.section('meow 版 · 节点过滤与引用完整性');

  // 夹具追加 meow 不支持的协议类型：openvpn（实测整类不支持）
  const withUnsupported = build({
    proxies: [
      ...fx.typicalSubscription().proxies,
      { name: '🏠 HK-家宽-01', type: 'openvpn', server: 'o.example.com', port: 1194 },
      { name: '🇯🇵 日本 家宽 02', type: 'openvpn', server: 'o2.example.com', port: 1194 },
    ],
  });

  h.test('openvpn 节点在脚本侧被剔除', () => {
    const left = (withUnsupported.proxies || []).filter((p) => String(p.type).toLowerCase() === 'openvpn');
    h.assert(left.length === 0, `仍有 ${left.length} 个 openvpn 节点`);
  });

  h.test('剔除后不产生空策略组', () => {
    const empty = (withUnsupported['proxy-groups'] || []).filter((g) => (g.proxies || []).length === 0);
    h.assert(empty.length === 0, `空组：${empty.map((g) => g.name).join(', ')}`);
  });

  h.test('所有策略组与规则的引用都指向存在的对象', () => {
    const groups = withUnsupported['proxy-groups'] || [];
    const known = new Set([
      ...groups.map((g) => g.name),
      ...(withUnsupported.proxies || []).map((p) => p.name),
      'DIRECT',
      'REJECT',
      'REJECT-DROP',
      'PASS',
      'GLOBAL',
      'COMPATIBLE',
    ]);
    for (const g of groups) {
      for (const m of g.proxies || []) h.assert(known.has(m), `组 ${g.name} 引用了不存在的 ${m}`);
    }
    for (const r of withUnsupported.rules || []) {
      const core = String(r)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== 'no-resolve' && s !== 'src');
      const target = core[0] === 'MATCH' ? core[1] : /^(AND|OR|NOT)$/.test(core[0]) ? core[core.length - 1] : core[2];
      h.assert(known.has(target), `规则指向不存在的策略 ${target}：${r}`);
    }
  });

  // hysteria2 + ech-opts：meow 会整条丢弃，脚本侧删字段保住节点
  const withEch = build({
    proxies: [
      ...fx.typicalSubscription().proxies,
      {
        name: '🇯🇵 日本-HY2-01',
        type: 'hysteria2',
        server: 'h.example.com',
        port: 443,
        password: 'x',
        up: '30 Mbps',
        down: '100 Mbps',
        'ech-opts': { enable: true, 'query-server-name': 'cloudflare-ech.com' },
      },
    ],
  });

  h.test('hysteria2 的 ech-opts 被删除，节点本身保留', () => {
    const hy = (withEch.proxies || []).find((p) => p.name === '🇯🇵 日本-HY2-01');
    h.assert(hy, '节点不应被丢弃');
    h.assert(!('ech-opts' in hy), 'ech-opts 仍存在');
  });

  // ws + max-early-data：meow 会把它当子协议校验，服务器不回就整条连接失败
  const withWsEarly = build({
    proxies: [
      ...fx.typicalSubscription().proxies,
      {
        name: '🇯🇵 日本-WS-01',
        type: 'vless',
        server: 'w.example.com',
        port: 443,
        uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
        tls: true,
        network: 'ws',
        'ws-opts': {
          path: '/',
          headers: { Host: 'w.example.com' },
          'early-data-header-name': 'Sec-WebSocket-Protocol',
          'max-early-data': 2048,
        },
      },
      {
        name: '🇯🇵 日本-WS-02',
        type: 'vless',
        server: 'w2.example.com',
        port: 443,
        uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
        tls: true,
        network: 'ws',
        'ws-opts': { path: '/', headers: { Host: 'w2.example.com' } },
      },
    ],
  });

  h.test('ws 节点的 max-early-data 被置 0，header 名保留', () => {
    const ws = (withWsEarly.proxies || []).find((p) => p.name === '🇯🇵 日本-WS-01');
    h.assert(ws, '节点不应被丢弃');
    h.assertEqual(ws['ws-opts']['max-early-data'], 0, 'max-early-data 未归零');
    h.assertEqual(ws['ws-opts']['early-data-header-name'], 'Sec-WebSocket-Protocol', 'header 名应保留，便于回退');
  });

  h.test('未声明 max-early-data 的 ws 节点不会被塞进该字段', () => {
    const ws = (withWsEarly.proxies || []).find((p) => p.name === '🇯🇵 日本-WS-02');
    h.assert(ws, '节点不应被丢弃');
    h.assert(!('max-early-data' in ws['ws-opts']), '不应凭空添加 max-early-data');
  });

  h.test('追加不支持的节点不会改变产物节点数（说明它们在脚本侧被剔除而非下发给内核）', () => {
    h.assertEqual(
      (withUnsupported.proxies || []).length,
      (base.proxies || []).length,
      '追加 2 个 openvpn 后节点数应保持不变',
    );
    h.assert(scriptFile && scriptFile.includes('meow'), '本用例只对 meow 版有意义');
  });
}

module.exports = { runMeowTests };
