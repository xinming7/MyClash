#!/usr/bin/env node
/**
 * 校验文档里的「文件:行号」引用是否仍指向预期的代码。
 *
 * 为什么需要它：`AGENTS.md` 里有一批行号引用（`Script/mihomoScript.js:1262` 这类）。
 * 每次同步上游、每次删减补丁，脚本行数都会变，行号就悄悄指向别的代码——文档不会报错，
 * 但下次照着它去改的人（或 AI）会被带到错误的位置。2026-11-03 那次同步，18 处引用里
 * 有 10 处是手工重算的，纯靠肉眼，漏一处也没人知道。
 *
 * 机制：
 *  - 文档里允许出现裸行号，但**必须先登记**到 `Tools/lib/doc-refs.json`，并给出特征串（needle）。
 *  - 特征串必须**从被引用的那一行开始**。校验只看「行号所指的那一行是否仍是特征串的起点」，
 *    所以行号漂了但内容还在原处 → 报错并能自动修回；内容真被删/改名 → 报错且拒绝自动修改。
 *  - 特征串可以跨多行：同一段代码有多处相似写法时（如 `...vgCfGroupNames,` 出现 5 次），
 *    把后面几行一起带上就能唯一确定，比「猜行号」可靠。
 *  - `--fix` 只在**全文件唯一命中**时改写行号，0 处或多处一律跳过交给人判断。
 *    宁可少改，也不要把引用改到一个「看起来像」的错误位置。
 *
 * 用法：
 *   node Tools/check-doc-refs.js            # 校验，未登记的裸行号只警告
 *   node Tools/check-doc-refs.js --strict   # 未登记的裸行号也算失败（CI 用）
 *   node Tools/check-doc-refs.js --fix      # 先按特征串修正唯一命中的引用，再校验
 *   node Tools/check-doc-refs.js --json     # 机器可读输出
 *
 * 退出码：0 通过；1 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAP_PATH = path.join(ROOT, 'Tools', 'lib', 'doc-refs.json');

// 扫描范围：根目录与 Test/Tools 下的所有 .md。Script/Config 目录不放文档。
const SCAN_DIRS = ['.', 'Test', 'Tools'];

// 只认「像文件路径 + 行号」的形式，避免把 `:80`、`v1.7.0` 之类误判。
const REF_RE = /([A-Za-z0-9_.\-\/]+\.(?:js|json|ya?ml|md)):(\d+)(?:-(\d+))?/g;

const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const FIX = args.has('--fix');
const JSON_OUT = args.has('--json');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rel = (p) => path.relative(ROOT, p) || p;

function listMarkdown() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const abs = dir === '.' ? ROOT : path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.md')) continue;
      out.push(dir === '.' ? f : `${dir}/${f}`);
    }
  }
  return out.sort();
}

// 缓存：一份文件既可能被多个引用指向，也可能在 --fix 前后各读一次
const textCache = new Map();
function textOf(file) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return null;
  if (!textCache.has(file)) textCache.set(file, fs.readFileSync(abs, 'utf8'));
  return textCache.get(file);
}

function lineCount(file) {
  const t = textOf(file);
  return t == null ? 0 : t.split('\n').length;
}

/** 文本偏移 → 行号（1-based） */
function lineAt(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** 特征串所有命中位置的起始行号；文件不存在返回 null。 */
function startsOf(file, needle) {
  const text = textOf(file);
  if (text == null) return null;
  const out = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i < 0) break;
    out.push(lineAt(text, i));
    from = i + 1; // 允许重叠命中，避免漏掉紧邻的重复片段
  }
  return out;
}

function splitRef(ref) {
  const m = ref.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  return { file: m[1], start: Number(m[2]), end: Number(m[3] || m[2]) };
}

function readMap() {
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  return { note: raw.note, refs: raw.refs || [] };
}

/** 文档里出现、但校验表里没登记的引用。 */
function collectRefs(mdFiles) {
  const seen = new Map(); // ref -> Set<md>
  for (const md of mdFiles) {
    const text = textOf(md);
    for (const m of text.matchAll(REF_RE)) {
      if (!seen.has(m[0])) seen.set(m[0], new Set());
      seen.get(m[0]).add(md);
    }
  }
  return seen;
}

