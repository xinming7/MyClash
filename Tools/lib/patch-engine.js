'use strict';

/**
 * 行级补丁引擎
 *
 * 设计目标：把「用 grep/sed 手工改上游脚本」变成可重复执行、可失败上报的声明式操作。
 *
 * 三条铁律：
 *  1. 幂等：每个补丁先查 marker，命中即视为已注入并跳过，重复执行不会重复插入。
 *  2. 不猜：锚点缺失或锚点不唯一一律报错，绝不静默跳过——静默跳过会让脚本看起来
 *     "注入成功"却少了一整块功能，比直接报错危险得多。
 *  3. 原子：单个文件内任一补丁失败，该文件不落盘，避免产出半注入的半成品。
 *
 * 锚点匹配采用「逐行 trim 比较」而不是整文件正则：上游 prettier 重排缩进不影响匹配，
 * 同时比较连续多行可以唯一定位到目标块，避免误伤同名片段。
 */

const fs = require('fs');
const path = require('path');

class PatchError extends Error {
  constructor(message, patchId) {
    super(message);
    this.name = 'PatchError';
    this.patchId = patchId;
  }
}

/**
 * 依据文件名判断目标身份（脚本全量版 / 精简版，静态配置全量版 / 精简版）。
 *
 * 2026-11-13 起把 `Config/*.yaml` 也纳入派生体系：上游平均每 10 个提交有 8 个会动
 * Config，而本 fork 在这两个文件里各有两处固定改动（头部链接、QUIC 屏蔽启用）。
 * 不纳入的话，上游只要改到那几行就是 git 冲突 → L2 人工；纳入后可由 L1 取上游侧重建。
 */
const FLAVOR_LABELS = {
  full: '全量版脚本',
  lite: '精简版脚本',
  'config-full': '全量版配置',
  'config-lite': '精简版配置',
};

function flavorOf(filePath) {
  const base = path.basename(filePath);
  if (base === 'mihomoScript.js') return 'full';
  if (base === 'Script.js') return 'lite';
  if (base === 'mihomoConfig.yaml') return 'config-full';
  if (base === 'mihomoConfigLite.yaml') return 'config-lite';
  throw new PatchError(
    `无法识别的目标文件：${base}（只支持 mihomoScript.js / Script.js / mihomoConfig.yaml / mihomoConfigLite.yaml）`,
  );
}

/** 供日志用的可读标签 */
function flavorLabel(flavor) {
  return FLAVOR_LABELS[flavor] || flavor;
}

/**
 * 特性是否适用于该目标。
 *
 * `target` 缺省视为 `script`（保持历史行为，老特性不必逐个加字段）：
 * 脚本补丁只跑在两个脚本上，配置补丁只跑在两个 Config 上，互不串门。
 * 串门的后果很严重——脚本补丁的锚点在 YAML 里必然找不到，会让整个文件注入失败。
 */
function featureAppliesTo(feature, flavor) {
  const target = flavor.startsWith('config') ? 'config' : 'script';
  if ((feature.target || 'script') !== target) return false;
  if (feature.only && feature.only !== flavor) return false;
  return true;
}

/** 允许补丁字段写成字符串，或写成 { full, lite } 按目标脚本取值 */
function resolve(value, flavor, patchId, field) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value;
  if (value instanceof RegExp) return value;
  if (value && typeof value === 'object') {
    const picked = value[flavor];
    if (picked === undefined) {
      throw new PatchError(`补丁未提供 ${flavor} 版本${field ? `（${field}）` : ''}`, patchId);
    }
    return picked;
  }
  throw new PatchError(`补丁字段类型不支持：${field || '?'}`, patchId);
}

/**
 * 在行数组中查找锚点，返回所有命中行的下标。
 *
 * - 默认：连续多行「整行 trim 后相等」，可唯一定位代码块，且不受 prettier 缩进影响。
 * - substring=true：单行内子串匹配。用于「只绑一段稳定片段」的场景，例如返回值对象里
 *   `, finalRuleProviders, directGroup };` 这种字段列表尾部——上游往列表中间加字段
 *   （2026-11-02 就加了 functionalIpRules）时，整行锚点会整条失效，尾部锚点不受影响。
 *   片段仍必须唯一，命中多行照样报错，不会静默误改。
 */
