#!/usr/bin/env node
'use strict';

/**
 * 锚点体检
 *
 * 解决的问题：`feature-manifest.js` 里的每个补丁都靠「锚点」定位上游代码，锚点一旦被
 * 上游改写，同步就会在 replay 阶段红灯。等红灯再修虽然安全（main 不会被污染），但代价
 * 是「睡一觉起来发现同步失败」。这个工具把这件事前移：**在同步之前**告出哪些锚点已经
 * 贴近断裂边缘。
 *
 * 三层证据，缺一不可：
 *   1. 全新注入实测（硬指标）——把上游原版直接喂给注入引擎，此时 marker 不可能命中，
 *      锚点必须真的存在才能通过。marker 命中而跳过 = 该锚点从未被验证过。
 *   2. 上游历史易变度——用 `git log -S <锚点行>` 统计该行在上游历史上被改过多少次。
 *   3. 依赖分析——锚点指向的是上游原文，还是「别的补丁注入的产物」。后者意味着 A 补丁
 *      消失会把 B 补丁一起带崩。
 *
 * 用法：
 *   node Tools/audit-anchors.js                 # 分级清单（含上游改动次数，约 1 秒）
 *   node Tools/audit-anchors.js --no-history    # 跳过历史统计（浅克隆 / 离线可用）
 *   node Tools/audit-anchors.js --json          # 机器可读
 *   node Tools/audit-anchors.js --strict        # 存在依赖锚点也判失败（用于收紧门槛）
 *   node Tools/audit-anchors.js --ref origin/main
 *
 * 退出码：0 健康；1 存在死锚点（当前上游已经注入不进去）；2 仅 --strict 下的依赖/未验证项。
 */

const path = require('path');
const { execFileSync } = require('child_process');

const { applyFeaturesToContent, findAll } = require('./lib/patch-engine');
const { FEATURES } = require('./lib/feature-manifest');

