#!/usr/bin/env node
'use strict';

/**
 * meow 版脚本生成器
 *
 * 解决的问题：meow-rs 与 mihomo 的配置方言有若干硬性差异（详见 Docs/MeowRS适配方案.md），
 * 其中 DNS 段的两三处差异会让整份配置被内核拒绝。手工维护一份 meow 脚本副本必然漂移
 * （`Script/concordScript.js` 就是先例：不在测试清单、不在任何 CI 里），所以这里沿用
 * `sync-upstream` 的补丁模型：**mihomo 版脚本 + meow 补丁清单 → meow 版脚本**。
 *
 * 与 sync-upstream 的关系：
 *  - 本工具不碰 `Script/mihomoScript.js`，只读它；
 *  - `MEOW_FEATURES` 不参与 4 个派生目标的注入，反之 `FEATURES` 也不会进 meow 目标
 *    （清单里每条都标了 `only: 'meow'`）。
 *
 * 用法：
 *   node Tools/build-meow.js            # 生成 Script/meowScript.js
 *   node Tools/build-meow.js --check    # 只比对不落盘（CI 用，退出码 1 = 生成物过期）
 *   node Tools/build-meow.js --only meow-dns-default-ns,meow-tun-keys
 *   node Tools/build-meow.js --dry-run
 */

const fs = require('fs');
const path = require('path');

const { applyFeaturesToContent, PatchError } = require('./lib/patch-engine');
const { MEOW_FEATURES } = require('./lib/meow-manifest');

const REPO_ROOT = path.resolve(__dirname, '..');

// 目前只生成全量版。lite 版要加进来时，在这里补一条即可（补丁锚点需按 Script.js 校对）。
const TARGETS = [
  {
    flavor: 'meow',
    label: 'meow 全量版',
    base: 'Script/mihomoScript.js',
    out: 'Script/meowScript.js',
  },
];

/**
 * 生成结果的兜底断言。
 *
 * 补丁全部「成功」并不等于产物正确：锚点唯一但语义写错、或者目标文件里还有第二处同类写法时，
 * 生成物看起来完好、内核照样拒绝。这里把「必须消失」的写法列出来，命中即判定失败。
 */
const FORBIDDEN = [
  { id: 'default-ns-tagged', re: /const defaultDNS = \[[^\]]*[#?]/ },
  { id: 'proxy-ns-tagged', re: /const proxyServerDNS = \[[^\]]*[#?]/ },
  { id: 'foreign-dns-hash-tag', re: /const foreignDNS = \[[^\]]*#/ },
  { id: 'ns-policy-system', re: /'rule-set:private': 'system'/ },
  { id: 'lb-sticky-sessions', re: /strategy: 'sticky-sessions'/ },
  { id: 'tun-stack-mips', re: /stack: 'mips'/ },
  { id: 'tun-auto-redirect', re: /'auto-redirect': true/ },
  { id: 'keep-alive-legacy', re: /newConfig\['keep-alive-interval'\]/ },
  { id: 'quic-nested-ruleset', re: /RULE-SET,cn_ip,no-resolve/ },
  { id: 'strip-dns-hash-tag', re: /return prefix \+ '#DIRECT'/ },
];

const REQUIRED = [
  { id: 'prune-called', re: /pruneUnavailableGroups\(newConfig\);/ },
  { id: 'unsupported-type-filter', re: /meowUnsupportedProxyTypes\.has\(type\)/ },
  { id: 'foreign-dns-proxy-tag', re: /dns-query\?proxy=默认代理/ },
];

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function c(color, text) {
  return process.stdout.isTTY ? `${C[color]}${text}${C.reset}` : text;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      opts._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      opts[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      opts[body] = next;
      i += 1;
    } else {
      opts[body] = true;
    }
  }
  return opts;
}

function lint(content) {
  const problems = [];
  for (const rule of FORBIDDEN) {
    if (rule.re.test(content)) problems.push(`仍存在（${rule.id}）：${rule.re}`);
  }
  for (const rule of REQUIRED) {
    if (!rule.re.test(content)) problems.push(`缺失（${rule.id}）：${rule.re}`);
  }
  return problems;
}

function buildTarget(target, only) {
  const basePath = path.join(REPO_ROOT, target.base);
  const outPath = path.join(REPO_ROOT, target.out);
  const baseContent = fs.readFileSync(basePath, 'utf8');

  const report = applyFeaturesToContent(baseContent, target.flavor, MEOW_FEATURES, {
    only,
    keepGoing: false,
  });

  console.log(c('bold', `\n=== ${target.out} ${c('dim', `← ${target.base}`)} ===`));
  for (const feature of report.features) {
    console.log(`  ${feature.ok ? c('green', '✔') : c('red', '✘')} ${feature.title}`);
    for (const patch of feature.patches) {
      if (patch.status === 'applied') console.log(`      ${c('green', '注入')} ${patch.id}`);
      else if (patch.status === 'skipped') console.log(`      ${c('dim', '跳过')} ${patch.id} (已存在)`);
      else if (patch.status === 'na') console.log(`      ${c('dim', '不适用')} ${patch.id}`);
      else {
        console.log(`      ${c('red', '失败')} ${patch.id}`);
        console.log(c('red', `        ${patch.detail}`));
      }
    }
  }

  if (report.failed > 0) {
    throw new PatchError(`${target.out} 有 ${report.failed} 个补丁失败，未写入（保持原样）`, 'build');
  }

  const problems = lint(report.content);
  if (problems.length > 0) {
    console.log(c('red', `  兜底断言失败 ${problems.length} 处：`));
    for (const p of problems) console.log(c('red', `    - ${p}`));
    return { ok: false, applied: report.applied, problems };
  }

  const previous = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
  const same = previous === report.content;
  return { ok: true, applied: report.applied, skipped: report.skipped, same, content: report.content, outPath };
}

function main(argv) {
  const opts = parseArgs(argv);
  const only = opts.only
    ? String(opts.only)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  for (const id of only || []) {
    if (!MEOW_FEATURES.some((f) => f.id === id)) {
      console.error(c('red', `未知特性 id：${id}\n可用：${MEOW_FEATURES.map((f) => f.id).join(', ')}`));
      return 2;
    }
  }

  const check = Boolean(opts.check);
  let failed = 0;
  let stale = 0;

  for (const target of TARGETS) {
    let result;
    try {
      result = buildTarget(target, only);
    } catch (err) {
      if (err instanceof PatchError) {
        console.error(c('red', `补丁失败（${err.patchId}）：${err.message}`));
        return 1;
      }
      throw err;
    }

    if (!result.ok) {
      failed += 1;
      continue;
    }

    if (check) {
      if (result.same) {
        console.log(c('green', `  ✔ 生成物是最新的（注入 ${result.applied} 处）`));
      } else {
        stale += 1;
        console.log(c('red', `  ✘ 生成物已过期：请运行 node Tools/build-meow.js 重新生成`));
      }
      continue;
    }

    if (opts['dry-run']) {
      console.log(c('yellow', `  [dry-run] 将写入 ${result.applied} 处注入，未落盘`));
      continue;
    }

    fs.writeFileSync(result.outPath, result.content, 'utf8');
    console.log(c('green', `  已写入：注入 ${result.applied} 处、跳过 ${result.skipped} 处`));
  }

  if (failed > 0 || stale > 0) {
    console.log(c('red', `\n生成未通过：兜底断言失败 ${failed} 个文件、过期 ${stale} 个文件`));
    return 1;
  }
  console.log(c('green', '\nmeow 版生成检查通过。'));
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, TARGETS, FORBIDDEN, REQUIRED };
