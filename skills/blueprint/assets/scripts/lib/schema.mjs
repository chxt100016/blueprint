// 模板与引用校验。所有 validate 规则集中在此。
import path from 'node:path';
import {
  findSection, sectionTitles, extractFences, parseFlowchartNodes,
  parseOrderedSteps, stepKey, parseRules, parseTableFirstColumn, exists,
} from './parse.mjs';
import {
  FLOW_SECTIONS, CAPABILITY_SECTIONS, activitySectionTitles, splitCapabilityId,
} from './config.mjs';
import { anchorOf, toArray } from './repo.mjs';

const FLOW_FM_FIELDS = ['service', 'title', 'product'];
const ACTIVITY_FM_FIELDS = ['id', 'title', 'depends_on', 'uses', 'entry', 'tables'];
const CAPABILITY_FM_FIELDS = ['id', 'title', 'tables'];

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

function checkRules(errors, where, sections) {
  const sec = findSection(sections, '行为规则');
  if (!sec) return;
  const nums = parseRules(sec.body);
  if (!nums.length) {
    err(errors, where, '「行为规则」中没有形如 `R1` 的条目');
    return;
  }
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) {
      err(errors, where, `「行为规则」编号应从 1 连续递增,第 ${i + 1} 条为 R${nums[i]}`);
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

// --------------------------------------------------------------------- flow

export function validateService(repo, serviceId) {
  const errors = [];
  const svc = repo.services.get(serviceId);
  const where = serviceId;
  if (!svc) { err(errors, where, '服务不存在'); return errors; }
  if (!svc.exists) { err(errors, where, `缺少 ${path.relative(repo.root, svc.flowPath)}`); return errors; }

  checkSections(errors, where, sectionTitles(svc.sections), FLOW_SECTIONS);
  checkFmFields(errors, where, svc.fm, FLOW_FM_FIELDS);

  if (svc.fm.service !== serviceId) {
    err(errors, where, `front-matter 的 service (${svc.fm.service ?? '缺失'}) 与路径不一致`);
  }
  if (!svc.fm.title) err(errors, where, 'front-matter 缺少 title');

  const ref = svc.fm.product;
  if (!ref || typeof ref !== 'string' || !ref.includes('#')) {
    err(errors, where, 'product 应形如 `<域>#<二级标题>`');
  } else {
    const found = anchorOf(repo, ref);
    if (!found) err(errors, where, `product 锚点 \`${ref}\` 不存在`);
    const users = repo.anchorUsers.get(ref) || [];
    if (users.length > 1) err(errors, where, `锚点 \`${ref}\` 被多个服务引用: ${users.join(', ')}`);
  }

  checkNonEmpty(errors, where, svc.sections, FLOW_SECTIONS);

  // 流程图:含且仅含一个 mermaid 代码块,首行为 flowchart
  const diagramSec = findSection(svc.sections, '流程图');
  const fences = diagramSec ? extractFences(diagramSec.body).filter((f) => f.lang === 'mermaid') : [];
  if (fences.length !== 1) {
    err(errors, where, `「流程图」应含且仅含一个 mermaid 代码块,实际 ${fences.length} 个`);
  } else if (!/^\s*flowchart\b/.test(fences[0].code.trim())) {
    err(errors, where, '「流程图」的 mermaid 首行应为 `flowchart`');
  } else {
    checkFlowchartMapping(errors, where, fences[0].code, findSection(svc.sections, '流程')?.body || '');
  }

  // 活动划分
  const listSec = findSection(svc.sections, '活动划分');
  const items = svc.activityList;
  if (listSec && listSec.body.trim() && !items.length) {
    err(errors, where, '「活动划分」条目应形如 `- <slug>  <一句话说明>`');
  }
  const seen = new Set();
  for (const it of items) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(it.slug)) {
      err(errors, where, `活动 slug \`${it.slug}\` 不是合法目录名(小写字母、数字、连字符)`);
    }
    if (seen.has(it.slug)) err(errors, where, `活动 slug \`${it.slug}\` 重复`);
    seen.add(it.slug);
    if (it.loose) err(errors, where, `活动划分条目 \`${it.slug}\` 的 slug 与说明之间应留两个以上空格`);
  }

  // 划分与目录一一对应:activity 已 approve 之后才校验
  if (repo.lock.services?.[serviceId]?.activity_approved_at) {
    const dirs = new Set(svc.activities.map((a) => a.split('.').pop()));
    for (const it of items) {
      if (!dirs.has(it.slug)) err(errors, where, `活动划分中的 \`${it.slug}\` 缺少 ${it.slug}/activity.md`);
    }
    for (const d of dirs) {
      if (!seen.has(d)) err(errors, where, `活动目录 \`${d}\` 不在「活动划分」中`);
    }
  }
  return errors;
}