const REPO_ROOT = path.resolve(__dirname, '..');
const FILES = { full: 'Script/mihomoScript.js', lite: 'Script/Script.js' };
const DEFAULT_REF = 'upstream/main';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function c(color, text) {
  return process.stdout.isTTY ? `${C[color]}${text}${C.reset}` : text;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitSafe(args) {
  try {
    return git(args);
  } catch (err) {
    return null;
  }
}

// ---------- 参数 ----------

function parseArgs(argv) {
  const opts = { ref: DEFAULT_REF, history: true, json: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--history') opts.history = true;
    else if (a === '--no-history') opts.history = false;
    else if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--ref') {
      const value = argv[i + 1];
      if (!value) throw new Error('--ref 后面需要跟一个引用名，例如 --ref upstream/main');
      opts.ref = value;
      i += 1;
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

// ---------- 清单展开 ----------

/** 补丁适用的版本：补丁级 only 优先于特性级 only */
function flavorsOf(feature, patch) {
  const only = patch.only || feature.only;
  return only ? [only] : ['full', 'lite'];
}

/** 按补丁引擎的规则取出某个版本的字段（字符串 / {full,lite} 对象） */
function pick(value, flavor) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('\n');
  if (value instanceof RegExp) return value.source;
  const picked = value[flavor];
  return picked == null ? null : pick(picked, flavor);
}

/**
 * 代表性行：锚点里 trim 后最长的一行。
 * `{`、`},` 这类纯语法行在历史统计里毫无信息量（`git log -S '{'` 会命中每一次改动），
 * 所以选信息量最大的那行代表整个锚点。
 */
function representativeLine(anchorLines) {
  const cands = anchorLines.map((s) => s.trim()).filter(Boolean);
  if (!cands.length) return null;
  return cands.sort((a, b) => b.length - a.length)[0];
}

/** 按锚点首行的形态粗略归类，用于判断「这类内容上游爱不爱改」 */
function classify(line) {
  if (/^(\/\/|\*|\/\*)/.test(line)) return '注释';
  if (/^(name|title):\s*['"]/.test(line)) return '组名/标题';
  if (/^(const|let|var)\s/.test(line)) return '声明';
  if (/^'?(RULE-SET|DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|GEOIP|IP-CIDR|IP-CIDR6|MATCH|AND|OR),/.test(line))
    return '规则数组元素';
  if (/^\w+:\s*(true|false)\b/.test(line)) return '开关默认值';
  if (/^(icon|url|path|type|behavior|format|interval|reject|dialect|defaultSelected):/.test(line)) return '对象字段';
  if (/^(function|async function|class)\s/.test(line)) return '函数签名';
  if (/^(if|for|while|return|else)\b/.test(line)) return '控制流';
  if (/^\}\s*,?$|^\]\s*,?$|^\{\s*$|^\[\s*$/.test(line)) return '语法结构';
  if (/^\w+\s*[:=]/.test(line)) return '赋值/属性';
  return '其他';
}

/** 收集每个版本里所有补丁的输入文本，用来判断锚点是否由别的补丁生成 */
function collectProducedTexts() {
  const byFlavor = { full: [], lite: [] };
  for (const feature of FEATURES) {
    for (const patch of feature.patches) {
      for (const flavor of flavorsOf(feature, patch)) {
        byFlavor[flavor].push({
          feature: feature.id,
          patch: patch.id,
          lines: new Set(
            (pick(patch.text, flavor) || '')
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        });
      }
    }
  }
  return byFlavor;
}

// ---------- 上游历史 ----------

function historyCache() {
  const cache = new Map();
  return function changes(ref, file, line) {
    // 太短或纯语法的行，`git log -S` 统计出来是噪声，直接不给数
    if (!line || line.length < 12 || classify(line) === '语法结构') return null;
    const key = `${file}\0${line}`;
    if (cache.has(key)) return cache.get(key);
    const out = gitSafe(['log', '-S', line, '--oneline', ref, '--', file]);
    const value = out === null ? null : out.split('\n').filter(Boolean).length;
    cache.set(key, value);
    return value;
  };
}

// ---------- 主流程 ----------

function audit(opts) {
  const refLabel = gitSafe(['rev-parse', '--verify', opts.ref])
    ? `${opts.ref} (${gitSafe(['rev-parse', '--short', opts.ref]).trim()})`
    : opts.ref;

  // 上游原版内容 + 全新注入结果
  const sources = {};
  const freshStatus = {};
  for (const [flavor, file] of Object.entries(FILES)) {
    const content = gitSafe(['show', `${opts.ref}:${file}`]);
    if (content === null) throw new Error(`无法读取 ${opts.ref}:${file}，请确认 ref 存在且已 fetch`);
    sources[flavor] = { file, content, lines: content.split('\n') };

    const report = applyFeaturesToContent(content, flavor, FEATURES, { keepGoing: true });
    freshStatus[flavor] = { applied: report.applied, skipped: report.skipped, failed: report.failed, patches: {} };
    for (const f of report.features) {
      for (const p of f.patches) {
        freshStatus[flavor].patches[p.id] = { status: p.status, detail: p.detail };
      }
    }
  }

  const producedBy = collectProducedTexts();
  const changesOf = opts.history ? historyCache() : () => null;

  const rows = [];
  for (const feature of FEATURES) {
    for (const patch of feature.patches) {
      for (const flavor of flavorsOf(feature, patch)) {
        const anchorRaw = pick(patch.anchor, flavor);
        if (anchorRaw == null) continue;
        const anchorLines = anchorRaw.split('\n');
        const rep = representativeLine(anchorLines);
        if (!rep) continue;

        const src = sources[flavor];
        const hits = findAll(src.lines, anchorLines).length;
        // 只有「上游原文里根本没有这一行」时，才说明锚点完全靠别的补丁生成——这才是真依赖。
        // 若上游原文里就有，即便某补丁的注入文本里也出现了同样的行，也不构成依赖。
        const produced = producedBy[flavor].filter((t) => t.patch !== patch.id && t.lines.has(rep)).map((t) => t.patch);
        const dep = hits === 0 && produced.length > 0;
        const fresh = freshStatus[flavor].patches[patch.id] || { status: 'unknown', detail: '' };
        const changes = changesOf(opts.ref, src.file, rep);
        const type = classify(rep);

        let grade;
        if (fresh.status === 'failed' || (hits === 0 && !dep)) grade = 'P0';
        else if (dep) grade = 'P1';
        else if (changes === null ? ['规则数组元素', '开关默认值'].includes(type) : changes >= 3) grade = 'P1';
        else grade = 'P2';

        rows.push({
          feature: feature.id,
          patch: patch.id,
          flavor,
          file: src.file,
          op: patch.op,
          anchorLines: anchorLines.length,
          anchor: rep,
          hits,
          present: hits > 0,
          changes,
          type,
          producedBy: dep ? produced : [],
          // fresh=skipped 说明 marker 被（通常是别的补丁注入的）文本提前命中，锚点从未被真正走一遍
          fresh: fresh.status,
          freshDetail: fresh.detail,
          unverified: fresh.status === 'skipped',
          grade,
        });
      }
    }
  }

  const order = { P0: 0, P1: 1, P2: 2 };
  rows.sort(
    (a, b) => order[a.grade] - order[b.grade] || (b.changes || 0) - (a.changes || 0) || a.patch.localeCompare(b.patch),
  );

  const summary = {
    ref: refLabel,
    patchFlavorPairs: rows.length,
    patches: new Set(rows.map((r) => r.patch)).size,
    features: new Set(rows.map((r) => r.feature)).size,
    dead: rows.filter((r) => r.grade === 'P0').length,
    P0: rows.filter((r) => r.grade === 'P0').length,
    P1: rows.filter((r) => r.grade === 'P1').length,
    P2: rows.filter((r) => r.grade === 'P2').length,
    dependencies: rows.filter((r) => r.producedBy.length > 0).length,
    unverified: rows.filter((r) => r.unverified).length,
    fresh: Object.fromEntries(
      Object.entries(freshStatus).map(([fl, v]) => [fl, { applied: v.applied, skipped: v.skipped, failed: v.failed }]),
    ),
  };

  return { summary, rows };
}

// ---------- 输出 ----------

function pad(text, width) {
  // 中文按两格宽计算，避免表格错位
  const w = [...String(text)].reduce((n, ch) => n + (/[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
  return String(text) + ' '.repeat(Math.max(0, width - w));
}

function printReport({ summary, rows }) {
  console.log(`${c('bold', '锚点体检')}  ${c('dim', '把两个脚本回放到上游原版，检查每个锚点还能不能用')}`);
  console.log(`上游引用：${summary.ref}`);
  console.log(
    `规模：${summary.patchFlavorPairs} 个「补丁 × 版本」组合 / ${summary.patches} 个补丁 / ${summary.features} 个特性`,
  );
  console.log('');

  const f = summary.fresh;
  const icons = { applied: '✔', skipped: '~', failed: '✘' };
  console.log(c('bold', '第一层：全新注入实测'));
  for (const fl of ['full', 'lite']) {
    const s = f[fl];
    const mark = s.failed ? c('red', '✘') : c('green', '✔');
    console.log(
      `  ${mark} ${fl.padEnd(4)} applied ${String(s.applied).padStart(2)}  skipped ${String(s.skipped).padStart(2)}  failed ${s.failed}`,
    );
  }
  console.log(
    c('dim', '  「skipped」不是错误，而是 marker 被（通常是别的补丁注入的）文本提前命中——该锚点这一轮没被走一遍。'),
  );
  console.log('');

  console.log(c('bold', '风险分级'));
  console.log(
    `  P0 ${String(summary.P0).padStart(2)}  ${c('red', '死锚点')}：当前上游注入不进去，marker 一不命中就必炸`,
  );
  console.log(
    `  P1 ${String(summary.P1).padStart(2)}  ${c('yellow', '高风险')}：依赖其他补丁产物，或锚了上游高频改动的内容`,
  );
  console.log(`  P2 ${String(summary.P2).padStart(2)}  低风险：注释、声明、组名、函数签名等紧贴上游骨架的位置`);
  console.log('');

  const hi = rows.filter((r) => r.grade !== 'P2');
  if (hi.length) {
    console.log(c('bold', 'P0 / P1 明细'));
    for (const r of hi) {
      const chg = r.changes === null ? '  -' : `${String(r.changes).padStart(3)}次`;
      const flag = r.grade === 'P0' ? c('red', 'P0') : c('yellow', 'P1');
      console.log(
        `  ${flag} ${chg}  ${pad(r.flavor, 4)} ${pad(r.type, 12)} ${r.patch}${r.unverified ? c('cyan', '  [未验证]') : ''}`,
      );
      console.log(`         ${c('dim', '锚点')} ${r.anchor.slice(0, 78)}`);
      if (r.producedBy.length) console.log(`         ${c('yellow', '依赖')} 由补丁生成：${r.producedBy.join(', ')}`);
      if (r.hits === 0) console.log(`         ${c('red', '上游已无此内容')}`);
    }
    console.log('');
  }

  const unverified = rows.filter((r) => r.unverified);
  if (unverified.length) {
    console.log(c('bold', '从未被验证过的锚点'));
    console.log(
      c('dim', '  这些补丁在全新注入时就被 marker 拦下，锚点写错了也发现不了。若上游删掉注入源，它们会立刻失效。'),
    );
    for (const r of unverified) console.log(`  ~ ${pad(r.flavor, 4)} ${r.patch}（${r.freshDetail || '已存在'}）`);
    console.log('');
  }

  const dead = rows.filter((r) => r.grade === 'P0');
  if (dead.length) {
    console.log(c('red', '结论：存在死锚点，同步必然失败，需先修锚点'));
  } else {
    console.log(c('green', `结论：${summary.patchFlavorPairs} 个锚点全部可用，0 个死锚点`));
    if (summary.dependencies)
      console.log(c('dim', `  其中 ${summary.dependencies} 个依赖其他补丁的产物（P1），可用 --strict 收紧门槛`));
  }
}

// ---------- 入口 ----------

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (opts.help) {
    console.log('用法：node Tools/audit-anchors.js [--ref upstream/main] [--history] [--json] [--strict]');
    return;
  }

  let result;
  try {
    result = audit(opts);
  } catch (err) {
    console.error(`体检失败：${err.message}`);
    process.exit(1);
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printReport(result);

  if (result.summary.P0 > 0) process.exit(1);
  if (opts.strict && (result.summary.dependencies > 0 || result.summary.unverified > 0)) process.exit(2);
}

main();
