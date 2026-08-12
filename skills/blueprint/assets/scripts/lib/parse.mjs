// md 与 front-matter 的解析。零外部依赖,只实现本规范用到的 YAML 子集。
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- YAML 子集

function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
      (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitFlow(s.slice(1, -1)).map(parseScalar);
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

// 拆 flow 数组的元素,尊重引号
function splitFlow(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

// 把 `key: value` 拆成 [key, value],尊重引号与 URL 中的冒号
function splitKey(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ':' && (i + 1 >= text.length || /[\s]/.test(text[i + 1]))) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return null;
}

/** 去掉行内注释。引号内的 `#` 与紧贴前一个字符的 `#`(URL 片段、锚点引用)不算注释。 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function toLines(text) {
  const out = [];
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    if (/^\s*#/.test(raw)) continue;
    if (raw.trim() === '---') continue;
    const line = stripComment(raw);
    if (!line.trim()) continue;
    out.push({ indent: line.match(/^ */)[0].length, text: line.trim() });
  }
  return out;
}

function parseNode(lines, i, indent) {
  if (i >= lines.length) return [null, i];
  if (lines[i].text.startsWith('- ')) return parseSeq(lines, i, indent);
  return parseMap(lines, i, indent);
}

function parseSeq(lines, i, indent) {
  const out = [];
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
    const body = lines[i].text.slice(2).trim();
    const kv = splitKey(body);
    if (kv) {
      // 序列项是一个 map,首个键与后续同缩进的键同属一项
      const childIndent = lines[i].indent + 2;
      const virtual = [{ indent: childIndent, text: body }];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= childIndent) {
        virtual.push(lines[j]);
        j++;
      }
      out.push(parseMap(virtual, 0, childIndent)[0]);
      i = j;
    } else if (body === '') {
      const [val, next] = parseNode(lines, i + 1, lines[i + 1]?.indent ?? indent + 2);
      out.push(val);
      i = next;
    } else {
      out.push(parseScalar(body));
      i++;
    }
  }
  return [out, i];
}

function parseMap(lines, i, indent) {
  const out = {};
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
    const kv = splitKey(lines[i].text);
    if (!kv) { i++; continue; }
    const [key, rest] = kv;
    if (rest !== '') {
      out[key] = parseScalar(rest);
      i++;
      continue;
    }
    const childIndent = i + 1 < lines.length ? lines[i + 1].indent : -1;
    if (childIndent > indent) {
      const [val, next] = parseNode(lines, i + 1, childIndent);
      out[key] = val;
      i = next;
    } else if (childIndent === indent && lines[i + 1]?.text.startsWith('- ')) {
      // 序列与其键同缩进
      const [val, next] = parseSeq(lines, i + 1, indent);
      out[key] = val;
      i = next;
    } else {
      out[key] = null;
      i++;
    }
  }
  return [out, i];
}

export function parseYaml(text) {
  const lines = toLines(text);
  if (!lines.length) return {};
  const [val] = parseNode(lines, 0, lines[0].indent);
  return val ?? {};
}

function needQuote(s) {
  return s === '' || /^[\s]|[\s]$|[:#\[\]{}",]|^[-?&*!|>%@`]/.test(s) ||
    /^(true|false|null|~)$/.test(s) || /^-?\d+(\.\d+)?$/.test(s);
}

export function dumpYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return needQuote(value) ? JSON.stringify(value) : value;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '\n' + value.map((v) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const inner = dumpYaml(v, indent + 2).replace(/^\n/, '');
        return pad + '- ' + inner.slice(indent + 2);
      }
      return pad + '- ' + dumpYaml(v, indent + 2);
    }).join('\n');
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  return '\n' + keys.map((k) => {
    const v = dumpYaml(value[k], indent + 2);
    return pad + k + ':' + (v.startsWith('\n') ? v : ' ' + v);
  }).join('\n');
}

export function toYamlFile(obj) {
  return dumpYaml(obj, 0).replace(/^\n/, '') + '\n';
}

// ---------------------------------------------------------- front-matter

export function parseFrontMatter(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return { fm: {}, fmRaw: '', body: text, hasFm: false };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, fmRaw: '', body: text, hasFm: false };
  const fmRaw = text.slice(4, end + 1);
  const rest = text.slice(end + 4).replace(/^\n/, '');
  return { fm: parseYaml(fmRaw) || {}, fmRaw, body: rest, hasFm: true };
}

// --------------------------------------------------------------- 章节切分

/** 按二级标题切分,忽略围栏代码块内的 `##`。 */
export function splitSections(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let fence = null;
  let cur = null;
  let preamble = [];
  lines.forEach((line, idx) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const mark = fenceMatch[1][0].repeat(3);
      if (!fence) fence = mark;
      else if (line.trim().startsWith(fence)) fence = null;
    }
    const h2 = !fence && line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (cur) sections.push(cur);
      cur = { title: h2[1].trim(), line: idx + 1, lines: [] };
      return;
    }
    if (cur) cur.lines.push(line);
    else preamble.push(line);
  });
  if (cur) sections.push(cur);
  return {
    preamble: preamble.join('\n'),
    sections: sections.map((s) => ({
      title: s.title,
      line: s.line,
      body: s.lines.join('\n').trim(),
      raw: `## ${s.title}\n${s.lines.join('\n')}`.trim(),
    })),
  };
}

