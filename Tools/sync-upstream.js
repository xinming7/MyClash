#!/usr/bin/env node
'use strict';

/**
 * 上游同步工具
 *
 * 解决的问题：本仓库是 AIsouler/MyClash 的 fork，自带一批上游没有的特性
 * （VG 家宽三组、链式代理、自定义规则集、倍率组默认关闭等）。每次同步上游都要
 * 手工在冲突里保留这些特性，容易漏；漏了往往要到「节点全挂」或「配置校验失败」才暴露。
 *
 * 三个子命令：
 *   compare  对比本地与上游的分叉情况，并检查本 fork 特性是否都还在位
 *   apply    把本 fork 特性幂等注入到 Script/ 下的两个脚本（可 --dry-run 只看不改）
 *   verify   只做特性在位检查（适合放进 CI / pre-commit）
 *
 * 用法：
 *   node Tools/sync-upstream.js compare
 *   node Tools/sync-upstream.js compare --fetch
 *   node Tools/sync-upstream.js apply --dry-run
 *   node Tools/sync-upstream.js apply --file Script/mihomoScript.js
 *   node Tools/sync-upstream.js apply --only vg-groups,chain-main
 *   node Tools/sync-upstream.js verify
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { applyFeaturesToFile, featureStatus, flavorOf, PatchError } = require('./lib/patch-engine');
const { FEATURES } = require('./lib/feature-manifest');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILES = ['Script/mihomoScript.js', 'Script/Script.js'];
const UPSTREAM_REMOTE = 'upstream';
const SCRIPT_FILES = DEFAULT_FILES;

// ---------- 小工具 ----------

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

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

function gitSafe(args) {
  try {
    return git(args);
  } catch (err) {
    return null;
  }
}

function runGitOrFail(args) {
  try {
    return git(args);
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    throw new Error(stderr || `git ${args.join(' ')} 执行失败`);
  }
}

function resolveFileArg(file) {
  return path.isAbsolute(file) ? file : path.join(REPO_ROOT, file);
}

/** 解析 --key=value / --key value / --flag 形式的参数 */
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

// ---------- compare ----------

function ensureUpstreamRemote() {
  const remotes = git(['remote'])
    .split('\n')
    .map((s) => s.trim());
  if (!remotes.includes(UPSTREAM_REMOTE)) {
    throw new Error(
      `未配置 ${UPSTREAM_REMOTE} 远程仓库，请先执行：\n` +
        `  git remote add ${UPSTREAM_REMOTE} https://github.com/AIsouler/MyClash.git`,
    );
  }
}

