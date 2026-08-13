// snapshot 的导出与比对。连库靠系统自带的 CLI(psql / pg_dump / mysql / sqlite3),
// 脚本本身仍然零 npm 依赖。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseYaml, toYamlFile, readFileSafe, listFiles, exists } from './parse.mjs';
import { bpPath, interpolate } from './config.mjs';
import { sha256 } from './hash.mjs';

// -------------------------------------------------------------- snapshot 读

/** 解析 DDL 取列名。脚本自己生成的 DDL 格式可控,人工放置的常见写法也能覆盖。 */
export function parseColumns(ddl) {
  const cols = [];
  const text = String(ddl ?? '');
  const m = text.match(/CREATE\s+TABLE[^(]*\(([\s\S]*)\)[^)]*;/i);
  if (!m) return cols;
  const body = m[1];
  let depth = 0;
  let cur = '';
  const parts = [];
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;
    if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|KEY|INDEX)\b/i.test(line)) continue;
    const nameMatch = line.match(/^["`\[]?([A-Za-z_][\w$]*)["`\]]?\s+(.+)$/s);
    if (nameMatch) cols.push({ name: nameMatch[1], type: nameMatch[2].split(/\s+/)[0].replace(/,$/, '') });
  }
  return cols;
}

export function loadSnapshot(root) {
  const dir = bpPath(root, 'snapshot');
  const indexRaw = readFileSafe(path.join(dir, 'INDEX.yaml'));
  const index = indexRaw ? parseYaml(indexRaw) : null;
  const tables = new Map();
  const tableDir = path.join(dir, 'db', 'tables');
  for (const name of listFiles(tableDir)) {
    if (!name.endsWith('.sql')) continue;
    const ddl = readFileSafe(path.join(tableDir, name));
    const table = name.replace(/\.sql$/, '');
    tables.set(table, { table, file: path.join(tableDir, name), ddl, columns: parseColumns(ddl) });
  }
  return { exists: !!index || tables.size > 0, index, tables, dir };
}

/** 比对单个对象的 tables 声明与 snapshot。 */
export function gapsFor(snap, decl) {
  const gaps = [];
  for (const t of decl.tables || []) {
    if (!t || !t.name) continue;
    const table = snap.tables.get(t.name);
    if (!table) {
      gaps.push({ kind: 'table', table: t.name, by: decl.id, detail: '表不存在' });
      continue;
    }
    const have = new Set(table.columns.map((c) => c.name.toLowerCase()));
    for (const col of (t.columns || [])) {
      if (!have.has(String(col).toLowerCase())) {
        gaps.push({ kind: 'column', table: t.name, column: col, by: decl.id, detail: 'schema 中不存在' });
      }
    }
  }
  return gaps;
}

/** 比对 tables 声明与 snapshot。返回缺口清单。 */
export function checkTables(root, declarations, snap = null) {
  const s = snap || loadSnapshot(root);
  const gaps = [];
  for (const decl of declarations) gaps.push(...gapsFor(s, decl));
  return { gaps, snapshotExists: s.exists };
}

// -------------------------------------------------------------- snapshot 写

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function splitStatements(sql) {
  const out = [];
  let cur = '';
  let inStr = null;
  let inDollar = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inDollar) {
      cur += ch;
      if (sql.startsWith(inDollar, i)) { cur += sql.slice(i + 1, i + inDollar.length); i += inDollar.length - 1; inDollar = null; }
      continue;
    }
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    const dollar = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
    if (dollar) { inDollar = dollar[0]; cur += dollar[0]; i += dollar[0].length - 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; cur += ch; continue; }
    if (ch === ';') { out.push(cur.trim() + ';'); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

const TABLE_PATTERNS = [
  /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i,
  /^ALTER\s+TABLE\s+(?:ONLY\s+)?([^\s]+)/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+.*?\sON\s+(?:ONLY\s+)?([^\s(]+)/i,
  /^COMMENT\s+ON\s+(?:TABLE|COLUMN)\s+([^\s.]+\.[^\s.]+)/i,
];

function tableOf(stmt) {
  for (const re of TABLE_PATTERNS) {
    const m = stmt.match(re);
    if (m) return stripQualifier(m[1]);
  }
  return null;
}

function stripQualifier(name) {
  const parts = String(name).replace(/["`]/g, '').split('.');
  return parts[parts.length - 1].replace(/[();]/g, '');
}