function applyFix(map, mdFiles) {
  const log = [];
  let changed = 0;

  for (const entry of map.refs) {
    const parsed = splitRef(entry.ref);
    if (!parsed) continue;
    const starts = startsOf(parsed.file, entry.needle);
    if (starts == null) {
      log.push(`跳过 ${entry.ref}：文件不存在`);
      continue;
    }
    if (starts.length === 0) {
      log.push(`跳过 ${entry.ref}：特征串已不存在（代码被删或改名，需人工判断新位置）`);
      continue;
    }
    if (starts.length > 1) {
      log.push(`跳过 ${entry.ref}：特征串命中 ${starts.length} 处（行 ${starts.join('、')}），需人工确认`);
      continue;
    }
    const target = starts[0];
    if (target === parsed.start) continue;

    // 保持区间宽度：`29-30` 修正后仍是两行
    const width = parsed.end - parsed.start;
    const newRef = width > 0 ? `${parsed.file}:${target}-${target + width}` : `${parsed.file}:${target}`;
    const oldRef = entry.ref;
    const re = new RegExp(escapeRe(oldRef) + '(?!\\d)', 'g');

    for (const md of mdFiles) {
      const abs = path.join(ROOT, md);
      const text = fs.readFileSync(abs, 'utf8');
      if (!re.test(text)) continue;
      fs.writeFileSync(abs, text.replace(re, newRef));
      log.push(`${md}: ${oldRef} → ${newRef}`);
    }
    entry.ref = newRef;
    changed++;
  }

  if (changed > 0) fs.writeFileSync(MAP_PATH, JSON.stringify({ note: map.note, refs: map.refs }, null, 2) + '\n');
  return { changed, log };
}

function validate(map, mdFiles) {
  const registered = new Map(map.refs.map((e) => [e.ref, e]));
  const found = collectRefs(mdFiles);
  const problems = [];

  for (const [ref, mds] of found) {
    const where = [...mds].join(', ');
    const parsed = splitRef(ref);
    if (!parsed) continue;

    const total = lineCount(parsed.file);
    if (!textOf(parsed.file)) {
      problems.push({ level: 'error', ref, where, msg: `文件不存在：${parsed.file}` });
      continue;
    }
    if (parsed.start < 1 || parsed.end < parsed.start) {
      problems.push({ level: 'error', ref, where, msg: '行号区间非法' });
      continue;
    }
    if (parsed.end > total) {
      problems.push({ level: 'error', ref, where, msg: `行号越界：${parsed.file} 只有 ${total} 行` });
      continue;
    }

    const entry = registered.get(ref);
    if (!entry) {
      problems.push({
        level: STRICT ? 'error' : 'warn',
        ref,
        where,
        msg: '未登记的行号引用（登记后才有特征串校验，见 Tools/lib/doc-refs.json）',
      });
      continue;
    }

    const starts = startsOf(parsed.file, entry.needle) || [];
    if (!starts.includes(parsed.start)) {
      problems.push({
        level: 'error',
        ref,
        where,
        msg:
          `该行已不是特征串起点（期望以 ${JSON.stringify(entry.needle.split('\n')[0])} 开头）。` +
          (starts.length === 0
            ? '特征串在全文中已不存在。'
            : starts.length === 1
              ? `特征串现在在 ${parsed.file}:${starts[0]}，可运行 --fix。`
              : `特征串另有 ${starts.length} 处（行 ${starts.join('、')}），需人工确认。`),
      });
    }
  }

  // 表里有、文档里已删的条目：不算错误，只提示清理，避免校验表无限膨胀
  const stale = map.refs.filter((e) => !found.has(e.ref)).map((e) => e.ref);
  return { problems, stale, total: found.size };
}

function main() {
  if (!fs.existsSync(MAP_PATH)) {
    console.error(`::error::找不到校验表 ${rel(MAP_PATH)}`);
    return 1;
  }

  const map = readMap();
  const mdFiles = listMarkdown();
  let fixed = 0;
  let fixLog = [];

  if (FIX) {
    const r = applyFix(map, mdFiles);
    fixed = r.changed;
    fixLog = r.log;
    textCache.clear(); // 文档被改写过，缓存必须失效
  }

  const { problems, stale, total } = validate(map, mdFiles);
  const errors = problems.filter((p) => p.level === 'error');
  const warns = problems.filter((p) => p.level === 'warn');

  if (JSON_OUT) {
    console.log(JSON.stringify({ fixed, fixLog, total, errors, warns, stale }, null, 2));
    return errors.length > 0 ? 1 : 0;
  }

  if (FIX) {
    console.log(fixed > 0 ? `已修正 ${fixed} 处引用：` : '没有可自动修正的引用：');
    for (const l of fixLog) console.log(`  ${l}`);
    console.log('');
  }

  if (errors.length === 0 && warns.length === 0) {
    console.log(`✔ 文档引用校验通过：${total} 处行号引用，全部指向预期代码`);
  } else {
    for (const p of problems) console.log(`${p.level === 'error' ? '✘' : '⚠'} ${p.ref}（${p.where}）：${p.msg}`);
    console.log(`\n共 ${total} 处引用：${errors.length} 个错误、${warns.length} 个警告`);
  }

  if (stale.length > 0) console.log(`ℹ 校验表里 ${stale.length} 条已不在文档中出现，可清理：${stale.join('、')}`);

  // GitHub Actions 里让失败原因直接出现在注解区
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const p of errors) console.error(`::error::${p.ref}：${p.msg}`);
  }

  return errors.length > 0 ? 1 : 0;
}

process.exit(main());
