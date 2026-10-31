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

/** 依据文件名判断脚本版本（全量版 / 精简版） */
function flavorOf(filePath) {
  const base = path.basename(filePath);
  if (base === 'mihomoScript.js') return 'full';
  if (base === 'Script.js') return 'lite';
  throw new PatchError(`无法识别的脚本：${base}（只支持 mihomoScript.js / Script.js）`);
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

/** 在行数组中查找连续多行锚点，返回所有起始下标 */
function findAll(lines, anchorLines) {
  const needle = anchorLines.map((s) => String(s).trim());
  const hits = [];
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
  const text = resolve(patch.text, flavor, patch.id, 'text');
  const anchorLines = Array.isArray(anchor) ? anchor : [anchor];

  const hits = findAll(lines, anchorLines);
  if (hits.length === 0) {
    throw new PatchError(
      `锚点未找到，上游可能改动了这段代码，需人工确认后更新锚点：\n        ${anchorLines[0].trim()}`,
      patch.id,
    );
  }
  if (hits.length > 1) {
    throw new PatchError(
      `锚点不唯一（命中 ${hits.length} 处），需补充上下文行以唯一定位：\n        ${anchorLines[0].trim()}`,
      patch.id,
    );
  }

  const idx = hits[0];
  const newLines = text.split('\n');
  if (op === 'insertBefore') lines.splice(idx, 0, ...newLines);
  else if (op === 'insertAfter') lines.splice(idx + anchorLines.length, 0, ...newLines);
  else lines.splice(idx, anchorLines.length, ...newLines);

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
    if (feature.only && feature.only !== flavor) continue;
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
  applyPatch,
  applyFeaturesToContent,
  applyFeaturesToFile,
  featureStatus,
  findAll,
};
