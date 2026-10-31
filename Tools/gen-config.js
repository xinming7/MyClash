'use strict';

/**
 * 产物生成器：用测试夹具构造订阅 → 调用覆写脚本 main() → 输出配置 JSON。
 *
 * 用途：给 mihomo -t 做真实内核校验（单元测试只能验证「逻辑对」，验证不了
 * 「mihomo 认不认」）。产出的是 JSON，而 JSON 是 YAML 1.2 的子集，
 * mihomo 可直接解析，因此无需引入 YAML 序列化依赖。
 *
 * 注意：测试夹具里的 uuid 是 'x' 占位值，mihomo 会拒绝非法 uuid，
 * 这里统一规范化成结构合法的节点，否则校验必然失败。
 *
 * 用法：
 *   node Tools/gen-config.js <脚本相对路径> <输出 json> [选项 JSON]
 *
 * 示例：
 *   node Tools/gen-config.js Script/mihomoScript.js /tmp/full.json '{"VG":true}'
 *   node Tools/gen-config.js Script/Script.js /tmp/lite.json
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { loadScript } = require(path.join(REPO_ROOT, 'Test/lib/loader.js'));
const { typicalSubscription } = require(path.join(REPO_ROOT, 'Test/lib/fixtures.js'));

const VALID_UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

/** 把夹具里不合法的占位值替换成 mihomo 可接受的结构 */
function normalize(p) {
  const q = { ...p };
  if (q.type === 'vmess') {
    q.uuid = VALID_UUID;
    q.alterId = 0;
    q.cipher = 'auto';
    q.network = 'tcp';
  }
  if (q.type === 'ss') q.cipher = 'aes-256-gcm';
  if (q.type === 'trojan') q.password = 'x';
  if (!q.server) q.server = '1.2.3.4';
  return q;
}

function main(argv = process.argv.slice(2)) {
  const [scriptRel, outFile, optionsJson] = argv;
  if (!scriptRel || !outFile) {
    console.error('用法: node Tools/gen-config.js <脚本相对路径> <输出 json> [选项 JSON]');
    return 2;
  }

  const api = loadScript(scriptRel);
  const cfg = typicalSubscription();
  cfg.proxies = cfg.proxies.map(normalize);

  const options = optionsJson ? JSON.parse(optionsJson) : {};
  Object.assign(api.ruleOptionsEnable, options);

  const out = api.main(cfg);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  const groups = out['proxy-groups'] || [];
  const emptyGroups = groups.filter((g) => Array.isArray(g.proxies) && g.proxies.length === 0).map((g) => g.name);

  console.log(`[${path.basename(scriptRel)}] 选项=${JSON.stringify(options)}`);
  console.log(
    `  节点 ${(out.proxies || []).length} 个 / 策略组 ${groups.length} 个 / 规则 ${(out.rules || []).length} 条`,
  );
  console.log(`  空策略组：${emptyGroups.length ? emptyGroups.join(', ') : '无'}`);
  if (out.dns) {
    console.log(
      `  fake-ip-filter ${(out.dns['fake-ip-filter'] || []).length} 项 / nameserver ${(out.dns.nameserver || []).length} 项`,
    );
  }

  // 空策略组会让 mihomo 启动失败；直接非 0 退出，把问题挡在推送之前
  if (emptyGroups.length) {
    console.error(`::error::存在 ${emptyGroups.length} 个空策略组：${emptyGroups.join(', ')}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
