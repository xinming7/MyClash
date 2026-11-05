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
 * 都不会碰到这里。代价是这个文件要自己复制少量 helper（mkCustomProxy 等）。
 *
 * 这里锁的都是「上游行为」而不是「fork 行为」——上游一旦改变语义，应先让用例变红，
 * 再由人决定是跟还是保留差异。
 */
function runForkTests(h, api) {
  h.section('fork 校验 · 节点名零宽字符');

  const matched = (name) => api.getMatchedRegions(name).map((r) => r.name);

  h.test('逐字符插入零宽空格的节点名仍能匹配地区', () => {
    h.assert(matched('台\u200B湾 02').includes('台湾'), '台\u200B湾 应识别为台湾');
    h.assert(matched('香\u200B港 03').includes('香港'), '香\u200B港 应识别为香港');
  });

  h.section('fork 校验 · 链式代理（锁定上游语义，防止静默变更）');

  const mkCustomProxy = (name) => ({
    name,
    type: 'ss',
    server: 'x.example.com',
    port: 443,
    cipher: 'aes-256-gcm',
    password: 'x',
  });

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
}

module.exports = { runForkTests };
