// 外部 HTTP 接口的采样与快照。发请求靠系统自带的 curl:人在 context 里贴什么就原样
// 发什么,脚本不重组请求——curl 的 flag 变体太多,解析不全会静默丢参数,发出去的东西
// 跟人贴的不是一回事。这里的解析只用来渲染快照里的参数表,解析失败也不影响采样。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFrontMatter, splitSections, extractFences, readFileSafe, listDirs, listFiles } from './parse.mjs';
import { bpPath } from './config.mjs';

const STATUS_MARK = '__BP_HTTP_STATUS__';
const SAMPLE_TIMEOUT = 30000;
// 数组只看前几个元素:同一个数组里的元素结构一致,全展开只会让字段表出现
// items[0] items[1] 这种重复行。
const ARRAY_PROBE = 3;

// ------------------------------------------------------------------ context

/** `${VAR}` 取环境变量,取不到就留着字面量交给 sh——采样失败比中断整轮更好定位。 */
function softInterpolate(text) {
  return String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => process.env[name] ?? m);
}

export function rpcContextDir(root) {
  return bpPath(root, 'context', 'rpc');
}

export function rpcId(capability, system, title) {
  return `${capability}.${system}.${title}`;
}

/**
 * 读一份 context 文件。一个 `##` 一个接口:标题是接口名,标题下首段是概要,
 * ```curl 围栏是请求原文,围栏之外的文字是人工备注(值域、坑),原样搬进快照。
 */
export function readRpcContext(file) {
  const raw = readFileSafe(file);
  if (raw === null) return null;
  const { fm, body } = parseFrontMatter(raw);
  const { sections } = splitSections(body);
  const interfaces = [];
  for (const section of sections) {
    const fences = extractFences(section.body);
    const curl = fences.find((f) => f.lang === 'curl');
    const rest = section.body.replace(/^\s*```+[\s\S]*?```+\s*$/gm, '').trim();
    const [summary, ...notes] = rest.split(/\n{2,}/);
    interfaces.push({
      title: section.title,
      summary: (summary || '').trim(),
      notes: notes.join('\n\n').trim(),
      curl: curl ? curl.code.trim() : null,
      unsupported: !curl && fences.length ? fences[0].lang || '(无语言标记)' : null,
    });
  }
  return { fm, interfaces };
}

/** context/rpc 下的全部文件,一个 capability 一层目录。 */
export function listRpcContext(root, filter = {}) {
  const dir = rpcContextDir(root);
  const out = [];
  for (const capability of listDirs(dir)) {
    if (filter.capability && filter.capability !== capability) continue;
    for (const name of listFiles(path.join(dir, capability))) {
      if (!name.endsWith('.md') || name === 'README.md') continue;
      const system = name.replace(/\.md$/, '');
      if (filter.system && filter.system !== system) continue;
      out.push({
        capability,
        system,
        file: path.join(dir, capability, name),
        rel: path.join('blueprint', 'context', 'rpc', capability, name),
      });
    }
  }
  return out;
}

// -------------------------------------------------------------- curl 解析

/** 切成 shell 风格的 token,只处理引号与续行,够用来取 url / -H / -d。 */
function tokenize(text) {
  const source = String(text).replace(/\\\r?\n/g, ' ');
  const tokens = [];
  let current = '';
  let quote = null;
  let quoted = false;
  for (const ch of source) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; continue; }
    if (/\s/.test(ch)) {
      if (current || quoted) { tokens.push(current); current = ''; quoted = false; }
      continue;
    }
    current += ch;
  }
  if (current || quoted) tokens.push(current);
  return tokens;
}

// 带值的 flag:它们的值不能被当成 url
const VALUE_FLAGS = new Set([
  '-u', '--user', '-o', '--output', '-A', '--user-agent', '-e', '--referer',
  '-b', '--cookie', '-c', '--cookie-jar', '-m', '--max-time', '--connect-timeout',
  '--cert', '--key', '--proxy', '--retry', '-w', '--write-out', '-T', '--upload-file',
]);
const BODY_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode']);

export function parseCurl(text) {
  const tokens = tokenize(text);
  const headers = [];
  let method = null;
  let url = null;
  let body = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'curl') continue;
    if (token === '-X' || token === '--request') { method = tokens[++i]; continue; }
    if (token === '-H' || token === '--header') { headers.push(tokens[++i]); continue; }
    if (BODY_FLAGS.has(token)) { body = tokens[++i]; continue; }
    if (token === '--url') { url = tokens[++i]; continue; }
    if (VALUE_FLAGS.has(token)) { i++; continue; }
    if (token.startsWith('-')) continue;
    if (!url) url = token;
  }
  return { method: method || (body ? 'POST' : 'GET'), url: url || '', headers, body };
}

