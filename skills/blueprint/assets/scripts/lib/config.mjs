// config.yaml 的读取、环境变量插值与作用域推导。
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, readFileSafe } from './parse.mjs';

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
  return cfg;
}

/** ${XXX} 环境变量插值,取不到则报错;不含占位符的原样返回。 */
export function interpolate(str) {
  return String(str).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined || v === '') throw new Error(`环境变量 ${name} 未设置`);
    return v;
  });
}

/** 活动含「交互」章节的条件。 */
export function hasUiSection(cfg) {
  return cfg.type === 'frontend' || cfg.type === 'fullstack';
}

export function activitySectionTitles(cfg) {
  const base = ['时序图', '触发条件', '输入输出'];
  if (hasUiSection(cfg)) base.push('交互');
  return [...base, '行为规则', '非目标', '边界情况', '实现提示'];
}

export const ACTIVITY_HASHED_SECTIONS = (cfg) =>
  activitySectionTitles(cfg).filter((t) => t !== '实现提示');

export const FLOW_SECTIONS = ['流程图', '流程', '分支与异常', '活动划分'];
export const CAPABILITY_SECTIONS = ['职责', '契约', '行为规则', '边界情况', '实现提示'];
export const CAPABILITY_HASHED_SECTIONS = ['职责', '契约', '行为规则', '边界情况'];

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
 * 活动 id:`<domain>.<service>.<activity>`;能力 id:`@<domain>.<capability>`。
 */
export function resolveScope(cfg, id) {
  if (String(id).startsWith('@')) {
    const [, capability] = splitCapabilityId(id);
    const tpl = cfg.layout.domain;
    if (!tpl) return {};
    return { domain: ensureSlash(fill(tpl, { capability })) };
  }
  const [domain, service] = String(id).split('.');
  const override = cfg.overrides?.[domain] || {};
  const out = {};
  for (const key of scopesOfType(cfg)) {
    const tpl = override[key] || cfg.layout[key];
    if (tpl) out[key] = ensureSlash(fill(tpl, { domain, service: service || '' }));
  }
  return out;
}

function ensureSlash(p) {
  return p.endsWith('/') ? p : p + '/';
}

export function splitCapabilityId(id) {
  const m = String(id).match(/^@([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)$/);
  if (!m) return [null, null];
  return [m[1], m[2]];
}

export function isCapabilityId(id) {
  return String(id).startsWith('@');
}

/** id 层级:domain | service | activity | capability */
export function idKind(id) {
  if (isCapabilityId(id)) return 'capability';
  const parts = String(id).split('.');
  if (parts.length === 1) return 'domain';
  if (parts.length === 2) return 'service';
  if (parts.length === 3) return 'activity';
  return 'unknown';
}