function cmdCompare(opts) {
  ensureUpstreamRemote();
  const base = opts.base || `${UPSTREAM_REMOTE}/main`;

  if (opts.fetch) {
    process.stdout.write(c('dim', `拉取 ${UPSTREAM_REMOTE}...\n`));
    git([`fetch`, UPSTREAM_REMOTE, '--prune', '--tags'], { inherit: true });
  }

  const mergeBase = git(['merge-base', 'HEAD', base]).trim();
  const upstreamAhead = git(['log', '--oneline', `${mergeBase}..${base}`]).trim();
  const localAhead = git(['log', '--oneline', `${mergeBase}..HEAD`]).trim();

  const upstreamCommits = upstreamAhead ? upstreamAhead.split('\n') : [];
  const localCommits = localAhead ? localAhead.split('\n') : [];

  console.log(c('bold', '\n=== 分叉情况 ==='));
  console.log(`  分叉点：${git(['log', '-1', '--format=%h %ad %s', '--date=short', mergeBase]).trim()}`);
  console.log(`  上游领先：${upstreamCommits.length} 个提交`);
  console.log(`  本地领先：${localCommits.length} 个提交`);

  if (upstreamCommits.length === 0) {
    console.log(c('green', '\n  已与上游同步，无需合并。'));
  } else {
    console.log(c('bold', '\n=== 上游新增提交（按文件影响面）==='));
    for (const line of upstreamCommits) {
      const sha = line.split(' ')[0];
      const subject = line.slice(sha.length + 1);
      const files = (gitSafe(['show', '--stat', '--format=', '--name-only', sha]) || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const touchesScript = files.some((f) => f.startsWith('Script/'));
      const mark = touchesScript ? c('yellow', '[改脚本]') : c('dim', '[其他]');
      console.log(`  ${mark} ${sha} ${subject}`);
      console.log(c('dim', `      ${files.join(', ') || '（无文件）'}`));
    }
    console.log(c('dim', '\n  提示：标 [改脚本] 的提交都要逐个核对，尤其要确认它是否删改了本 fork 的特性代码。'));
  }

  // 本地特性在位检查
  console.log(c('bold', '\n=== 本 fork 特性在位检查 ==='));
  let missingTotal = 0;
  for (const file of SCRIPT_FILES) {
    const abs = resolveFileArg(file);
    if (!fs.existsSync(abs)) {
      console.log(c('red', `  ✘ 文件不存在：${file}`));
      missingTotal += 1;
      continue;
    }
    const flavor = flavorOf(abs);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    console.log(`\n  ${file} ${c('dim', `(${flavor === 'full' ? '全量版' : '精简版'})`)}`);
    for (const feature of FEATURES) {
      if (feature.only && feature.only !== flavor) continue;
      const st = featureStatus(lines, feature, flavor);
      if (st.ok) {
        console.log(`    ${c('green', '✔')} ${feature.title}`);
      } else {
        missingTotal += st.missing.length;
        console.log(`    ${c('red', '✘')} ${feature.title} ${c('dim', `→ 缺失补丁：${st.missing.join(', ')}`)}`);
      }
    }
  }

  console.log('');
  if (missingTotal > 0) {
    console.log(c('red', `发现 ${missingTotal} 处特性缺失。执行 apply 可自动补回：`));
    console.log('  node Tools/sync-upstream.js apply');
    return 1;
  }
  console.log(c('green', '全部本地特性在位。'));
  return 0;
}

// ---------- apply ----------

function cmdApply(opts) {
  const dryRun = Boolean(opts['dry-run']);
  const files = opts.file ? [String(opts.file)] : SCRIPT_FILES;
  const only = opts.only
    ? String(opts.only)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  for (const id of only || []) {
    if (!FEATURES.some((f) => f.id === id)) {
      throw new Error(`未知特性 id：${id}\n可用特性：${FEATURES.map((f) => f.id).join(', ')}`);
    }
  }

  let totalApplied = 0;
  let totalSkipped = 0;
  let failedFiles = 0;

  for (const file of files) {
    const abs = resolveFileArg(file);
    if (!fs.existsSync(abs)) {
      console.log(c('red', `✘ 文件不存在：${file}`));
      failedFiles += 1;
      continue;
    }

    const report = applyFeaturesToFile(abs, FEATURES, { only, keepGoing: false });
    console.log(c('bold', `\n=== ${file} ${c('dim', `(${report.flavor === 'full' ? '全量版' : '精简版'})`)} ===`));

    for (const feature of report.features) {
      const head = feature.ok ? c('green', '✔') : c('red', '✘');
      console.log(`  ${head} ${feature.title}`);
      for (const patch of feature.patches) {
        if (patch.status === 'applied') {
          console.log(`      ${c('green', '注入')} ${patch.id} ${c('dim', `← ${patch.detail}`)}`);
        } else if (patch.status === 'skipped') {
          console.log(`      ${c('dim', '跳过')} ${patch.id} ${c('dim', '(已存在)')}`);
        } else if (patch.status === 'na') {
          console.log(`      ${c('dim', '不适用')} ${patch.id} ${c('dim', `(${patch.detail})`)}`);
        } else {
          console.log(`      ${c('red', '失败')} ${patch.id}`);
          console.log(c('red', `        ${patch.detail}`));
        }
      }
    }

    totalApplied += report.applied;
    totalSkipped += report.skipped;

    if (report.failed > 0) {
      failedFiles += 1;
      console.log(c('red', `  该文件有 ${report.failed} 个补丁失败，内容未写入（保持原样）。`));
      continue;
    }

    if (report.applied === 0) {
      console.log(c('green', '  已是最新，无需改动。'));
      continue;
    }

    if (dryRun) {
      console.log(c('yellow', `  [dry-run] 将写入 ${report.applied} 处改动，未落盘。`));
      continue;
    }

    fs.writeFileSync(abs, report.content, 'utf8');
    console.log(c('green', `  已写入：${report.applied} 处注入。`));
  }

  console.log(c('bold', '\n=== 汇总 ==='));
  console.log(`  注入 ${totalApplied} 处，跳过 ${totalSkipped} 处，失败文件 ${failedFiles} 个`);

  if (failedFiles > 0) {
    console.log(c('red', '\n有补丁失败，请按上面的锚点提示人工确认上游改动。'));
    return 1;
  }
  if (!dryRun && totalApplied > 0) {
    console.log(c('dim', '\n下一步建议：node Test/run-tests.js 验证脚本仍可正常生成配置。'));
  }
  return 0;
}

// ---------- verify ----------

function cmdVerify(opts) {
  const files = opts.file ? [String(opts.file)] : SCRIPT_FILES;
  let missing = 0;
  for (const file of files) {
    const abs = resolveFileArg(file);
    if (!fs.existsSync(abs)) {
      console.log(c('red', `✘ 文件不存在：${file}`));
      missing += 1;
      continue;
    }
    const flavor = flavorOf(abs);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    for (const feature of FEATURES) {
      if (feature.only && feature.only !== flavor) continue;
      const st = featureStatus(lines, feature, flavor);
      if (!st.ok) {
        missing += st.missing.length;
        console.log(c('red', `✘ ${file} · ${feature.title} → 缺失：${st.missing.join(', ')}`));
      }
    }
  }
  if (missing > 0) {
    console.log(c('red', `\n特性校验失败：${missing} 处缺失。`));
    return 1;
  }
  console.log(c('green', '特性校验通过：两个脚本的 fork 特性均完整。'));
  return 0;
}

// ---------- help ----------

function usage() {
  console.log(`上游同步工具（MyClash fork）

用法：
  node Tools/sync-upstream.js <命令> [选项]

命令：
  compare     对比本地与上游分叉情况，并检查 fork 特性是否在位
  apply       把 fork 特性幂等注入到 Script/ 下的脚本
  verify      仅检查 fork 特性是否完整（可用于 CI）

选项：
  --fetch             compare 前先 git fetch upstream
  --base <ref>        compare 的对比基准（默认 upstream/main）
  --file <path>       只处理指定脚本（默认两个都处理）
  --only <ids>        apply 只处理指定特性，逗号分隔
  --dry-run           apply 只报告不写入

示例：
  node Tools/sync-upstream.js compare --fetch
  node Tools/sync-upstream.js apply --dry-run
  node Tools/sync-upstream.js apply --only vg-groups
  node Tools/sync-upstream.js verify
`);
}

function main(argv) {
  const opts = parseArgs(argv);
  const command = opts._[0];

  try {
    switch (command) {
      case 'compare':
        return cmdCompare(opts);
      case 'apply':
        return cmdApply(opts);
      case 'verify':
        return cmdVerify(opts);
      case 'help':
      case undefined:
        usage();
        return 0;
      default:
        console.error(c('red', `未知命令：${command}`));
        usage();
        return 2;
    }
  } catch (err) {
    if (err instanceof PatchError) {
      console.error(c('red', `补丁失败（${err.patchId}）：${err.message}`));
      return 1;
    }
    console.error(c('red', `错误：${err.message}`));
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
