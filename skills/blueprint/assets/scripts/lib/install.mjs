// init / upgrade / doctor 的资产操作。拷贝一律用文件复制,不用模型生成。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, toYamlFile, readFileSafe, exists, walkFiles } from './parse.mjs';
import { sha256 } from './hash.mjs';
import { bpPath } from './config.mjs';

export const BP_VERSION = '1.0.0';

export const SKILL_NAMES = [
  'pipeline', 'flow', 'review-flow', 'activity', 'review-activity',
  'domain', 'code', 'lock', 'commit',
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

function generatedFiles(root, project) {
  const files = [];
  for (const f of walkFiles(bpPath(root, 'scripts'))) files.push(f);
  for (const f of walkFiles(bpPath(root, 'templates'))) files.push(f);
  const workflow = bpPath(root, 'WORKFLOW.md');
  if (exists(workflow)) files.push(workflow);
  for (const name of SKILL_NAMES) {
    const f = skillDir(root, name, project);
    if (exists(f)) files.push(f);
  }
  return files;
}

export function writeManifest(root, project) {
  const manifest = { blueprint_version: BP_VERSION, project, generated_at: new Date().toISOString(), files: {} };
  for (const f of generatedFiles(root, project)) {
    manifest.files[path.relative(root, f).split(path.sep).join('/')] = sha256(readFileSafe(f) || '');
  }
  write(bpPath(root, '.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function readManifest(root) {
  const raw = readFileSafe(bpPath(root, '.manifest.json'));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 拷贝生成物。init 与 upgrade 共用。 */
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
  LAYOUT_BACKEND: 'src/modules/{domain}/',
  LAYOUT_FRONTEND: 'src/pages/{domain}/',
  LAYOUT_DOMAIN: 'src/domain/{capability}/',
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

export function configSkeleton(type) {
  return parseYaml(configText(type)) || {};
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
      version: 2, blueprint_version: BP_VERSION, services: {}, activities: {}, capabilities: {},
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

  writeManifest(root, project);
  return created;
}

/** config.yaml 字段级合并:已有值保留,新增字段带默认值追加。 */
export function mergeConfig(root, type) {
  const file = bpPath(root, 'config.yaml');
  const text = readFileSafe(file) || '';
  const current = parseYaml(text) || {};
  const skeleton = configSkeleton(type);
  const added = [];
  const chunks = [];
  for (const key of Object.keys(skeleton)) {
    if (!(key in current)) {
      added.push(key);
      chunks.push(toYamlFile({ [key]: skeleton[key] }).trimEnd());
      continue;
    }
    const sub = skeleton[key];
    if (sub && typeof sub === 'object' && !Array.isArray(sub) && current[key] && typeof current[key] === 'object') {
      for (const k2 of Object.keys(sub)) {
        if (!(k2 in current[key])) added.push(`${key}.${k2}`);
      }
    }
  }
  let next = text;
  if (chunks.length) {
    next = next.replace(/\n*$/, '\n') + `\n# --- added by bp upgrade v${BP_VERSION} ---\n` + chunks.join('\n') + '\n';
  }
  // blueprint_version 由脚本维护,不留给人手改
  if (/^blueprint_version:/m.test(next)) {
    next = next.replace(/^blueprint_version:.*$/m, `blueprint_version: "${BP_VERSION}"`);
  } else {
    next = next.replace(/\n*$/, '\n') + `\nblueprint_version: "${BP_VERSION}"\n`;
  }
  if (next !== text) fs.writeFileSync(file, next);
  return added;
}

export function upgrade(root, { project, type, oldProject }) {
  if (oldProject && oldProject !== project) {
    for (const name of SKILL_NAMES) {
      fs.rmSync(path.dirname(skillDir(root, name, oldProject)), { recursive: true, force: true });
    }
  }
  installGenerated(root, { type, project });
  const added = mergeConfig(root, type);
  writeManifest(root, project);
  return added;
}

export function doctor(root, project) {
  const problems = [];
  const manifest = readManifest(root);
  if (!manifest) {
    problems.push({ level: 'warn', msg: '缺少 blueprint/.manifest.json,无法校验生成物是否被手改' });
  } else {
    for (const [rel, hash] of Object.entries(manifest.files)) {
      const file = path.join(root, rel);
      if (!exists(file)) { problems.push({ level: 'error', msg: `生成物缺失: ${rel}` }); continue; }
      if (sha256(readFileSafe(file)) !== hash) {
        problems.push({ level: 'error', msg: `生成物被手改: ${rel}(升级会覆盖,定制请改 config.yaml)` });
      }
    }
  }
  for (const dir of ['product', 'spec', 'domain', 'codemap', 'context', 'snapshot', 'todo', 'templates', 'scripts']) {
    if (!exists(bpPath(root, dir))) problems.push({ level: 'error', msg: `目录缺失: blueprint/${dir}/` });
  }
  for (const f of ['config.yaml', 'lock.json', 'CONVENTIONS.md', 'WORKFLOW.md']) {
    if (!exists(bpPath(root, f))) problems.push({ level: 'error', msg: `文件缺失: blueprint/${f}` });
  }
  for (const name of SKILL_NAMES) {
    if (!exists(skillDir(root, name, project))) {
      problems.push({ level: 'error', msg: `skill 缺失: .claude/skills/${name}-${project}/SKILL.md` });
    }
  }
  return problems;
}
