// 模板与引用校验。所有 validate 规则集中在此。
import path from 'node:path';
import { findSection, sectionTitles, parseRules } from './parse.mjs';
import {
  splitDomainId, splitUnitId, serviceOf, isDomainId, DOMAIN_KINDS,
  SLUG, ACTIVITY_MARK, FLOW_TYPES,
} from './config.mjs';
import { toArray } from './repo.mjs';
import { loadSnapshot, gapsFor } from './db.mjs';

function err(list, where, msg) {
  list.push({ where, msg });
}

// 一次进程里只读一次 snapshot:validate 无参时会走遍全部活动与领域
let snapshotCache = null;
function snapshotOf(root) {
  if (!snapshotCache) snapshotCache = loadSnapshot(root);
  return snapshotCache;
}

/**
 * 表结构缺口。前缀固定成「表结构缺失」,因为这类错误的处理方式与文档错误完全不同:
 * 文档错误 AI 自己改,表结构缺口要生成建表工单交给人。
 * snapshot 没导出过时不判——空 snapshot 只说明还没跑过 pull,不代表库里没有这些表。
 */
function checkTableGaps(errors, repo, decl) {
  if (!decl?.tables?.length) return;
  const snap = snapshotOf(repo.root);
  if (!snap.exists) return;
  for (const gap of gapsFor(snap, decl)) {
    const name = gap.kind === 'table' ? gap.table : `${gap.table}.${gap.column}`;
    err(errors, gap.by, `表结构缺失: ${name}(${gap.detail})`);
  }
}

function checkSections(errors, where, actual, expected) {
  const a = actual.join(' | ');
  const b = expected.join(' | ');
  if (a !== b) {
    err(errors, where, `章节标题与模板不一致\n    期望: ${b}\n    实际: ${a || '(无)'}`);
    return false;
  }
  return true;
}

function checkFmFields(errors, where, fm, allowed) {
  for (const k of Object.keys(fm || {})) {
    if (!allowed.includes(k)) err(errors, where, `front-matter 出现未定义字段 \`${k}\``);
  }
}

function checkNonEmpty(errors, where, sections, titles) {
  for (const t of titles) {
    const sec = findSection(sections, t);
    if (!sec || !sec.body.trim()) err(errors, where, `章节「${t}」为空`);
  }
}

/** numbered 来自 config.mjs 的 SECTION_RULES,该文档类型没配就不校验编号。 */
function checkRules(errors, where, sections, numbered) {
  for (const { section: title, prefix } of numbered || []) {
    const sec = findSection(sections, title);
    if (!sec) continue;
    const body = sec.body.trim();
    if (body === '无') continue;
    const nums = parseRules(body, prefix);
    if (!nums.length) {
      err(errors, where, `「${title}」中没有形如 \`${prefix}1\` 的条目`);
      continue;
    }
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) {
        err(errors, where, `「${title}」编号应从 1 连续递增,第 ${i + 1} 条为 ${prefix}${nums[i]}`);
        break;
      }
    }
  }
}

function checkTables(errors, where, tables, key = 'tables') {
  toArray(tables).forEach((t, i) => {
    if (!t || typeof t !== 'object') {
      err(errors, where, `${key} 第 ${i + 1} 项格式错误,应为 { name, columns }`);
      return;
    }
    if (!t.name) err(errors, where, `${key} 第 ${i + 1} 项缺少 name`);
    if (!toArray(t.columns).length) err(errors, where, `${key} 中 ${t.name || i + 1} 的 columns 为空`);
  });
}

/**
 * 「领域依赖」一节的格式。它是活动引用领域模型的唯一出处,所以格式固定:
 * 一个 `###` 一个模型,标题只写 id,其下两行 `- 输入:` 与 `- 输出:`。
 * 存在性不在这儿查——识别归活动、设计归 domain 层,引用一个还没建的模型是正常状态。
 */