function checkFlowchartMapping(errors, where, code, flowBody) {
  const nodes = parseFlowchartNodes(code).filter((n) => !n.terminal);
  const steps = parseOrderedSteps(flowBody);
  if (!steps.length) {
    err(errors, where, '「流程」中没有形如 `1. xxx` 的有序步骤');
    return;
  }
  const stepMap = new Map();
  for (const s of steps) {
    const k = stepKey(s.text);
    stepMap.set(k, (stepMap.get(k) || 0) + 1);
  }
  const nodeMap = new Map();
  for (const n of nodes) {
    const k = stepKey(n.text);
    nodeMap.set(k, (nodeMap.get(k) || 0) + 1);
  }
  for (const s of steps) {
    const k = stepKey(s.text);
    const c = nodeMap.get(k) || 0;
    if (c === 0) err(errors, where, `流程第 ${s.no} 步「${s.text}」在流程图中没有对应节点`);
    else if (c > 1) err(errors, where, `流程第 ${s.no} 步「${s.text}」在流程图中有 ${c} 个同文字节点`);
  }
  for (const n of nodes) {
    if (!stepMap.has(stepKey(n.text))) {
      err(errors, where, `流程图节点「${n.text}」在「流程」中没有对应步骤`);
    }
  }
}

// ----------------------------------------------------------------- activity