function findAll(lines, anchorLines, substring = false) {
  const needle = anchorLines.map((s) => String(s).trim());
  const hits = [];

  if (substring) {
    const frag = needle[0];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(frag)) hits.push(i);
    }
    return hits;
  }

  for (let i = 0; i + needle.length <= lines.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (lines[i + j].trim() !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) hits.push(i);
  }
  return hits;
}

/**
 * 把 anchor 规整成「候选列表」：每项 { lines, text? }，按顺序尝试，取第一个唯一命中的。
 *
 * 支持四种写法：
 *  - 'a'                          → 单个单行候选
 *  - ['a', 'b']                   → 单个多行候选
 *  - [['a','b'], ['c']]           → 多个候选，共用补丁级 text
 *  - [{ anchor: [...], text: 'x' }] → 多个候选，各自携带替换文本
 *
 * 多候选是为「上游重排同一段代码」准备的：2026-11-02 上游把 main() 里的
 * buildFunctionalGroups 调用从 5 行折成 2 行，并新增 functionalIpRules 字段。
 * 两种形态需要的替换文本不同（旧形态没有该字段，不能凭空插入），故支持候选级 text。
 */
function toCandidates(anchor) {
  if (typeof anchor === 'string') return [{ lines: [anchor] }];
  if (!Array.isArray(anchor)) throw new PatchError('anchor 必须是字符串或数组');

  const isSpecList =
    anchor.length > 0 && anchor.every((x) => x && typeof x === 'object' && !Array.isArray(x) && x.anchor);
  if (isSpecList) {
    return anchor.map((spec) => ({
      lines: Array.isArray(spec.anchor) ? spec.anchor : [spec.anchor],
      text: spec.text,
    }));
  }

  const isCandidateList = anchor.length > 0 && anchor.every((x) => Array.isArray(x));
  if (isCandidateList) return anchor.map((lines) => ({ lines }));

  return [{ lines: anchor }];
}

/**
 * 应用单个补丁。
 * @returns {{status:'applied'|'skipped', detail?:string}}
 */
function applyPatch(lines, patch, flavor) {
  // 同一特性在不同版本结构可能不同（例如单行数组 vs 多行数组），未提供该版本写法的补丁直接不适用
  if (patch.only && patch.only !== flavor) return { status: 'na', detail: `仅适用于${patch.only}版` };

  const marker = resolve(patch.marker, flavor, patch.id, 'marker');
  if (marker && marker.test(lines.join('\n'))) {
    return { status: 'skipped', detail: '已存在' };
  }

  const op = patch.op;
  if (!['insertBefore', 'insertAfter', 'replace'].includes(op)) {
    throw new PatchError(`未知补丁操作：${op}`, patch.id);
  }

  const anchor = resolve(patch.anchor, flavor, patch.id, 'anchor');
  const candidates = toCandidates(anchor);
  const baseText = patch.text == null ? null : resolve(patch.text, flavor, patch.id, 'text');

  // 子串锚点只做「行内片段替换」：语义简单，越界风险小；插入类操作仍须用整行锚点
  const substring = patch.substring === true;
  if (substring) {
    if (op !== 'replace') throw new PatchError('substring 锚点只支持 replace 操作', patch.id);
    if (candidates.length !== 1 || candidates[0].lines.length !== 1) {
      throw new PatchError('substring 锚点只能写一行片段', patch.id);
    }
  }

  // 按顺序试每个候选，取第一个唯一命中的。命中多处仍然报错——候选之间不允许互相掩盖歧义。
  let matched = null;
  for (const cand of candidates) {
    const hits = findAll(lines, cand.lines, substring);
    if (hits.length > 1) {
      throw new PatchError(
        `锚点不唯一（命中 ${hits.length} 处），需补充上下文行以唯一定位：\n        ${cand.lines[0].trim()}`,
        patch.id,
      );
    }
    if (hits.length === 1) {
      matched = { idx: hits[0], lines: cand.lines, text: cand.text };
      break;
    }
  }
  if (!matched) {
    const hint = candidates.map((c) => `        ${c.lines[0].trim()}`).join('\n');
    throw new PatchError(`锚点未找到，上游可能改动了这段代码，需人工确认后更新锚点：\n${hint}`, patch.id);
  }

  // 候选可携带自己的替换文本（同一处代码在不同上游形态下需要的产物不同）
  const text = matched.text == null ? baseText : resolve(matched.text, flavor, patch.id, 'text');
  if (text == null) throw new PatchError('补丁缺少 text（补丁级与候选级都没有）', patch.id);
  if (substring && text.includes('\n')) throw new PatchError('substring 锚点的 text 必须是单行片段', patch.id);

  const idx = matched.idx;
  const anchorLines = matched.lines;
  if (substring) {
    // 只替换命中行里的那个片段，行的其余部分（前缀、缩进）原样保留
    const frag = anchorLines[0].trim();
    lines[idx] = lines[idx].replace(frag, text);
  } else if (op === 'insertBefore') {
    const newLines = text.split('\n');
    lines.splice(idx, 0, ...newLines);
  } else if (op === 'insertAfter') {
    const newLines = text.split('\n');
    lines.splice(idx + anchorLines.length, 0, ...newLines);
  } else {
    const newLines = text.split('\n');
    lines.splice(idx, anchorLines.length, ...newLines);
  }

  return { status: 'applied', detail: anchorLines[0].trim().slice(0, 48) };
}

