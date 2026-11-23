#!/usr/bin/env node
'use strict';

/**
 * meow 内核级验证：真启动 + 探活 + 断言
 *
 * 为什么不用 `meow -t` 交差：`-t` 走的是 offline validation，规则集按空数据求值、
 * DNS 策略不完整求值。实测就有「`-t` 通过、`meow -f` 启动即退」的例子
 * （`nameserver-policy` 里出现 meow 不认的 `system`）。只信 `-t` 等于把这类致命配置
 * 直接推给用户。
 *
 * 本工具做的事：改端口/关 TUN（避免影响本机环境）→ 起进程 → 轮询 /version →
 * 核对策略组与规则是否都被内核接受 → 检查日志里没有 ERROR → 退出并清理。
 *
 * 用法：
 *   node Tools/meow-verify.js /tmp/meow.json
 *   node Tools/meow-verify.js /tmp/meow.json --bin ./bin/meow --port 17890 --ctl 19090
 *   MEOW_BIN=/path/to/meow node Tools/meow-verify.js /tmp/meow.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_PORT = 17890;
const DEFAULT_CTL = 19090;
const BOOT_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) {
      opts._.push(t);
      continue;
    }
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      opts[key] = next;
      i += 1;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`${urlPath} 返回非 JSON（HTTP ${res.statusCode}）`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${urlPath} 超时`)));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBoot(ctl, child, logs) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`进程提前退出（exit ${child.exitCode}）：\n${logs.join('').slice(-1200)}`);
    }
    try {
      const v = await getJson(ctl, '/version');
      if (v && v.version) return v;
    } catch {
      // 还没起来，继续轮询
    }
    await sleep(300);
  }
  throw new Error(`等待 ${BOOT_TIMEOUT_MS}ms 仍未就绪：\n${logs.join('').slice(-1200)}`);
}

// 离线 `-t` 阶段允许出现的告警：全部来自订阅节点自身或 offline 校验本身，
// 与「脚本生成的配置写错了」无关。出现清单外的新类别即判失败——这条是防止
// select 组带 url、未知键之类的问题悄悄回来（Docs/MeowRS适配方案.md 实证 #13）。
const ALLOWED_WARNINGS = [
  'payload unavailable, starting empty', // 仅 -t 离线校验：没有缓存
  'flow: xtls-rprx-vision applies to TCP only', // 节点自身 flow + udp 的固有差异
  'skip-cert-verify=true is ignored for Reality TLS',
  'skip-cert-verify=true: TLS certificate verification is disabled',
];

const ANSI = /\x1b\[[0-9;]*m/g;

/** 把日志切成「告警类别 → 条数」，proxy=/group=/sni= 这类实例名归一掉 */
function classifyWarnings(text) {
  const counts = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.replace(ANSI, '');
    const m = /^\S+\s+WARN\s+([\w:]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const msg = m[2]
      .replace(/proxy=\S+/g, '')
      .replace(/(group|snis?|sni)="?[^"\s]+"?/g, '')
      .replace(/rule-provider '[^']+'/g, 'rule-provider X')
      .replace(/\d+/g, 'N')
      .trim();
    const key = `${m[1]} | ${msg.slice(0, 120)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** 用 `strict: true` 跑一次离线校验：把「我们自己写进配置」的缺陷升级为硬错误 */
function offlineValidate(bin, cfg, tmpDir) {
  const strictCfg = { ...cfg, strict: true };
  const strictPath = path.join(tmpDir, 'config-strict.json');
  fs.writeFileSync(strictPath, JSON.stringify(strictCfg, null, 2), 'utf8');
  const r = require('child_process').spawnSync(bin, ['-f', strictPath, '-t', '-d', path.join(tmpDir, 'home-strict')], {
    encoding: 'utf8',
    timeout: 60000,
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`.replace(ANSI, '');
  return { status: r.status, text };
}

async function main(argv) {
  const opts = parseArgs(argv);
  const configPath = opts._[0];
  if (!configPath) {
    console.error('用法: node Tools/meow-verify.js <config.json> [--bin <meow>] [--port N] [--ctl N]');
    return 2;
  }

  const bin = opts.bin || process.env.MEOW_BIN || 'meow';
  const port = Number(opts.port || DEFAULT_PORT);
  const ctl = Number(opts.ctl || DEFAULT_CTL);

  const cfg = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));

  // 只改「会碰本机环境」的三项，其余保持产物原样（产物才是被测对象）
  cfg['mixed-port'] = port;
  cfg['external-controller'] = `127.0.0.1:${ctl}`;
  cfg['allow-lan'] = false;
  if (cfg.tun) cfg.tun.enable = false;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-verify-'));
  const tmpConfig = path.join(tmpDir, 'config.json');
  fs.writeFileSync(tmpConfig, JSON.stringify(cfg, null, 2), 'utf8');

  const preflight = [];
  const offline = offlineValidate(bin, cfg, tmpDir);
  if (offline.status !== 0) {
    console.error(`::error::strict 离线校验未通过（exit ${offline.status}）：`);
    for (const line of offline.text
      .split('\n')
      .filter((l) => /\bERROR\b/.test(l))
      .slice(0, 6)) {
      console.error(`  ${line.trim().slice(0, 180)}`);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return 1;
  }
  console.log('  strict 离线校验：通过（Class A 缺陷为 0）');

  const warnCounts = classifyWarnings(offline.text);
  const unexpected = [...warnCounts.entries()].filter(
    ([key]) => !ALLOWED_WARNINGS.some((allowed) => key.includes(allowed)),
  );
  if (unexpected.length > 0) {
    for (const [key, n] of unexpected) preflight.push(`清单外告警 ×${n}：${key}`);
  } else {
    const total = [...warnCounts.values()].reduce((a, b) => a + b, 0);
    console.log(`  告警清单：通过（${warnCounts.size} 类 / ${total} 条，均在允许清单内）`);
  }
  if (preflight.length > 0) {
    console.error(`::error::配置出现清单外告警 ${preflight.length} 类：`);
    for (const p of preflight) console.error(`  - ${p}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return 1;
  }

  const logs = [];
  const child = spawn(bin, ['-f', tmpConfig, '-d', path.join(tmpDir, 'home')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const cleanup = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论
    }
  };

  try {
    const version = await waitForBoot(ctl, child, logs);
    console.log(`  内核就绪：${version.version}（${bin}）`);

    const problems = [];

    const proxies = (await getJson(ctl, '/proxies')).proxies || {};
    for (const group of cfg['proxy-groups'] || []) {
      if (!proxies[group.name]) problems.push(`策略组未被内核接受：${group.name}`);
    }
    for (const proxy of cfg.proxies || []) {
      if (!proxies[proxy.name]) problems.push(`节点未被内核接受：${proxy.name}（${proxy.type}）`);
    }

    const rules = (await getJson(ctl, '/rules')).rules || [];
    const expectedRules = (cfg.rules || []).length;
    if (rules.length !== expectedRules) {
      problems.push(`规则数不符：配置 ${expectedRules} 条，内核接受 ${rules.length} 条（有规则被丢弃）`);
    }

    const text = logs.join('');
    for (const line of text.split('\n')) {
      if (/\bERROR\b/.test(line)) problems.push(`启动日志出现 ERROR：${line.trim().slice(0, 160)}`);
    }

    const proxyCount = Object.keys(proxies).length;
    const groupCount = (cfg['proxy-groups'] || []).length;
    const nodeCount = (cfg.proxies || []).length;
    console.log(
      `  策略组 ${groupCount} 个 / 节点 ${nodeCount} 个 / 规则 ${rules.length} 条 / 内核对象 ${proxyCount} 个`,
    );

    if (problems.length > 0) {
      console.error(`::error::内核验证失败 ${problems.length} 处：`);
      for (const p of problems) console.error(`  - ${p}`);
      return 1;
    }

    console.log('  内核验证：通过');
    return 0;
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 1;
  } finally {
    cleanup();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main };
