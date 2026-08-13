// 模板与引用校验。所有 validate 规则集中在此。
import path from 'node:path';
import {
  findSection, sectionTitles, extractFences, isTemplateNote,
  parseOrderedSteps, parseRules, parseTableFirstColumn,
} from './parse.mjs';
import { splitDomainId, splitUnitId, SLUG, ACTIVITY_MARK } from './config.mjs';
import { toArray } from './repo.mjs';

function err(list, where, msg) {
  list.push({ where, msg });
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

/** numbered 来自模板的 `<!-- bp: numbered=X -->` 标记,模板没标就不校验编号。 */
function checkRules(errors, where, sections, numbered) {
  if (!numbered) return;
  const { section: title, prefix } = numbered;
  const sec = findSection(sections, title);
  if (!sec) return;
  const nums = parseRules(sec.body, prefix);
  if (!nums.length) {
    err(errors, where, `「${title}」中没有形如 \`${prefix}1\` 的条目`);
    return;
  }
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) {
      err(errors, where, `「${title}」编号应从 1 连续递增,第 ${i + 1} 条为 ${prefix}${nums[i]}`);
      break;
    }
  }
}

function checkTables(errors, where, tables) {
  toArray(tables).forEach((t, i) => {
    if (!t || typeof t !== 'object') {
      err(errors, where, `tables 第 ${i + 1} 项格式错误,应为 { name, columns }`);
      return;
    }
    if (!t.name) err(errors, where, `tables 第 ${i + 1} 项缺少 name`);
    if (!toArray(t.columns).length) err(errors, where, `tables 中 ${t.name || i + 1} 的 columns 为空`);
  });
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
  if (isTemplateNote(text)) {
    err(errors, where, '「概要」还是模板里的说明文字,没有填写');
    return;
  }
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

  // entry:一个流程一个对外接口,接口是流程的属性而不是活动的
  const entry = flow.fm.entry || {};
  for (const k of tpl.entryFields) {
    if (!entry[k]) err(errors, where, `entry.${k} 必填(模板 templates/flow.md 要求)`);
  }
  for (const k of Object.keys(entry)) {
    if (!tpl.entryFields.includes(k)) err(errors, where, `entry 出现未定义字段 \`${k}\``);
  }

  checkNonEmpty(errors, where, flow.sections, tpl.titles);
  checkSummary(errors, where, flow.summary);

  // 流程图:含且仅含一个 mermaid 代码块,首行为 flowchart。
  // 图与「流程」步骤的逐条对应不做校验——归一化只能抹平标点空白,抹不平措辞,
  // 图文说的是同一件事却因几个字不同而卡住 approve,代价远大于它保障的可读性。
  const diagramSec = findSection(flow.sections, '流程图');
  const fences = diagramSec ? extractFences(diagramSec.body).filter((f) => f.lang === 'mermaid') : [];
  if (fences.length !== 1) {
    err(errors, where, `「流程图」应含且仅含一个 mermaid 代码块,实际 ${fences.length} 个`);
  } else if (!/^\s*flowchart\b/.test(fences[0].code.trim())) {
    err(errors, where, '「流程图」的 mermaid 首行应为 `flowchart`');
  }

  // 「流程」必须是有序步骤:changes 清单要数步骤数
  if (!parseOrderedSteps(findSection(flow.sections, '流程')?.body || '').length) {
    err(errors, where, '「流程」中没有形如 `1. xxx` 的有序步骤');
  }

  // 活动编排:本流程按顺序用到哪些活动。引用正向存放,活动不记录自己被谁编排
  const listSec = findSection(flow.sections, '活动编排');
  const items = flow.activityList;
  if (listSec && listSec.body.trim() && !items.length) {
    err(errors, where, '「活动编排」条目应形如 `- <slug>  <在本流程中的作用>`');
  }
  const seen = new Set();
  for (const it of items) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(it.slug)) {
      err(errors, where, `业务活动 slug \`${it.slug}\` 不是合法目录名(小写字母、数字、连字符)`);
    }
    if (seen.has(it.slug)) err(errors, where, `活动编排中 \`${it.slug}\` 重复`);
    seen.add(it.slug);
    if (it.loose) err(errors, where, `活动编排条目 \`${it.slug}\` 的 slug 与说明之间应留两个以上空格`);
  }
  return errors;
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
  const listed = new Set(svc.activityList.map((it) => it.slug));
  if (repo.lock.services?.[serviceId]?.activity) {
    const dirs = new Set(svc.activities.map((a) => a.split('.').pop()));
    for (const slug of listed) {
      if (!dirs.has(slug)) err(errors, where, `活动编排中的 \`${slug}\` 缺少 ${slug}/activity.md`);
    }
    for (const d of dirs) {
      if (!listed.has(d)) err(errors, where, `活动目录 \`${d}\` 不被任何流程编排`);
    }
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

  // 时序图
  const seqSec = findSection(act.sections, '时序图');
  const fences = seqSec ? extractFences(seqSec.body).filter((f) => f.lang === 'mermaid') : [];
  if (fences.length !== 1) {
    err(errors, where, `「时序图」应含且仅含一个 mermaid 代码块,实际 ${fences.length} 个`);
  } else if (!/^\s*sequenceDiagram\b/.test(fences[0].code.trim())) {
    err(errors, where, '「时序图」的 mermaid 首行应为 `sequenceDiagram`');
  } else {
    checkParticipants(errors, where, fences[0].code, act);
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

  // uses:只校验形式,存在性由 domain 层承接
  for (const u of act.uses) {
    if (typeof u !== 'string' || !/^@[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(u)) {
      err(errors, where, `uses 中 \`${u}\` 应形如 \`@<领域>.<能力名>\``);
    }
  }

  checkNonEmpty(errors, where, act.sections, expected);
  checkRules(errors, where, act.sections, tpl.numbered);
  checkTables(errors, where, act.fm.tables);
  return errors;
}

function checkParticipants(errors, where, code, act) {
  const allowed = new Set([...act.depends_on, ...act.uses]);
  const re = /^\s*(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+?))?\s*$/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const name of [m[1], m[2]]) {
      if (!name) continue;
      const token = name.trim().replace(/^["']|["']$/g, '');
      const looksLikeId = /^@[a-z0-9-]+\.[a-z0-9-]+$/.test(token) ||
        new RegExp(`^[a-z0-9-]+\\.[a-z0-9-]+\\.${ACTIVITY_MARK}\\.[a-z0-9-]+$`).test(token);
      if (!looksLikeId) continue;
      if (token === act.id) continue;
      if (!allowed.has(token)) {
        err(errors, where, `时序图 participant \`${token}\` 未出现在 depends_on 或 uses 中`);
      }
    }
  }
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

/** 同服务内按 depends_on 拓扑排序。 */
export function topoSort(repo, ids) {
  const set = new Set(ids);
  const out = [];
  const state = new Map();
  const visit = (id) => {
    if (state.get(id)) return;
    state.set(id, 1);
    for (const dep of repo.activities.get(id)?.depends_on || []) {
      if (set.has(dep)) visit(dep);
    }
    state.set(id, 2);
    out.push(id);
  };
  for (const id of [...set].sort()) visit(id);
  return out;
}

// ------------------------------------------------------------------ domain

export function validateDomain(repo, id) {
  const errors = [];
  const dom = repo.domains.get(id);
  const where = id;
  if (!dom) { err(errors, where, '领域能力不存在'); return errors; }

  const tpl = repo.cfg.templates.domain;
  checkSections(errors, where, sectionTitles(dom.sections), tpl.titles);
  checkFmFields(errors, where, dom.fm, tpl.fmFields);

  if (dom.fm.id !== id) err(errors, where, `front-matter 的 id (${dom.fm.id ?? '缺失'}) 与路径不一致`);
  checkSummary(errors, where, dom.summary);
  const [group, name] = splitDomainId(id);
  if (!group || !name) err(errors, where, 'id 应形如 `@<领域>.<能力名>`');

  checkNonEmpty(errors, where, dom.sections, tpl.titles);
  checkRules(errors, where, dom.sections, tpl.numbered);
  checkTables(errors, where, dom.fm.tables);

  // 契约只增不改
  const locked = repo.lock.domains?.[id]?.spec;
  if (locked?.contract_fields) {
    const now = contractFields(dom);
    for (const f of locked.contract_fields) {
      if (!now.includes(f)) {
        err(errors, where, `契约字段 \`${f}\` 被删除或改名。领域能力契约只增不改,破坏性变更请新建能力`);
      }
    }
  }
  return errors;
}

export function contractFields(dom) {
  const sec = findSection(dom.sections, '契约');
  if (!sec) return [];
  return parseTableFirstColumn(sec.body).filter((f) => f && !/^-+$/.test(f));
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
