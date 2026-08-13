// config.yaml 的读取、环境变量插值与作用域推导。
//
// 两个「能力」分属不同层,词不通用:
//   商业能力 capability  product/<capability>.md,是业务服务的归属域
//   领域能力 domain      domain/<domain>/<name>/domain.md,跨服务复用的横切层
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, readFileSafe, parseTemplateSpec } from './parse.mjs';

export const BP_DIR = 'blueprint';

// id 第三段的层级标记。加它是为了让 id 自解释:业务流程与业务活动都挂在服务下,
// 若共用一个三段命名空间,解析 id 就得先查 repo 才知道是哪一层,
// 而 status / read / delete 这些命令在 validate 之前就要解析 id,重名校验拦不住那个时间差。
export const FLOW_MARK = 'flow';
export const ACTIVITY_MARK = 'activity';

export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, BP_DIR, 'config.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function bpPath(root, ...rest) {
  return path.join(root, BP_DIR, ...rest);
}

export function loadConfig(root) {
  const file = bpPath(root, 'config.yaml');
  const raw = readFileSafe(file);
  if (raw === null) {
    throw new Error(`找不到 ${path.relative(process.cwd(), file)},先用 blueprint skill 初始化`);
  }
  const cfg = parseYaml(raw) || {};
  cfg.type = cfg.type || 'backend';
  cfg.layout = cfg.layout || {};
  cfg.overrides = cfg.overrides || {};
  cfg.verify = cfg.verify || {};
  cfg.always_readable = cfg.always_readable || [];
  cfg.templates = loadTemplateSpec(root);
  return cfg;
}

const TEMPLATE_FILES = { flow: 'flow.md', activity: 'activity.md', domain: 'domain.md' };

/**
 * 读 blueprint/templates/ 下的模板,推导各文档类型的章节表、哈希章节与编号规则。
 * 模板缺失或没有章节时直接报错——静默回退到内置默认值会让校验与模板悄悄脱节。
 */
export function loadTemplateSpec(root) {
  const out = {};
  for (const [kind, file] of Object.entries(TEMPLATE_FILES)) {
    const p = bpPath(root, 'templates', file);
    const raw = readFileSafe(p);
    if (raw === null) {
      throw new Error(`找不到模板 ${path.relative(process.cwd(), p)},重跑 blueprint skill 的 init 可补齐`);
    }
    const spec = parseTemplateSpec(raw);
    if (!spec.titles.length) {
      throw new Error(`模板 blueprint/templates/${file} 中没有二级标题章节`);
    }
    out[kind] = spec;
  }
  return out;
}

/** ${XXX} 环境变量插值,取不到则报错;不含占位符的原样返回。 */
export function interpolate(str) {
  return String(str).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined || v === '') throw new Error(`环境变量 ${name} 未设置`);
    return v;
  });
}

/** 该 config.type 下需要产出的作用域。 */
export function scopesOfType(cfg) {
  if (cfg.type === 'backend') return ['backend'];
  return ['backend', 'frontend'];
}

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

/**
 * 由 id 推导代码作用域目录。
 * 活动 id:`<capability>.<service>.activity.<name>`;领域能力 id:`@<domain>.<name>`。
 * 只取前两段,标记段与活动名都不参与——代码目录按服务组织,不按流程。
 */
export function resolveScope(cfg, id) {
  if (isDomainId(id)) {
    const [, name] = splitDomainId(id);
    const tpl = cfg.layout.domain;
    if (!tpl) return {};
    return { domain: ensureSlash(fill(tpl, { name })) };
  }
  const [capability, service] = String(id).split('.');
  const override = cfg.overrides?.[capability] || {};
  const out = {};
  for (const key of scopesOfType(cfg)) {
    const tpl = override[key] || cfg.layout[key];
    if (tpl) out[key] = ensureSlash(fill(tpl, { capability, service: service || '' }));
  }
  return out;
}

function ensureSlash(p) {
  return p.endsWith('/') ? p : p + '/';
}

/** `@<domain>.<name>` → [domain, name];不合法返回 [null, null]。 */
export function splitDomainId(id) {
  const m = String(id).match(/^@([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)$/);
  if (!m) return [null, null];
  return [m[1], m[2]];
}

export function isDomainId(id) {
  return String(id).startsWith('@');
}

/** id 层级:capability | service | flow | activity | domain */
export function idKind(id) {
  if (isDomainId(id)) return 'domain';
  const parts = String(id).split('.');
  if (parts.length === 1) return 'capability';
  if (parts.length === 2) return 'service';
  if (parts.length === 4 && parts[2] === FLOW_MARK) return 'flow';
  if (parts.length === 4 && parts[2] === ACTIVITY_MARK) return 'activity';
  return 'unknown';
}

/** `<cap>.<svc>.<mark>.<name>` → [capability, service, mark, name];不合法返回 []。 */
export function splitUnitId(id) {
  const parts = String(id).split('.');
  if (parts.length !== 4) return [];
  if (parts[2] !== FLOW_MARK && parts[2] !== ACTIVITY_MARK) return [];
  return parts;
}

/** 由 id 推导文档路径(相对 blueprint/)。路径里不含标记段。 */
export function idToSpecPath(id) {
  const [capability, service, mark, name] = splitUnitId(id);
  if (!capability) return null;
  if (mark === FLOW_MARK) return path.join('spec', capability, service, `${name}.md`);
  return path.join('spec', capability, service, name, 'activity.md');
}

/** 活动/流程 id 的所属服务 id。 */
export function serviceOf(id) {
  const parts = String(id).split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null;
}
