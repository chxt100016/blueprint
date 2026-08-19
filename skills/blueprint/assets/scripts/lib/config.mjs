// config.yaml 的读取、环境变量插值与作用域推导。
//
// 两个「能力」分属不同层,词不通用:
//   商业能力 capability  product/<capability>/,是业务服务的归属目录
//   领域模型 domain      domain/<domain>/<name>/domain.md,跨服务复用的横切层。
//                        两类:聚合 aggregate 持有表的读写权,领域服务 service 只读表
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, readFileSafe, parseTemplateSpec } from './parse.mjs';
import { BpError } from './error.mjs';

export const BP_DIR = 'blueprint';

/** 目录名与文件名的合法形式。id 由路径拼出,所以两者同一套规则。 */
export const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// id 第三段的层级标记。加它是为了让 id 自解释:业务流程与业务活动都挂在服务下,
// 若共用一个三段命名空间,解析 id 就得先查 repo 才知道是哪一层,
// 而 scan / read / delete 这些命令在 validate 之前就要解析 id,重名校验拦不住那个时间差。
export const FLOW_MARK = 'flow';
export const ACTIVITY_MARK = 'activity';

/**
 * 业务流程的入口形态,即 front-matter 的 `type`。一个流程一个对外接口,
 * 但「对外」不止 HTTP:消息消费与定时任务同样是外部可独立触发的入口,它们没有 URL。
 * 配套的 `facade` 写这个入口对外露出的标识:
 *
 *   api   HTTP / RPC 接口,含外部系统打回来的异步回调    facade 形如 `POST /orders`
 *   mq    消息消费入口                                  facade 形如 `topic order.paid`
 *   cron  定时任务入口                                  facade 形如 `0 0 3 * * ?`
 */
export const FLOW_TYPES = ['api', 'mq', 'cron'];

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
    throw new BpError(`找不到 ${path.relative(process.cwd(), file)},先用 blueprint skill 初始化`);
  }
  const cfg = parseYaml(raw) || {};
  cfg.layout = cfg.layout || {};
  cfg.verify = cfg.verify || {};
  cfg.always_readable = cfg.always_readable || [];
  cfg.templates = loadTemplateSpec(root);
  return cfg;
}

/**
 * 文档类型 → 模板文件。领域模型有两套骨架:聚合写边界/状态/不变量/命令,
 * 领域服务写职责/契约/规则,章节表完全不同,一个模板文件装不下两套。
 */
const TEMPLATE_FILES = {
  flow: 'flow.md',
  activity: 'activity.md',
  'domain-aggregate': 'domain-aggregate.md',
  'domain-service': 'domain-service.md',
};

/** 领域模型的 kind 取值,front-matter 的 `kind` 与 `bp new --kind` 共用。 */
export const DOMAIN_KINDS = ['aggregate', 'service'];

/** kind → 模板名。kind 缺失或不认识时按聚合处理,校验会把它报出来。 */
export function domainTemplate(kind) {
  return kind === 'service' ? 'domain-service' : 'domain-aggregate';
}

/**
 * 章节的附加规则。模板正文里一个字都不留,所以这条规则放在这儿:
 *
 *   numbered  这些章节需连续编号,一个文档类型可以有多组。codemap 的 covers 与它们比对,
 *             「每条编号都落到代码上」这道判定唯此一处。前缀各层不同:
 *             活动的动作 A、聚合的不变量 I 与命令 C、领域服务的规则 R
 *
 * 章节名要与模板对得上,对不上会在 loadTemplateSpec 里报错,不静默失效。
 */
const SECTION_RULES = {
  activity: { numbered: [{ section: '业务动作', prefix: 'A' }] },
  'domain-aggregate': {
    numbered: [{ section: '不变量', prefix: 'I' }, { section: '命令', prefix: 'C' }],
  },
  'domain-service': { numbered: [{ section: '规则', prefix: 'R' }] },
};

/**
 * 读 blueprint/templates/ 下的模板,推导各文档类型的章节表与编号规则。
 * 模板缺失或没有章节时直接报错——静默回退到内置默认值会让校验与模板悄悄脱节。
 *
 * 全部章节都参与哈希:文档里写下的每一个字都是确认过的内容,改了就该让人重看一遍。
 */
export function loadTemplateSpec(root) {
  const out = {};
  for (const [kind, file] of Object.entries(TEMPLATE_FILES)) {
    const p = bpPath(root, 'templates', file);
    const raw = readFileSafe(p);
    if (raw === null) {
      throw new BpError(`找不到模板 ${path.relative(process.cwd(), p)},重跑 blueprint skill 的 init 可补齐`);
    }
    const spec = parseTemplateSpec(raw);
    if (!spec.titles.length) {
      throw new BpError(`模板 blueprint/templates/${file} 中没有二级标题章节`);
    }
    const numbered = SECTION_RULES[kind]?.numbered || null;
    for (const rule of numbered || []) {
      if (!spec.titles.includes(rule.section)) {
        throw new BpError(`config.mjs 的 SECTION_RULES 提到章节「${rule.section}」,但 blueprint/templates/${file} 里没有它`);
      }
    }
    spec.numbered = numbered;
    spec.hashed = spec.titles;
    out[kind] = spec;
  }
  return out;
}

/** ${XXX} 环境变量插值,取不到则报错;不含占位符的原样返回。 */
export function interpolate(str) {
  return String(str).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined || v === '') throw new BpError(`环境变量 ${name} 未设置`);
    return v;
  });
}

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

/**
 * 由 id 推导代码作用域目录。
 * 活动 id:`<capability>.<service>.activity.<name>`;领域模型 id:`@<domain>.<name>`。
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
  const out = {};
  const tpl = cfg.layout.app;
  if (tpl) out.app = ensureSlash(fill(tpl, { capability, service: service || '' }));
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

/**
 * 由 id 推导它该落在哪份文档(相对 blueprint/),`bp new` 与各处路径计算的唯一出处。
 * 返回 { kind, file, template },id 不合法返回 null。
 * 领域模型两套骨架,`domainKind` 决定用哪个模板;路径与它无关。
 *
 * 业务服务的 id 就是 `product/<capability>/<service>.md` 的路径,反过来也成立——
 * 人写文件即建服务,不需要再声明什么。
 */
export function idToDoc(id, domainKind = 'aggregate') {
  const kind = idKind(id);
  if (kind === 'domain') {
    const [group, name] = splitDomainId(id);
    if (!group) return null;
    return {
      kind,
      file: path.join('domain', group, name, 'domain.md'),
      template: `${domainTemplate(domainKind)}.md`,
    };
  }
  if (kind === 'service') {
    const [capability, service] = String(id).split('.');
    if (!SLUG.test(capability) || !SLUG.test(service)) return null;
    return { kind, file: path.join('spec', capability, service, 'service.md'), template: 'service.md' };
  }
  if (kind === 'flow' || kind === 'activity') {
    const parts = splitUnitId(id);
    if (parts.length !== 4) return null;
    if (![parts[0], parts[1], parts[3]].every((p) => SLUG.test(p))) return null;
    return { kind, file: idToSpecPath(id), template: `${kind}.md` };
  }
  return null;
}

/** 业务服务 id → 人写的业务描述文档路径(相对 blueprint/)。 */
export function idToProductPath(serviceId) {
  const [capability, service] = String(serviceId).split('.');
  if (!capability || !service) return null;
  return path.join('product', capability, `${service}.md`);
}

/** 活动/流程 id 的所属服务 id。 */
export function serviceOf(id) {
  const parts = String(id).split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null;
}
