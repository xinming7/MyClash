#!/usr/bin/env node
'use strict';

/**
 * meow 产物生成 + 方言断言
 *
 * 为什么不是又一个生成器：`Tools/gen-config.js` 已经能把「脚本 + 夹具」跑成一份配置 JSON，
 * 本工具只是它外面的一层包装 —— 生成之后立刻按 meow 的方言规则做静态断言。
 *
 * 断言存在的理由：meow 对多数不支持的写法是**静默降级**（规则指向不存在的组只告警、
 * 加密 DNS 的 # 被当 SNI），等用户发现时已经是分流错了。这里把「产物长什么样才算合格」
 * 固化成检查项，坏产物在 CI 就被拦住。
 *
 * 用法：
 *   node Tools/meow-emit.js Script/meowScript.js /tmp/meow.json '{"VG":true}'
 *   node Tools/meow-emit.js Script/meowScript.js /tmp/meow.json '{"VG":true}' '{"subscription":[...]}'
 *   node Tools/meow-emit.js Script/meowScript.js /tmp/meow.json --no-assert
 *
 * 产物是 JSON（JSON ⊂ YAML），meow / mihomo 都能直接解析，且不引入 YAML 依赖。
 */

const fs = require('fs');
const path = require('path');

const { main: genConfig } = require('./gen-config');

// meow 内建的策略名，规则可以直接指向它们
const BUILTIN_POLICIES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE']);

const UNSUPPORTED_PROXY_TYPES = new Set([
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
]);

/** 判断 nameserver 条目是否带代理标签（# 或 ?proxy=） */
const hasProxyTag = (entry) => /[#?]/.test(String(entry));

/**
 * 对产物做 meow 方言断言。
 * @returns {string[]} 问题列表，空数组表示通过
 */
function assertMeow(cfg) {
  const problems = [];
  const dns = cfg.dns || {};
  const groups = cfg['proxy-groups'] || [];
  const proxies = cfg.proxies || [];
  const rules = cfg.rules || [];

  // 1. default-nameserver 禁止任何代理标签（带标签 = 内核拒绝加载）
  for (const ns of dns['default-nameserver'] || []) {
    if (hasProxyTag(ns)) problems.push(`dns.default-nameserver 带代理标签：${ns}`);
  }

  // 2. proxy-server-nameserver 同样禁止
  for (const ns of dns['proxy-server-nameserver'] || []) {
    if (hasProxyTag(ns)) problems.push(`dns.proxy-server-nameserver 带代理标签：${ns}`);
  }

  // 3. 加密条目的 #X 会被当成 SNI，出口标签必须写 ?proxy=
  for (const ns of dns.nameserver || []) {
    const s = String(ns);
    if (/^https?:\/\//.test(s) && s.includes('#') && !s.includes('?proxy=')) {
      problems.push(`dns.nameserver 用 # 代替 ?proxy=（meow 会当 SNI）：${s}`);
    }
  }

  // 4. nameserver-policy 不能用 system（meow 启动即死）
  for (const [key, value] of Object.entries(dns['nameserver-policy'] || {})) {
    const list = Array.isArray(value) ? value : [value];
    if (list.some((v) => String(v).trim() === 'system')) {
      problems.push(`dns.nameserver-policy['${key}'] 使用了 system`);
    }
  }

  // 5. 负载均衡策略只认 round-robin / consistent-hashing
  for (const g of groups) {
    if (g.type !== 'load-balance' || !g.strategy) continue;
    if (!['round-robin', 'consistent-hashing'].includes(g.strategy)) {
      problems.push(`策略组 ${g.name} 的 strategy 不受支持：${g.strategy}`);
    }
  }

  // 6. TUN 的 meow 不支持字段
  for (const key of ['stack', 'auto-redirect', 'strict-route', 'auto-detect-interface']) {
    if (cfg.tun && Object.prototype.hasOwnProperty.call(cfg.tun, key)) {
      problems.push(`tun.${key} 在 meow 里不被支持`);
    }
  }

  // 7. keep-alive-interval 是旧键名
  if (Object.prototype.hasOwnProperty.call(cfg, 'keep-alive-interval')) {
    problems.push('顶层 keep-alive-interval 是旧键名（meow 用 tcp-keepalive-interval）');
  }

  // 8. 协议类型必须在内核支持面内
  for (const p of proxies) {
    const type = String(p.type || '').toLowerCase();
    if (UNSUPPORTED_PROXY_TYPES.has(type)) problems.push(`节点 ${p.name} 的类型 ${type} 不受支持`);
    if (type === 'hysteria2' && p['ech-opts']) problems.push(`节点 ${p.name} 的 hysteria2 带 ech-opts`);
  }

  // 9. 逻辑规则里不得内嵌 RULE-SET
  for (const r of rules) {
    if (/^(AND|OR|NOT),/.test(r) && r.includes('RULE-SET,')) {
      problems.push(`逻辑规则内嵌 RULE-SET：${r.slice(0, 60)}…`);
    }
  }

  // 10. 引用完整性：规则 target 与组内成员都必须存在
  const groupNames = new Set(groups.map((g) => g.name));
  const proxyNames = new Set(proxies.map((p) => p.name));
  const known = new Set([...groupNames, ...proxyNames, ...BUILTIN_POLICIES]);

  for (const g of groups) {
    if (Array.isArray(g.proxies) && g.proxies.length === 0) {
      problems.push(`策略组 ${g.name} 为空（meow 会整组丢弃）`);
      continue;
    }
    for (const member of g.proxies || []) {
      if (!known.has(member)) problems.push(`策略组 ${g.name} 引用了不存在的成员：${member}`);
    }
  }

  for (const r of rules) {
    // 规则形如 TYPE,payload,policy[,no-resolve|src]；MATCH 只有两段；逻辑规则最后一段才是策略
    const core = String(r)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== 'no-resolve' && s !== 'src');
    const type = core[0];
    const target = type === 'MATCH' ? core[1] : /^(AND|OR|NOT)$/.test(type) ? core[core.length - 1] : core[2];
    if (!target || !known.has(target)) problems.push(`规则指向不存在的策略：${target}（${r.slice(0, 48)}…）`);
  }

  return problems;
}

function main(argv = process.argv.slice(2)) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [scriptRel, outFile, optionsJson, nodesJson] = args;

  if (!scriptRel || !outFile) {
    console.error('用法: node Tools/meow-emit.js <脚本相对路径> <输出 json> [选项 JSON] [节点 JSON]');
    return 2;
  }

  const rc = genConfig([scriptRel, outFile, optionsJson, nodesJson]);
  if (rc !== 0) return rc;

  if (flags.has('--no-assert')) return 0;

  const cfg = JSON.parse(fs.readFileSync(path.resolve(outFile), 'utf8'));
  const problems = assertMeow(cfg);

  if (problems.length === 0) {
    console.log('  meow 方言断言：通过');
    return 0;
  }

  console.error(`::error::meow 方言断言失败 ${problems.length} 处：`);
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, assertMeow };