export function validateActivity(repo, id) {
  const errors = [];
  const act = repo.activities.get(id);
  const where = id;
  if (!act) { err(errors, where, '活动不存在'); return errors; }
  const cfg = repo.cfg;
  const expected = activitySectionTitles(cfg);

  checkSections(errors, where, sectionTitles(act.sections), expected);
  checkFmFields(errors, where, act.fm, ACTIVITY_FM_FIELDS);

  if (act.fm.id !== id) err(errors, where, `front-matter 的 id (${act.fm.id ?? '缺失'}) 与路径不一致`);
  if (!act.fm.title) err(errors, where, 'front-matter 缺少 title');

  const svc = repo.services.get(act.service);
  if (svc && !svc.activityList.some((i) => i.slug === act.slug)) {
    err(errors, where, `\`${act.slug}\` 不在 ${act.service} 的「活动划分」中`);
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

  // depends_on
  for (const dep of act.depends_on) {
    if (typeof dep !== 'string' || dep.split('.').length !== 3) {
      err(errors, where, `depends_on 中 \`${dep}\` 不是活动 id`);
      continue;
    }
    const depService = dep.split('.').slice(0, 2).join('.');
    if (depService !== act.service) {
      err(errors, where, `depends_on 中 \`${dep}\` 跨服务,跨服务复用请走 uses`);
      continue;
    }
    if (!repo.activities.has(dep)) err(errors, where, `depends_on 中 \`${dep}\` 对应的 activity.md 不存在`);
  }
  const cycle = findCycle(repo, act.service);
  if (cycle && cycle.includes(id)) err(errors, where, `depends_on 构成环: ${cycle.join(' → ')}`);

  // uses:只校验形式,存在性由 stage capability_pending 承接
  for (const u of act.uses) {
    if (typeof u !== 'string' || !/^@[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(u)) {
      err(errors, where, `uses 中 \`${u}\` 应形如 \`@<域>.<能力>\``);
    }
  }

  checkNonEmpty(errors, where, act.sections, expected);
  checkRules(errors, where, act.sections);
  checkTables(errors, where, act.fm.tables);

  // entry
  const entry = act.fm.entry || {};
  if (cfg.type !== 'frontend' && !entry.api) err(errors, where, 'entry.api 必填(config.type 非 frontend)');
  if (cfg.type !== 'backend' && !entry.ui) err(errors, where, 'entry.ui 必填(config.type 非 backend)');
  for (const k of Object.keys(entry)) {
    if (!['api', 'ui'].includes(k)) err(errors, where, `entry 出现未定义字段 \`${k}\``);
  }
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
        /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/.test(token);
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

// --------------------------------------------------------------- capability

export function validateCapability(repo, id) {
  const errors = [];
  const cap = repo.capabilities.get(id);
  const where = id;
  if (!cap) { err(errors, where, '领域能力不存在'); return errors; }

  checkSections(errors, where, sectionTitles(cap.sections), CAPABILITY_SECTIONS);
  checkFmFields(errors, where, cap.fm, CAPABILITY_FM_FIELDS);

  if (cap.fm.id !== id) err(errors, where, `front-matter 的 id (${cap.fm.id ?? '缺失'}) 与路径不一致`);
  if (!cap.fm.title) err(errors, where, 'front-matter 缺少 title');
  const [d, c] = splitCapabilityId(id);
  if (!d || !c) err(errors, where, 'id 应形如 `@<域>.<能力>`');

  checkNonEmpty(errors, where, cap.sections, CAPABILITY_SECTIONS);
  checkRules(errors, where, cap.sections);
  checkTables(errors, where, cap.fm.tables);

  // 契约只增不改
  const locked = repo.lock.capabilities?.[id]?.spec;
  if (locked?.contract_fields) {
    const now = contractFields(cap);
    for (const f of locked.contract_fields) {
      if (!now.includes(f)) {
        err(errors, where, `契约字段 \`${f}\` 被删除或改名。领域能力契约只增不改,破坏性变更请新建能力`);
      }
    }
  }
  return errors;
}

export function contractFields(cap) {
  const sec = findSection(cap.sections, '契约');
  if (!sec) return [];
  return parseTableFirstColumn(sec.body).filter((f) => f && !/^-+$/.test(f));
}

// --------------------------------------------------------------------- 汇总

export function validateAll(repo) {
  const all = [];
  for (const id of repo.services.keys()) all.push(...validateService(repo, id));
  for (const id of repo.activities.keys()) all.push(...validateActivity(repo, id));
  for (const id of repo.capabilities.keys()) all.push(...validateCapability(repo, id));
  // product 侧:锚点被多个服务引用已在服务侧报出;这里只查孤儿目录
  for (const svc of repo.services.values()) {
    if (!svc.exists) err(all, svc.id, `目录存在但缺少 flow.md: ${path.relative(repo.root, svc.dir)}`);
  }
  return all;
}

export function validateId(repo, id) {
  if (!id) return validateAll(repo);
  if (repo.services.has(id)) {
    const out = validateService(repo, id);
    for (const aid of repo.services.get(id).activities) out.push(...validateActivity(repo, aid));
    return out;
  }
  if (repo.activities.has(id)) return validateActivity(repo, id);
  if (repo.capabilities.has(id)) return validateCapability(repo, id);
  if (repo.products.has(id)) {
    const out = [];
    for (const svc of repo.services.values()) {
      if (svc.domain === id) out.push(...validateService(repo, svc.id));
    }
    return out;
  }
  return [{ where: id, msg: '找不到该 id 对应的对象' }];
}
