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

/**
 * 把一份模板解析成该文档类型的章节表与字段白名单:
 * 二级标题的文字与顺序即章节表,front-matter 的键即允许出现的字段。
 *
 * 模板正文里没有别的东西——哈希取材与编号前缀这类附加规则在 config.mjs 的
 * SECTION_RULES 里,不写进模板:模板的每一个字都会跟着骨架落进产出文档。
 */
export function parseTemplateSpec(raw) {
  const { fm, hasFm, body } = parseFrontMatter(raw);
  const { sections } = splitSections(body);
  return {
    titles: sections.map((s) => s.title),
    fmFields: hasFm ? Object.keys(fm) : [],
  };
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

/** 取「业务活动」条目:`- <slug>  <说明>` */
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

/**
 * 取「领域依赖」条目:一个 `###` 一个领域模型,标题即 `<domainId>`,
 * 其下两行 `- 输入:` 与 `- 输出:`。它是活动引用领域模型的唯一出处——
 * front-matter 不再有 uses,登记与契约合在一处,两边就不会不一致。
 */
export function parseDomainDeps(body) {
  const out = [];
  let cur = null;
  let fence = false;
  for (const line of String(body ?? '').split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) { cur = { id: h3[1].trim(), input: null, output: null, line: null }; out.push(cur); continue; }
    if (!cur) continue;
    const inp = line.match(/^\s*-\s*输入\s*[:：]\s*(.*)$/);
    if (inp) { cur.input = inp[1].trim(); continue; }
    const oup = line.match(/^\s*-\s*输出\s*[:：]\s*(.*)$/);
    if (oup) cur.output = oup[1].trim();
  }
  return out;
}

/**
 * 取编号章节的编号序列。prefix 由 config.mjs 的 SECTION_RULES 给出。
 *
 * 三种写法都认:裸行 `A1 ...`、列表项 `- A1 ...`、表格首列 `| I1 | ... |`。
 * 表格那种是必需的——聚合的不变量与命令每条有五六个属性,写成列表读不了。
 */
export function parseRules(body, prefix = 'R') {
  const p = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:\\|\\s*)?(?:[-*]\\s*)?\\*{0,2}${p}(\\d+)\\*{0,2}[\\s.:、|]`);
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
