#!/usr/bin/env node
/**
 * 检查 `stable`（客户端实际拉取的分支）是否落后于 `main`。
 *
 * 背景：2026-11-03 起客户端只拉 `stable`，`main` 是开发分支。发布 = 打 tag + 把 `stable`
 * 快进到该 tag（`.github/workflows/release.yaml` 负责后半段）。于是出现一种全新的失效模式：
 * **上游每天自动同步到 main，但没人打 tag，stable 就停在旧代码上，而且没有任何地方会报错。**
 * 这个脚本就是那个「会报错的地方」。
 *
 * 判定分三档：
 *  - error  `stable` 不是 `main` 的祖先（被强推回滚过 / 分叉）——推送 release 会失败，必须人工判断；
 *  - warn   `main` 有未发布提交，且最老的已经超过 `--max-lag-days` 天（默认 7）；
 *  - notice `stable` 落后但还在阈值内（正常开发中），以及最新 tag 没落到 stable 上。
 *
 * 用法：
 *   node Tools/check-release-drift.js                        # 本地查 origin/main 与 origin/stable
 *   node Tools/check-release-drift.js --max-lag-days 3       # 收紧阈值
 *   node Tools/check-release-drift.js --stable v1.7.0        # 对比任意引用
 *   node Tools/check-release-drift.js --json
 *
 * 退出码：0 无问题（notice 不算问题）；1 有 error 或 warn；2 用法/git 错误。
 */
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const STABLE = opt('--stable', 'origin/stable');
const MAIN = opt('--main', 'origin/main');
const MAX_LAG_DAYS = Number(opt('--max-lag-days', '7'));
// --now 用于把「当前时间」挪到未来，可复现地验证积压告警（本仓库历史往往集中在同一天，
// 否则 ageDays 恒为 0，warn 分支永远测不到）。支持 epoch 秒或 YYYY-MM-DD。
function resolveNow() {
  const raw = opt('--now', null);
  if (!raw) return Math.floor(Date.now() / 1000);
  if (/^\d+$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  if (Number.isNaN(t)) fail(`--now 无法解析：${raw}`);
  return Math.floor(t / 1000);
}
const JSON_OUT = args.includes('--json');
const CI = process.env.GITHUB_ACTIONS === 'true';

function git(...cmd) {
  return execFileSync('git', cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(...cmd) {
  try {
    return git(...cmd);
  } catch {
    return null;
  }
}

function fail(msg) {
  console.error(`无法检查：${msg}`);
  console.error('提示：本地先 git fetch origin --tags，或确认 ref 拼写正确。');
  process.exit(2);
}

if (!Number.isFinite(MAX_LAG_DAYS) || MAX_LAG_DAYS < 0) fail(`--max-lag-days 需要非负整数，收到 ${MAX_LAG_DAYS}`);
const NOW = resolveNow();

const stableSha = tryGit('rev-parse', '--verify', '--quiet', `${STABLE}^{commit}`);
if (!stableSha) fail(`引用不存在：${STABLE}`);
const mainSha = tryGit('rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`);
if (!mainSha) fail(`引用不存在：${MAIN}`);

const ahead = Number(git('rev-list', '--count', `${STABLE}..${MAIN}`)); // main 有、stable 没有
const behind = Number(git('rev-list', '--count', `${MAIN}..${STABLE}`)); // stable 有、main 没有
const isAncestor = tryGit('merge-base', '--is-ancestor', stableSha, mainSha) !== null;

const issues = [];
const add = (level, msg, hint) => issues.push({ level, msg, hint });

if (!isAncestor || behind > 0) {
  add(
    'error',
    `stable 不是 main 的祖先（stable 独有 ${behind} 个提交），两边可能已分叉`,
    '常见原因：stable 被强推回滚到旧 tag 后 main 又前进了。确认后再手动把 stable 快进或重新打 tag。',
  );
}

// 未发布提交的年龄：取区间里最老的一个
let oldestTs = 0;
let oldestSubject = '';
if (ahead > 0) {
  const line = tryGit('log', '--reverse', '--format=%ct%x09%s', `${STABLE}..${MAIN}`, '-1');
  if (line) {
    const [ts, ...rest] = line.split('\t');
    oldestTs = Number(ts);
    oldestSubject = rest.join('\t');
  }
}
const ageDays = oldestTs ? Math.floor((NOW - oldestTs) / 86400) : 0;

if (ahead > 0) {
  if (ageDays > MAX_LAG_DAYS) {
    add(
      'warn',
      `有 ${ahead} 个提交未发布，最老的已积压 ${ageDays} 天（阈值 ${MAX_LAG_DAYS} 天）`,
      `最老一条：${oldestSubject}。发布方式：git tag -a vX.Y.Z && git push origin vX.Y.Z（release workflow 会自动快进 stable）。`,
    );
  } else {
    add('notice', `有 ${ahead} 个提交待发布，最老 ${ageDays} 天，仍在 ${MAX_LAG_DAYS} 天阈值内`, null);
  }
} else if (isAncestor && behind === 0) {
  add('ok', 'main 与 stable 完全一致，没有待发布内容', null);
}

// 最新 tag 是否落在 stable 上：tag 打了但没发出去，等于发了个空版本
const latestTag = tryGit('for-each-ref', '--sort=-creatordate', '--count=1', '--format=%(refname:short)', 'refs/tags');
if (latestTag) {
  const tagSha = tryGit('rev-parse', '--verify', '--quiet', `${latestTag}^{commit}`);
  if (tagSha === stableSha) {
    add('ok', `stable 正指向最新 tag ${latestTag}`, null);
  } else {
    const tagAhead = tagSha && tryGit('merge-base', '--is-ancestor', stableSha, tagSha) !== null;
    add(
      'notice',
      tagAhead
        ? `最新 tag ${latestTag} 比 stable 新，尚未发布（打 tag 后 release workflow 未跑或失败）`
        : `最新 tag ${latestTag} 与 stable 不一致（stable 可能已回滚或 tag 打在别的分支上）`,
      tagAhead ? '看 Actions 里 release 那次运行的结论。' : null,
    );
  }
}

const hasProblem = issues.some((i) => i.level === 'error' || i.level === 'warn');

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        stable: { ref: STABLE, sha: stableSha },
        main: { ref: MAIN, sha: mainSha },
        ahead,
        behind,
        ageDays,
        maxLagDays: MAX_LAG_DAYS,
        latestTag,
        issues,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`stable ${STABLE} = ${stableSha.slice(0, 7)}`);
  console.log(`main   ${MAIN} = ${mainSha.slice(0, 7)}`);
  console.log(`待发布 ${ahead} 个提交（最老 ${ageDays} 天），stable 独有 ${behind} 个提交\n`);
  for (const i of issues) {
    const tag = { error: '✘', warn: '⚠', notice: 'ℹ', ok: '✔' }[i.level];
    console.log(`${tag} ${i.msg}`);
    if (i.hint) console.log(`   → ${i.hint}`);
  }
}

if (CI) {
  for (const i of issues) {
    if (i.level === 'error') console.error(`::error::${i.msg}`);
    else if (i.level === 'warn') console.error(`::warning::${i.msg}`);
  }
}

process.exit(hasProblem ? 1 : 0);