function checkDomainDeps(errors, where, act) {
  const sec = findSection(act.sections, '领域依赖');
  if (!sec) return; // 章节缺失由 checkSections 报
  const body = sec.body.trim();
  if (!body || body === '无') return;
  const seen = new Set();
  for (const dep of act.deps || []) {
    if (!isDomainId(dep.id) || !splitDomainId(dep.id)[0]) {
      err(errors, where, `「领域依赖」中 \`${dep.id}\` 不是领域模型 id(应形如 \`@<领域>.<name>\`)`);
      continue;
    }
    if (seen.has(dep.id)) err(errors, where, `「领域依赖」中 \`${dep.id}\` 重复出现`);
    seen.add(dep.id);
    if (dep.input === null) err(errors, where, `「领域依赖」的 ${dep.id} 缺少 \`- 输入:\` 一行`);
    if (dep.output === null) err(errors, where, `「领域依赖」的 ${dep.id} 缺少 \`- 输出:\` 一行`);
  }
  if (!seen.size) {
    err(errors, where, '「领域依赖」既没有 `### <domainId>` 条目,也没有写「无」');
  }
}

/**
 * 一张表只能被一个聚合声明 `tables`——它是「状态变更的唯一入口」这条规矩的落点。
 * 只读引用(领域服务的 reads、查询活动的 reads)不受限,谁都可以读。
 */
function checkTableOwnership(errors, repo, dom) {
  if (dom.kind !== 'aggregate') return;
  const mine = new Set(toArray(dom.tables).map((t) => t?.name).filter(Boolean));
  if (!mine.size) return;
  for (const other of repo.domains.values()) {
    if (other.id === dom.id || other.kind !== 'aggregate') continue;
    for (const t of toArray(other.tables)) {
      if (t?.name && mine.has(t.name)) {
        err(errors, dom.id, `表 ${t.name} 已被聚合 ${other.id} 声明,一张表只能被一个聚合写`);
      }
    }
  }
}

/**
 * 「概要」的硬约束:单行、不超过 40 字。三层文档共用。
 *
 * 它是各层清单(`bp scan flow` / `bp scan activity` / `bp domain list`)唯一直接列出的正文,
 * 人和 AI 靠它在不打开文件的情况下认出一个对象、判断「我要的是不是已经有了」。
 * 一旦允许写成一段,清单就会被淹掉,而清单被淹掉之后没人会去修——所以这条要卡死。
 */
const SUMMARY_MAX = 40;

function checkSummary(errors, where, summary) {
  const text = String(summary || '').trim();
  if (!text) return; // 空的情况由 checkNonEmpty 报,不重复
  if (text.split('\n').filter((l) => l.trim()).length > 1) {
    err(errors, where, '「概要」要写成一行,不要分段');
    return;
  }
  if ([...text].length > SUMMARY_MAX) {
    err(errors, where, `「概要」不超过 ${SUMMARY_MAX} 字,实际 ${[...text].length} 字`);
  }
}

// --------------------------------------------------------------------- flow

/** 单个业务流程 = 一个对外接口。 */
export function validateFlow(repo, flowId) {
  const errors = [];
  const flow = repo.flows.get(flowId);
  const where = flowId;
  if (!flow) { err(errors, where, '业务流程不存在'); return errors; }

  const tpl = repo.cfg.templates.flow;
  checkSections(errors, where, sectionTitles(flow.sections), tpl.titles);
  checkFmFields(errors, where, flow.fm, tpl.fmFields);

  if (flow.fm.id !== flowId) {
    err(errors, where, `front-matter 的 id (${flow.fm.id ?? '缺失'}) 与路径不一致`);
  }

  // type + facade:一个流程一个对外接口,接口是流程的属性而不是活动的
  if (!flow.fm.type) {
    err(errors, where, `type 必填,可选 ${FLOW_TYPES.join(' / ')}(模板 templates/flow.md 要求)`);
  } else if (!FLOW_TYPES.includes(flow.fm.type)) {
    err(errors, where, `type \`${flow.fm.type}\` 未知,可选 ${FLOW_TYPES.join(' / ')}`);
  }
  if (!flow.fm.facade) err(errors, where, 'facade 必填(模板 templates/flow.md 要求)');

  checkNonEmpty(errors, where, flow.sections, tpl.titles);
  checkSummary(errors, where, flow.summary);
  return errors;
}