/** 请求参数表的行。path 参数认不出来(不知道 /orders/A1001 里哪段是参数),整条留在 URL 行。 */
function requestRows(parsed) {
  const rows = [];
  try {
    const url = new URL(parsed.url);
    for (const [name, value] of url.searchParams) {
      rows.push({ name, in: 'query', type: typeName(scalarOf(value)), value });
    }
  } catch { /* url 里带 ${VAR} 之类时解析不了,跳过 query */ }
  for (const header of parsed.headers) {
    const at = header.indexOf(':');
    if (at === -1) continue;
    rows.push({ name: header.slice(0, at).trim(), in: 'header', type: 'string', value: header.slice(at + 1).trim() });
  }
  if (parsed.body) {
    let json = null;
    try { json = JSON.parse(parsed.body); } catch { /* 非 JSON body 整条放一行 */ }
    if (json && typeof json === 'object') {
      for (const [name, value] of Object.entries(json)) {
        rows.push({ name, in: 'body', type: typeName(value), value: display(value) });
      }
    } else {
      rows.push({ name: '(原文)', in: 'body', type: 'string', value: parsed.body });
    }
  }
  return rows;
}

function scalarOf(text) {
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === 'true' || text === 'false') return text === 'true';
  return text;
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function display(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// -------------------------------------------------------------- 响应展平

/** 把响应体压成「字段路径 → 类型 / 值」。数组路径带 `[]`。 */
function flatten(value, prefix, into) {
  if (Array.isArray(value)) {
    record(into, prefix, 'array', null);
    for (const item of value.slice(0, ARRAY_PROBE)) flatten(item, `${prefix}[]`, into);
    return;
  }
  if (value && typeof value === 'object') {
    if (prefix) record(into, prefix, 'object', null);
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, into);
    }
    return;
  }
  record(into, prefix, typeName(value), value);
}

function record(into, field, type, value) {
  if (!field) return;
  if (!into.has(field)) into.set(field, { types: new Set(), values: [] });
  const entry = into.get(field);
  entry.types.add(type);
  // 标量才记 observed:对象与数组记进去只是一堆 [object Object]
  if (value !== null && value !== undefined && typeof value !== 'object') {
    if (!entry.values.includes(value)) entry.values.push(value);
  }
}

// -------------------------------------------------------------- 采样与合并

function sample(curlText) {
  const command = `${softInterpolate(curlText)} --silent --show-error --write-out '\\n${STATUS_MARK}%{http_code}'`;
  const raw = execFileSync('sh', ['-c', command], {
    encoding: 'utf8',
    timeout: SAMPLE_TIMEOUT,
    maxBuffer: 16 * 1024 * 1024,
  });
  const at = raw.lastIndexOf(STATUS_MARK);
  if (at === -1) return { status: null, text: raw.trim() };
  return { status: Number(raw.slice(at + STATUS_MARK.length).trim()) || null, text: raw.slice(0, at).trim() };
}

/** 把一次采样并进历史。历史存在旁路 json 里,md 是从它渲染出来的。 */
function merge(previous, current) {
  const merged = {
    samples: (previous?.samples || 0) + 1,
    last_at: current.at,
    last_status: current.status,
    method: current.method,
    url: current.url,
    request: current.request,
    response: { ...(previous?.response || {}) },
    body_text: current.fields ? null : current.text,
  };
  if (!current.fields) return merged;
  for (const [field, entry] of current.fields) {
    const old = merged.response[field] || { types: [], seen: 0, values: [] };
    const values = [...old.values];
    for (const value of entry.values) if (!values.includes(value)) values.push(value);
    merged.response[field] = {
      types: [...new Set([...old.types, ...entry.types])],
      seen: old.seen + 1,
      values,
    };
  }
  return merged;
}

// -------------------------------------------------------------- 快照读写

export function rpcSnapshotDir(root) {
  return bpPath(root, 'snapshot', 'rpc');
}

function dataFile(root, capability, system) {
  return path.join(rpcSnapshotDir(root), capability, `${system}.json`);
}

function docFile(root, capability, system) {
  return path.join(rpcSnapshotDir(root), capability, `${system}.md`);
}