export function sectionTitles(sections) {
  return sections.map((s) => s.title);
}

export function findSection(sections, title) {
  return sections.find((s) => s.title === title) || null;
}

/** 取若干章节的连续原文,用于哈希。 */
export function sectionsText(sections, titles) {
  return titles
    .map((t) => findSection(sections, t))
    .filter(Boolean)
    .map((s) => s.raw)
    .join('\n\n');
}

// --------------------------------------------------------------- 模板规格

/** 取章节体开头的 `<!-- bp: ... -->` 标记。 */
function parseSectionMeta(body) {
  const out = {};
  const m = String(body ?? '').match(/<!--\s*bp:\s*(.+?)\s*-->/);
  if (!m) return out;
  for (const tok of m[1].split(/[,\s]+/).filter(Boolean)) {
    const [k, v] = tok.split('=');
    if (k === 'no-hash') out.noHash = true;
    else if (k === 'numbered') out.numbered = v || 'R';
  }
  return out;
}

/**
 * 把一份模板解析成该文档类型的校验规格。模板是章节结构与编号规则的唯一真相源,
 * 校验、哈希取材、编号前缀全部由此推导——改模板即改校验,不必动代码。
 *
 * 章节标记写在二级标题下的 HTML 注释里:
 *   <!-- bp: no-hash -->       该章节不参与哈希(如「实现提示」)
 *   <!-- bp: numbered=A -->    该章节需形如 A1 A2 的连续编号
 *
 * front-matter 的键即允许出现的字段;`entry` 的子键即该 type 下必填的入口。
 */
export function parseTemplateSpec(raw) {
  const { fm, hasFm, body } = parseFrontMatter(raw);
  const { sections } = splitSections(body);
  const titles = [];
  const hashed = [];
  let numbered = null;
  for (const s of sections) {
    titles.push(s.title);
    const meta = parseSectionMeta(s.body);
    if (!meta.noHash) hashed.push(s.title);
    if (meta.numbered) numbered = { section: s.title, prefix: meta.numbered };
  }
  const fmFields = hasFm ? Object.keys(fm) : [];
  const entry = fm && typeof fm.entry === 'object' && fm.entry ? Object.keys(fm.entry) : [];
  return { titles, hashed, numbered, fmFields, entryFields: entry };
}

// ----------------------------------------------------------------- mermaid

export function extractFences(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  let cur = null;
  for (const line of lines) {
    const open = line.match(/^\s*```+\s*(\w*)\s*$/);
    if (!cur && open) { cur = { lang: open[1] || '', lines: [] }; continue; }
    if (cur && /^\s*```+\s*$/.test(line)) { out.push({ lang: cur.lang, code: cur.lines.join('\n') }); cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  return out;
}

/** 取「流程」章节的顶层有序步骤文本(缩进项为分支说明,不算步骤)。 */
export function parseOrderedSteps(body) {
  const out = [];
  let fence = false;
  for (const line of String(body ?? '').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = line.match(/^(\d+)\.\s+(.+?)\s*$/);
    if (m) out.push({ no: Number(m[1]), text: m[2].trim() });
  }
  return out;
}

/** 取「活动划分」条目:`- <slug>  <summary>` */
export function parseActivityList(body) {
  const out = [];
  for (const line of String(body ?? '').split('\n')) {
    const m = line.match(/^\s*-\s+([a-z0-9][a-z0-9-]*)\s{2,}(.+?)\s*$/);
    if (m) { out.push({ slug: m[1], summary: m[2].trim() }); continue; }
    const loose = line.match(/^\s*-\s+(\S+)\s+(.+?)\s*$/);
    if (loose) out.push({ slug: loose[1], summary: loose[2].trim(), loose: true });
  }
  return out;
}

/** 取编号章节的编号序列。prefix 由模板的 `numbered=` 标记给出。 */
export function parseRules(body, prefix = 'R') {
  const p = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\*{0,2}${p}(\\d+)\\*{0,2}[\\s.:、]`);
  const out = [];
  let fence = false;
  for (const line of String(body ?? '').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = line.match(re);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/** 取契约/输入输出表格的首列字段名。 */
export function parseTableFirstColumn(body) {
  const out = [];
  let seenHeader = false;
  for (const line of String(body ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(t)) { seenHeader = true; continue; }
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (!cells.length) continue;
    if (!seenHeader) continue;
    const name = cells[0].replace(/[`*]/g, '').trim();
    if (name) out.push(name);
  }
  return out;
}

// ------------------------------------------------------------------- 工具

export function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

export function listFiles(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

export function walkFiles(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}