/** 判断某个特性的所有补丁是否都已生效（供 verify / compare 使用） */
function featureStatus(lines, feature, flavor) {
  const src = lines.join('\n');
  const applicable = feature.patches.filter((p) => !p.only || p.only === flavor);
  let present = 0;
  const missing = [];
  for (const patch of applicable) {
    const marker = resolve(patch.marker, flavor, patch.id, 'marker');
    if (marker && marker.test(src)) present += 1;
    else missing.push(patch.id);
  }
  return { total: applicable.length, present, missing, ok: present === applicable.length };
}

/**
 * 对一段文本应用全部特性（不落盘）。replay 用它把「上游原版」在内存里注入后比对，
 * 避免为了验证而在工作区里来回改文件。
 * @returns {{features:[{id,title,ok,patches:[{id,status,detail}]}], applied:number, skipped:number, failed:number, content?:string}}
 */
function applyFeaturesToContent(content, flavor, features, options = {}) {
  const lines = content.split('\n');

  const report = { features: [], applied: 0, skipped: 0, failed: 0 };
  let failed = false;

  for (const feature of features) {
    if (!featureAppliesTo(feature, flavor)) continue;
    if (options.only && !options.only.includes(feature.id)) continue;

    const featureReport = { id: feature.id, title: feature.title, ok: true, patches: [] };
    for (const patch of feature.patches) {
      try {
        const r = applyPatch(lines, patch, flavor);
        featureReport.patches.push({ id: patch.id, why: patch.why, ...r });
        if (r.status === 'applied') report.applied += 1;
        else if (r.status === 'skipped') report.skipped += 1;
      } catch (err) {
        featureReport.ok = false;
        featureReport.patches.push({ id: patch.id, why: patch.why, status: 'failed', detail: err.message });
        report.failed += 1;
        failed = true;
        if (!options.keepGoing) break;
      }
    }
    report.features.push(featureReport);
    if (failed && !options.keepGoing) break;
  }

  if (!failed) report.content = lines.join('\n');
  return report;
}

/**
 * 处理单个文件：应用全部特征。
 * content 只有全部补丁成功时才存在——调用方据此决定是否写盘（原子性）。
 * @returns {{file, flavor, features, applied, skipped, failed, content?:string}}
 */
function applyFeaturesToFile(filePath, features, options = {}) {
  const flavor = flavorOf(filePath);
  const original = fs.readFileSync(filePath, 'utf8');
  const report = applyFeaturesToContent(original, flavor, features, options);
  return { file: filePath, flavor, ...report };
}

module.exports = {
  PatchError,
  flavorOf,
  flavorLabel,
  featureAppliesTo,
  applyPatch,
  applyFeaturesToContent,
  applyFeaturesToFile,
  featureStatus,
  findAll,
  toCandidates,
};