function readData(file) {
  const raw = readFileSafe(file);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function renderDoc(entry, at) {
  const lines = [
    `<!-- generated by bp snapshot pull rpc at ${at}, do not edit -->`,
    '',
    `# ${entry.system}`,
    '',
    `来源 ${entry.source}`,
    '',
  ];
  for (const item of entry.interfaces) {
    lines.push(`## ${item.title}`, '');
    if (item.summary) lines.push(item.summary, '');
    if (!item.data) {
      lines.push(`- 采样  未成功:${item.error || '还没采集过'}`, '');
      continue;
    }
    const data = item.data;
    lines.push(`- URL   ${data.method} ${data.url}`);
    lines.push(`- 采样  ${data.last_at} · ${data.last_status ?? '无状态码'} · 累计 ${data.samples} 次`);
    if (item.error) lines.push(`- 本次  采样失败,以下是上一次的结果:${item.error}`);
    lines.push('');
    if (data.request?.length) {
      lines.push('### 请求参数', '', '| 参数 | 位置 | 类型 | 值 |', '|---|---|---|---|');
      for (const row of data.request) {
        lines.push(`| ${row.name} | ${row.in} | ${row.type} | ${cell(row.value)} |`);
      }
      lines.push('');
    }
    const fields = Object.entries(data.response || {});
    if (fields.length) {
      lines.push('### 响应参数', '', '| 字段 | 类型 | 必现 | observed |', '|---|---|---|---|');
      for (const [field, info] of fields) {
        const observed = info.values.map((v) => cell(v)).join(', ');
        lines.push(`| ${field} | ${info.types.join('\\|')} | ${info.seen}/${data.samples} | ${observed} |`);
      }
      lines.push('');
    } else if (data.body_text) {
      lines.push('### 响应原文', '', '```', data.body_text.slice(0, 2000), '```', '');
    }
    if (item.notes) lines.push('### 人工备注', '', item.notes, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** 表格单元:竖线与换行会把 md 表格撑破。 */
function cell(value) {
  return display(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * 采样一份 context 文件并写快照。单个接口失败不影响同文件的其他接口:
 * 失败的那个保留上一次的数据,只在文档里标一行。
 */
export function pullRpcFile(root, target, at) {
  const context = readRpcContext(target.file);
  if (!context) return { ok: 0, failed: [`${target.rel} 读不到`] };
  const previous = readData(dataFile(root, target.capability, target.system));
  const store = { generated_at: at, source: target.rel, interfaces: {} };
  const entry = { system: target.system, source: target.rel, interfaces: [] };
  const failed = [];
  let ok = 0;

  for (const item of context.interfaces) {
    const old = previous?.interfaces?.[item.title] || null;
    const node = { title: item.title, summary: item.summary, notes: item.notes, data: old, error: null };
    if (!item.curl) {
      node.error = item.unsupported ? `围栏语言是 ${item.unsupported},只支持 curl` : '这一节没有 ```curl 围栏';
      failed.push(`${item.title}:${node.error}`);
    } else if (!/^\s*curl\s/.test(item.curl)) {
      node.error = '围栏内容不是以 curl 开头';
      failed.push(`${item.title}:${node.error}`);
    } else {
      try {
        const result = sample(item.curl);
        const parsed = parseCurl(item.curl);
        const fields = new Map();
        let parsedBody = null;
        try { parsedBody = JSON.parse(result.text); } catch { /* 非 JSON 响应保留原文 */ }
        if (parsedBody !== null) flatten(parsedBody, '', fields);
        node.data = merge(old, {
          at,
          status: result.status,
          method: parsed.method.toUpperCase(),
          url: parsed.url,
          request: requestRows(parsed),
          fields: parsedBody === null ? null : fields,
          text: result.text,
        });
        node.error = null;
        ok++;
      } catch (error) {
        node.error = String(error?.message || error).split('\n')[0];
        failed.push(`${item.title}:${node.error}`);
      }
    }
    if (node.data) store.interfaces[item.title] = node.data;
    entry.interfaces.push(node);
  }

  const doc = docFile(root, target.capability, target.system);
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.writeFileSync(doc, renderDoc(entry, at));
  fs.writeFileSync(dataFile(root, target.capability, target.system), JSON.stringify(store, null, 2) + '\n');
  return { ok, failed };
}

/** 快照里的全部接口,list 与 show 都走这里。 */
export function listRpcSnapshot(root, filter = {}) {
  const dir = rpcSnapshotDir(root);
  const out = [];
  for (const capability of listDirs(dir)) {
    if (filter.capability && filter.capability !== capability) continue;
    for (const name of listFiles(path.join(dir, capability))) {
      if (!name.endsWith('.md')) continue;
      const system = name.replace(/\.md$/, '');
      const file = path.join(dir, capability, name);
      const { sections } = splitSections(readFileSafe(file) || '');
      const data = readData(dataFile(root, capability, system));
      for (const section of sections) {
        const info = data?.interfaces?.[section.title] || null;
        out.push({
          id: rpcId(capability, system, section.title),
          capability,
          system,
          title: section.title,
          summary: (section.body.split('\n').find((line) => line.trim() && !line.startsWith('-')) || '').trim(),
          method: info?.method || '',
          url: info?.url || '',
          at: info?.last_at || '',
          samples: info?.samples || 0,
          raw: section.raw,
          file,
          rel: path.join('blueprint', 'snapshot', 'rpc', capability, name),
        });
      }
    }
  }
  return out;
}