/**
 * 活动目录与各流程「业务活动」并集的差集。判据只此一份,三处共用:
 * validateService(活动层盖章之后)、`bp activity approve`(首次盖章前也要查)、
 * `bp scan activity`(缺文档要报进 detail)。
 */
export function activityDirMismatch(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return { onlyListed: [], onlyDirs: [] };
  const listed = new Set(svc.activityList.map((it) => it.slug));
  const dirs = new Set(svc.activities.map((a) => a.split('.').pop()));
  return {
    onlyListed: [...listed].filter((slug) => !dirs.has(slug)),
    onlyDirs: [...dirs].filter((slug) => !listed.has(slug)),
  };
}

/**
 * 服务级校验:跨流程、跨活动才成立的事实。
 * 单个流程自身的问题在 validateFlow 里查,不在这里重复。
 */
export function validateService(repo, serviceId) {
  const errors = [];
  const svc = repo.services.get(serviceId);
  const where = serviceId;
  if (!svc) { err(errors, where, '业务服务不存在'); return errors; }
  // 业务服务由 product 文档定义,没有文档就没有这个服务
  if (!svc.product) {
    err(errors, where, `人写的业务描述 ${svc.productRel} 不存在;若是改名,把 spec 目录一并改过来`);
  }
  for (const part of [svc.capability, svc.slug]) {
    if (!SLUG.test(part)) {
      err(errors, where, `\`${part}\` 不是合法的目录名(小写字母、数字、连字符),id 由路径拼出,必须用英文`);
    }
  }
  if (!svc.flows.length) {
    err(errors, where, `目录存在但没有任何业务流程文件: ${path.relative(repo.root, svc.dir)}`);
    return errors;
  }

  // 活动目录 ↔ 各流程编排的并集,一一对应:活动层 approve 之后才校验
  if (repo.lock.services?.[serviceId]?.activity) {
    const { onlyListed, onlyDirs } = activityDirMismatch(repo, serviceId);
    for (const slug of onlyListed) err(errors, where, `「业务活动」列出的 \`${slug}\` 缺少 ${slug}/activity.md`);
    for (const slug of onlyDirs) err(errors, where, `活动目录 \`${slug}\` 不被任何流程编排`);
  }

  // depends_on 成环:环是服务级事实,在这里查一次,不在每个活动上重复查
  const cycle = findCycle(repo, serviceId);
  if (cycle) err(errors, where, `depends_on 构成环: ${cycle.join(' → ')}`);

  return errors;
}

// ----------------------------------------------------------------- activity

export function validateActivity(repo, id) {
  const errors = [];
  const act = repo.activities.get(id);
  const where = id;
  if (!act) { err(errors, where, '业务活动不存在'); return errors; }
  const tpl = repo.cfg.templates.activity;
  const expected = tpl.titles;

  checkSections(errors, where, sectionTitles(act.sections), expected);
  checkFmFields(errors, where, act.fm, tpl.fmFields);

  if (act.fm.id !== id) err(errors, where, `front-matter 的 id (${act.fm.id ?? '缺失'}) 与路径不一致`);
  // 概要由活动自己持有:它被多个流程编排,说明不能寄存在某一份流程文档里
  checkSummary(errors, where, act.summary);

  const svc = repo.services.get(act.service);
  if (svc && !svc.activityList.some((i) => i.slug === act.slug)) {
    err(errors, where, `\`${act.slug}\` 不被 ${act.service} 的任何流程编排`);
  }

  // depends_on:限同服务内。活动归属服务而不是流程,所以同服务跨流程的依赖是合法的
  for (const dep of act.depends_on) {
    const parts = typeof dep === 'string' ? splitUnitId(dep) : [];
    if (!parts.length || parts[2] !== ACTIVITY_MARK) {
      err(errors, where, `depends_on 中 \`${dep}\` 不是业务活动 id(应形如 <cap>.<svc>.${ACTIVITY_MARK}.<name>)`);
      continue;
    }
    if (serviceOf(dep) !== act.service) {
      err(errors, where, `depends_on 中 \`${dep}\` 跨服务,跨服务复用请走 uses`);
      continue;
    }
    if (!repo.activities.has(dep)) err(errors, where, `depends_on 中 \`${dep}\` 对应的 activity.md 不存在`);
  }

  checkDomainDeps(errors, where, act);

  checkNonEmpty(errors, where, act.sections, expected);
  checkRules(errors, where, act.sections, tpl.numbered);
  // 活动只声明只读引用:写由聚合负责,表结构缺口也随之归到 domain 层
  checkTables(errors, where, act.fm.reads, 'reads');
  checkTableGaps(errors, repo, act);
  return errors;
}

