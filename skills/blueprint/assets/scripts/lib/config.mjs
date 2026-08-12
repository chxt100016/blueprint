// config.yaml 的读取、环境变量插值与作用域推导。
//
// 两个「能力」分属不同层,词不通用:
//   商业能力 capability  product/<capability>.md,是业务服务的归属域
//   领域能力 domain      domain/<domain>/<name>/domain.md,跨服务复用的横切层
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, readFileSafe, parseTemplateSpec } from './parse.mjs';

export const BP_DIR = 'blueprint';

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
    throw new Error(`找不到 ${path.relative(process.cwd(), file)},先运行 bp init`);
  }
  const cfg = parseYaml(raw) || {};
  cfg.type = cfg.type || 'backend';
  cfg.layout = cfg.layout || {};
  cfg.overrides = cfg.overrides || {};
  cfg.verify = cfg.verify || {};
  cfg.always_readable = cfg.always_readable || [];
  cfg.db = cfg.db || {};
  cfg.commit = cfg.commit || {};
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
  if (cfg.type === 'frontend') return ['frontend'];
  return ['backend', 'frontend'];
}

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

/**
 * 由 id 推导代码作用域目录。
 * 活动 id:`<capability>.<service>.<activity>`;领域能力 id:`@<domain>.<name>`。
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

/** id 层级:capability | service | activity | domain */
export function idKind(id) {
  if (isDomainId(id)) return 'domain';
  const parts = String(id).split('.');
  if (parts.length === 1) return 'capability';
  if (parts.length === 2) return 'service';
  if (parts.length === 3) return 'activity';
  return 'unknown';
}
