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
 *   node Tools/gen-config.js <脚本相对路径> <输出 json> [选项 JSON] [节点 JSON]
 *
 * 第 4 个参数是「补充节点」，支持两种写法：
 *   数组                      → 全部作为自定义节点（写进脚本的 customizeProxies）
 *   {"custom":[...],"subscription":[...]}  → 前者是自定义节点，后者追加进订阅节点
 * 它用于校验「需要特定节点才生效」的路径：链式代理在没有任何自定义节点时会直接抛错，
 * VG 三组则要求订阅里出现「🏠 XX-家宽-NN」格式或带「优选」的节点。没有这个入口，
 * 这两条路径永远进不了内核校验。
 *
 * 示例：
 *   node Tools/gen-config.js Script/mihomoScript.js /tmp/full.json '{"VG":true}'
 *   node Tools/gen-config.js Script/Script.js /tmp/lite.json
 *   node Tools/gen-config.js Script/mihomoScript.js /tmp/chain.json '{"VG":true,"链式代理":true}' \
 *     '{"custom":[{"name":"自建-落地","type":"ss","server":"c.example.com","port":443,"cipher":"aes-256-gcm","password":"x"}],
 *       "subscription":[{"name":"🏠 HK-家宽-01","type":"ss","server":"g.example.com","port":443,"cipher":"aes-256-gcm","password":"x"}]}'
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
  const [scriptRel, outFile, optionsJson, nodesJson] = argv;
  if (!scriptRel || !outFile) {
    console.error('用法: node Tools/gen-config.js <脚本相对路径> <输出 json> [选项 JSON] [节点 JSON]');
    return 2;
  }

  const options = optionsJson ? JSON.parse(optionsJson) : {};

  // 自定义节点走「改脚本源码」注入，与集成测试保持一致：脚本里 customizeProxies 是常量数组，
  // 没有外部注入点。锚点找不到时直接失败，避免悄悄生成一份没测到链式代理的配置。
  let customs = [];
  let extraProxies = [];
  if (nodesJson) {
    const parsed = JSON.parse(nodesJson);
    if (Array.isArray(parsed)) {
      customs = parsed;
    } else {
      customs = parsed.custom || [];
      extraProxies = parsed.subscription || [];
    }
  }

  let transform = (code) => code;
  if (customs.length) {
    const anchor = 'const customizeProxies = [];';
    if (!fs.readFileSync(path.resolve(REPO_ROOT, scriptRel), 'utf8').includes(anchor)) {
      console.error(`::error::脚本中找不到注入锚点：${anchor}`);
      return 1;
    }
    const injected = JSON.stringify(customs.map(normalize));
    transform = (code) => code.replace(anchor, `const customizeProxies = ${injected};`);
  }

  const api = loadScript(scriptRel, transform);
  const cfg = typicalSubscription();
  cfg.proxies = [...cfg.proxies.map(normalize), ...extraProxies.map(normalize)];

  Object.assign(api.ruleOptionsEnable, options);

  const out = api.main(cfg);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  const groups = out['proxy-groups'] || [];
  const emptyGroups = groups.filter((g) => Array.isArray(g.proxies) && g.proxies.length === 0).map((g) => g.name);

  console.log(`[${path.basename(scriptRel)}] 选项=${JSON.stringify(options)}`);
  if (customs.length || extraProxies.length) {
    console.log(`  注入自定义节点 ${customs.length} 个 / 追加订阅节点 ${extraProxies.length} 个`);
  }
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