function findCycle(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return null;
  const state = new Map();
  const stack = [];
  let cycle = null;
  const visit = (id) => {
    if (cycle) return;
    if (state.get(id) === 1) {
      const at = stack.indexOf(id);
      cycle = [...stack.slice(at), id];
      return;
    }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    stack.push(id);
    for (const dep of repo.activities.get(id)?.depends_on || []) {
      if (repo.activities.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of svc.activities) visit(id);
  return cycle;
}

// ------------------------------------------------------------------ domain

export function validateDomain(repo, id) {
  const errors = [];
  const dom = repo.domains.get(id);
  const where = id;
  if (!dom) { err(errors, where, '领域模型不存在'); return errors; }

  if (!DOMAIN_KINDS.includes(dom.fm.kind)) {
    err(errors, where, `front-matter 的 kind (${dom.fm.kind ?? '缺失'}) 应为 ${DOMAIN_KINDS.join(' 或 ')}`);
  }

  // 章节表按 kind 取:两类骨架不同,拿错模板会报一串莫名其妙的章节错
  const tpl = repo.cfg.templates[dom.tplName];
  checkSections(errors, where, sectionTitles(dom.sections), tpl.titles);
  checkFmFields(errors, where, dom.fm, tpl.fmFields);

  if (dom.fm.id !== id) err(errors, where, `front-matter 的 id (${dom.fm.id ?? '缺失'}) 与路径不一致`);
  checkSummary(errors, where, dom.summary);
  const [group, name] = splitDomainId(id);
  if (!group || !name) err(errors, where, 'id 应形如 `@<领域>.<name>`');

  checkNonEmpty(errors, where, dom.sections, tpl.titles);
  checkRules(errors, where, dom.sections, tpl.numbered);

  if (dom.kind === 'aggregate') {
    // 聚合完全自洽:它要的一切由调用方传入,自己不引用任何外部对象
    checkTables(errors, where, dom.fm.tables);
    checkTableOwnership(errors, repo, dom);
  } else {
    checkTables(errors, where, dom.fm.reads, 'reads');
  }
  checkTableGaps(errors, repo, dom);
  return errors;
}

// --------------------------------------------------------------------- 汇总

export function validateAll(repo) {
  const all = [];
  for (const id of repo.services.keys()) all.push(...validateService(repo, id));
  for (const id of repo.flows.keys()) all.push(...validateFlow(repo, id));
  for (const id of repo.activities.keys()) all.push(...validateActivity(repo, id));
  for (const id of repo.domains.keys()) all.push(...validateDomain(repo, id));
  return all;
}

/** 服务及其下全部流程、活动。 */
function validateServiceTree(repo, serviceId) {
  const out = validateService(repo, serviceId);
  const svc = repo.services.get(serviceId);
  for (const fid of svc?.flows || []) out.push(...validateFlow(repo, fid));
  for (const aid of svc?.activities || []) out.push(...validateActivity(repo, aid));
  return out;
}

export function validateId(repo, id) {
  if (!id) return validateAll(repo);
  if (repo.services.has(id)) return validateServiceTree(repo, id);
  if (repo.flows.has(id)) return validateFlow(repo, id);
  if (repo.activities.has(id)) return validateActivity(repo, id);
  if (repo.domains.has(id)) return validateDomain(repo, id);
  // 商业能力:没有自己的文档,校验它就是校验它下面全部业务服务
  const inCapability = [...repo.services.values()].filter((svc) => svc.capability === id);
  if (inCapability.length) {
    const out = [];
    for (const svc of inCapability) out.push(...validateServiceTree(repo, svc.id));
    return out;
  }
  return [{ where: id, msg: '找不到该 id 对应的对象' }];
}
