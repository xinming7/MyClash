'use strict';

/**
 * fork 专属测试的独立入口。
 *
 * 为什么不挂在上游的 `Test/run-tests.js` 里：那个文件是上游的施工区，我们只要
 * 往里加两行 require/调用，就等于给每次上游改动都埋一颗合并冲突——2026-11-13
 * 上游把 `es2020-check` 改名成 `es2026-check`，改的正是我们挂载行旁边那一行，
 * 于是 `Test/run-tests.js` 成了「非注入目标文件」冲突，直接触发 L2 人工，
 * 整次自动同步作废（run 43339738242）。
 *
 * 现在 fork 用例一律在这里跑，`Test/run-tests.js` 保持与上游逐字节相同：
 * 上游怎么重构自己的 runner 都不会碰到 fork 的挂载点。CI 里两个入口都要跑
 * （`node Test/run-tests.js` + `node Test/run-fork-tests.js`），顺序无关。
 *
 * 用法：node Test/run-fork-tests.js
 */

const { loadScript } = require('./lib/loader');
const { Harness } = require('./lib/harness');
const fx = require('./lib/fixtures');
const { runForkTests } = require('./suites/fork');
const { SCRIPTS } = require('./lib/scripts');

function main() {
  console.log('MyClash fork 特性测试');
  console.log('='.repeat(64));

  let totalPassed = 0;
  let totalFailed = 0;

  for (const script of SCRIPTS) {
    console.log(`\n${'='.repeat(64)}`);
    console.log(`  测试对象: ${script.label}  (${script.file})`);
    console.log(`${'='.repeat(64)}`);

    const api = loadScript(script.file);
    const h = new Harness(script.label);

    // 第三个参数是 end-to-end 用例需要的最小上下文：fixtures、注入入口、脚本路径
    runForkTests(h, api, { fx, loadScript, scriptFile: script.file });

    const s = h.summary();
    totalPassed += s.passed;
    totalFailed += s.failed;
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`  fork 用例总计: 通过 ${totalPassed} 项，失败 ${totalFailed} 项`);
  console.log(`${'='.repeat(64)}`);

  if (totalFailed > 0) {
    console.log('\n有失败用例，请查看上方 ✗ 标记的详细信息。');
  } else {
    console.log('\n全部 fork 用例通过 ✅');
  }
  return totalFailed > 0 ? 1 : 0;
}

process.exit(main());
