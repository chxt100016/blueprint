// init 的资产操作。拷贝一律用文件复制,不用模型生成。
// init 幂等:生成物无条件覆盖,定制物(config.yaml / lock.json / CONVENTIONS.md 等)已存在则保留。
// 母版迭代期靠重跑 init 刷新生成物,不另设 upgrade。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSafe, exists } from './parse.mjs';
import { bpPath } from './config.mjs';

export const BP_VERSION = '1.0.0';

export const SKILL_NAMES = [
  'pipeline', 'flow', 'activity', 'domain', 'code', 'commit',
];

/** 母版资产目录。只有 skill 包内的 bp.mjs 能找到它。 */
export function assetsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url)); // assets/scripts/lib
  const candidate = path.resolve(here, '..', '..');
  return exists(path.join(candidate, 'bp-assets.json')) ? candidate : null;
}

export function requireAssets() {
  const dir = assetsDir();
  if (!dir) {
    throw new Error('该命令需要从 blueprint skill 包内运行(项目内的 blueprint/scripts/bp.mjs 不含母版资产)');
  }
  return dir;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function renderSkill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

export function skillDir(root, name, project) {
  return path.join(root, '.claude', 'skills', `${name}-${project}`, 'SKILL.md');
}

/** 拷贝生成物。无条件覆盖。 */
export function installGenerated(root, { type, project }) {
  const assets = requireAssets();
  copyDir(path.join(assets, 'scripts'), bpPath(root, 'scripts'));
  fs.rmSync(bpPath(root, 'templates'), { recursive: true, force: true });
  copyDir(path.join(assets, 'templates', type), bpPath(root, 'templates'));
  write(bpPath(root, 'WORKFLOW.md'), renderSkill(readFileSafe(path.join(assets, 'WORKFLOW.md')), { PROJECT: project, TYPE: type, VERSION: BP_VERSION }));
  for (const name of SKILL_NAMES) {
    const tpl = readFileSafe(path.join(assets, 'skills', `${name}.md`));
    if (!tpl) throw new Error(`skill 母版缺失: ${name}.md`);
    write(skillDir(root, name, project), renderSkill(tpl, { PROJECT: project, TYPE: type, VERSION: BP_VERSION }));
  }
}

const CONFIG_DEFAULTS = {
  LAYOUT_BACKEND: 'src/modules/{capability}/',
  LAYOUT_FRONTEND: 'src/pages/{capability}/',
  LAYOUT_DOMAIN: 'src/domain/{name}/',
  VERIFY_BACKEND: 'npx tsc --noEmit',
  VERIFY_FRONTEND: 'npx tsc --noEmit',
  DB_DIALECT: 'postgres',
  DB_MIGRATION_TABLE: 'schema_migrations',
  VERSION: BP_VERSION,
  PROJECT: 'app',
};

/** 渲染 config.yaml 文本(保留注释)。 */
export function configText(type, opts = {}) {
  const assets = requireAssets();
  const raw = readFileSafe(path.join(assets, 'config', `${type}.yaml`));
  if (!raw) throw new Error(`缺少 config 骨架: ${type}.yaml`);
  const vars = {
    ...CONFIG_DEFAULTS,
    PROJECT: opts.project || CONFIG_DEFAULTS.PROJECT,
    VERSION: BP_VERSION,
  };
  for (const [k, v] of Object.entries(opts.layout || {})) if (v) vars[`LAYOUT_${k.toUpperCase()}`] = v;
  for (const [k, v] of Object.entries(opts.verify || {})) if (v) vars[`VERIFY_${k.toUpperCase()}`] = v;
  if (opts.db?.dialect) vars.DB_DIALECT = opts.db.dialect;
  if (opts.db?.migration_table) vars.DB_MIGRATION_TABLE = opts.db.migration_table;
  return renderSkill(raw, vars);
}


export function init(root, opts) {
  const { type, project } = opts;
  const assets = requireAssets();
  const created = [];

  installGenerated(root, { type, project });
  created.push('blueprint/scripts/', 'blueprint/templates/', 'blueprint/WORKFLOW.md', '.claude/skills/*-' + project + '/');

  // config.yaml:骨架 + 交互得到的值
  const cfgFile = bpPath(root, 'config.yaml');
  if (!exists(cfgFile)) {
    write(cfgFile, configText(type, opts));
    created.push('blueprint/config.yaml');
  }

  for (const dir of ['product', 'spec', 'domain', 'codemap', 'context', 'snapshot', 'todo/done']) {
    fs.mkdirSync(bpPath(root, ...dir.split('/')), { recursive: true });
  }
  if (!exists(bpPath(root, 'lock.json'))) {
    write(bpPath(root, 'lock.json'), JSON.stringify({
      version: 3, blueprint_version: BP_VERSION, services: {}, activities: {}, domains: {}, rejected_domains: {},
    }, null, 2) + '\n');
    created.push('blueprint/lock.json');
  }
  for (const [src, dest] of [
    ['context-README.md', bpPath(root, 'context', 'README.md')],
    ['CONVENTIONS.md', bpPath(root, 'CONVENTIONS.md')],
  ]) {
    if (!exists(dest)) {
      write(dest, renderSkill(readFileSafe(path.join(assets, src)) || '', { PROJECT: project, TYPE: type }));
      created.push(path.relative(root, dest));
    }
  }

  // .gitignore
  const giFile = path.join(root, '.gitignore');
  const gi = readFileSafe(giFile) || '';
  const entries = ['blueprint/context/db.yaml', 'blueprint/lock.json.tmp'];
  const missing = entries.filter((e) => !gi.split('\n').some((l) => l.trim() === e));
  if (missing.length) {
    write(giFile, (gi ? gi.replace(/\n*$/, '\n') : '') + '\n# blueprint\n' + missing.join('\n') + '\n');
    created.push('.gitignore(追加)');
  }

  return created;
}