/** 从 url 的 scheme 认数据库类型。dump 命令本来就按 scheme 解析 url,不再单独配一份。 */
function dialectOf(url) {
  const scheme = String(url).split(':')[0].toLowerCase();
  if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres';
  if (scheme === 'mysql' || scheme === 'mariadb') return 'mysql';
  if (scheme === 'sqlite' || scheme === 'file') return 'sqlite';
  throw new Error(`无法从 url 识别数据库类型: ${scheme}://,支持 postgres|mysql|sqlite`);
}

/** 导出全库 schema 到 snapshot。 */
export function pull(root) {
  const dbConf = parseYaml(readFileSafe(bpPath(root, 'context', 'db.yaml')) || '') || {};
  const main = dbConf.main;
  if (!main || !main.url) throw new Error('context/db.yaml 中缺少 main.url');
  const url = interpolate(main.url);
  const dialect = dialectOf(url);

  let sql;
  if (dialect === 'postgres') {
    sql = run('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', url]);
  } else if (dialect === 'mysql') {
    sql = run('mysqldump', ['--no-data', '--skip-comments', '--skip-add-drop-table', urlToMysqlArgs(url)].flat());
  } else {
    sql = run('sqlite3', [url.replace(/^(sqlite|file):\/\//, ''), '.schema']);
  }

  const statements = splitStatements(sql);
  const byTable = new Map();
  for (const stmt of statements) {
    const table = tableOf(stmt);
    if (!table) continue;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(stmt);
  }
  if (!byTable.size) throw new Error('未从导出结果中解析出任何表');

  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const tableDir = bpPath(root, 'snapshot', 'db', 'tables');
  fs.rmSync(tableDir, { recursive: true, force: true });
  fs.mkdirSync(tableDir, { recursive: true });

  const index = { generated_at: at, tables: {} };
  const summary = [`# 数据库结构摘要`, '', `导出于 ${at}`, ''];

  for (const [table, stmts] of [...byTable].sort((a, b) => a[0].localeCompare(b[0]))) {
    const header = `-- generated by bp schema pull at ${at}, do not edit\n`;
    const content = header + stmts.join('\n\n') + '\n';
    fs.writeFileSync(path.join(tableDir, `${table}.sql`), content);
    index.tables[table] = { file: `db/tables/${table}.sql`, hash: sha256(content) };
    const cols = parseColumns(stmts.find((s) => /^CREATE\s+TABLE/i.test(s)) || '');
    summary.push(`## ${table}`, '');
    summary.push('| 列 | 类型 |', '|---|---|');
    for (const c of cols) summary.push(`| ${c.name} | ${c.type} |`);
    // 约束只列 CREATE TABLE 之外的语句(ALTER TABLE ADD CONSTRAINT / CREATE INDEX),
    // 列内联的 PRIMARY KEY 已经体现在类型列里,重复列出只会让摘要变噪音
    const keys = stmts
      .filter((s) => !/^CREATE\s+TABLE/i.test(s.trim()))
      .filter((s) => /PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX/i.test(s));
    if (keys.length) {
      summary.push('', '约束与索引:');
      for (const k of keys) summary.push(`- ${k.replace(/\s+/g, ' ').replace(/;$/, '').trim()}`);
    }
    summary.push('');
  }

  fs.writeFileSync(bpPath(root, 'snapshot', 'db', 'schema.md'), summary.join('\n'));
  fs.writeFileSync(bpPath(root, 'snapshot', 'INDEX.yaml'), toYamlFile(index));
  return { tables: [...byTable.keys()], at };
}

function urlToMysqlArgs(url) {
  const u = new URL(url);
  const args = ['-h', u.hostname, '-P', u.port || '3306', '-u', decodeURIComponent(u.username)];
  if (u.password) args.push(`-p${decodeURIComponent(u.password)}`);
  args.push(u.pathname.replace(/^\//, ''));
  return args;
}

export function snapshotTableFile(root, table) {
  const p = bpPath(root, 'snapshot', 'db', 'tables', `${table}.sql`);
  return { path: p, exists: exists(p) };
}
