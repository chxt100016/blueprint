// stage 判定。整个项目在任一时刻只有一个 stage,它回答的问题只有一个:
// 现在该调哪个 skill。
//
// 取件顺序就是依赖链本身,没有旁支:
//
//   flow → activity → domain → code → commit → none
//
// **没有对象状态。** 一行只有 id 与 detail 两个字段,判据是 `detail 非空 = 有事要做`。
// 「新写还是改写」「上游变了还是澄清没结清」都写在 detail 里,不另设状态词——
// 各层 skill 拿到一个对象都从本层流程的第一步走,状态词不改变它从哪儿开始。
//
// 两类「AI 推不动」的事不占 stage,只作附注:
//
//   引用断裂(孤儿)   打在 stage 输出顶部作告警,不阻断。它不属于任何一层,
//                    也没法交给某个 skill 处理(skill 的职责是产出文档,不是删东西)。
//   todo 工单未执行   列在末尾。stage 已是 none 时,这一段就是该叫人的事。
import { execFileSync } from 'node:child_process';
import { servicesOfDomain, flowsHash } from './repo.mjs';
import { isClean, stateLabel } from './review.mjs';
import { activityDirMismatch } from './schema.mjs';
import { loadSnapshot, gapsFor } from './db.mjs';
import { BpError } from './error.mjs';

export const LAYERS = ['flow', 'activity', 'domain', 'code'];

/** 每个 stage 对应的动作,pipeline 直接照着执行。 */
export const STAGE_ACTION = {
  flow: { by: 'skill', skill: 'flow', text: '调用 flow skill' },
  activity: { by: 'skill', skill: 'activity', text: '调用 activity skill' },
  domain: { by: 'skill', skill: 'domain', text: '调用 domain skill' },
  code: { by: 'skill', skill: 'code', text: '调用 code skill' },
  commit: { by: 'skill', skill: 'commit', text: '调用 commit skill' },
  none: { by: 'none', text: '没有待办' },
};

const row = (id, detail = '') => ({ id, detail });

/** 有事要做的行。complete 的行 detail 为空,不占清单。 */
export const openRows = (rows) => rows.filter((r) => r.detail);

/** 待澄清的后缀,三层的 detail 共用一种写法。 */
function reviewNote(objects) {
  const pending = objects.filter((o) => o?.review && !isClean(o.review));
  if (!pending.length) return '';
  return `;待澄清 ${pending.map((o) => `${o.slug}(${stateLabel(o.review)})`).join(', ')}`;
}

// ------------------------------------------------------------------ 孤儿告警

/**
 * 引用关系断裂的对象。多半是重命名造成的,一律交人确认,脚本不自动清理。
 *
 * 这些行**不阻断流水线**:它们不属于任何一层,没有哪个 skill 该拿它们当待办
 * (skill 的职责是产出文档,不是删东西),而残留物也不影响别的服务往下走。
 * `bp stage` 每次把它们打在输出顶部,清理走 `bp delete plan <id>`。
 */
function scanOrphans(repo) {
  const out = [];
  // 服务由 product 文档定义。spec 目录还在而文档没了,多半是人改了 product 里的文件名
  for (const id of [...repo.strayServices].sort()) {
    const svc = repo.services.get(id);
    out.push(row(id, `${svc.productRel} 不存在,但 ${svc.rel}/ 下已有产出`));
  }
  // 活动归属服务,由流程编排。不被任何流程编排的活动是孤儿
  const stray = new Set(repo.strayServices);
  for (const id of [...repo.activities.keys()].sort()) {
    const act = repo.activities.get(id);
    if (stray.has(act.service)) continue; // 整个服务已在上面报出,不重复刷屏
    const svc = repo.services.get(act.service);
    if (svc?.flows.length && !svc.activityList.some((i) => i.slug === act.slug)) {
      out.push(row(id, `不被 ${act.service} 的任何流程编排`));
    }
  }
  for (const id of [...repo.domains.keys()].sort()) {
    if (!repo.domains.get(id).usedBy.length) {
      out.push(row(id, '无任何活动 uses 引用'));
    }
  }
  for (const id of Object.keys(repo.lock.flows || {})) {
    if (!repo.flows.has(id)) out.push(row(id, 'lock 中有记录但文档不存在'));
  }
  for (const id of Object.keys(repo.lock.activities || {})) {
    if (!repo.activities.has(id)) out.push(row(id, 'lock 中有记录但文档不存在'));
  }
  for (const id of Object.keys(repo.lock.domains || {})) {
    if (!repo.domains.has(id)) out.push(row(id, 'lock 中有记录但文档不存在'));
  }
  return out;
}

// -------------------------------------------------------------------- flow

/**
 * 本轮相对上次确认发生了变化的流程。approve 的准出闸门与 changes 清单共用这一份判据。
 * kind:`新增` 是 lock 里没有的流程,`修改` 是哈希对不上的。
 */
export function dirtyFlows(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  const out = [];
  for (const fid of svc.flows) {
    const lock = repo.lock.flows?.[fid]?.flow;
    if (!lock) { out.push({ id: fid, kind: '新增' }); continue; }
    if (lock.flow_hash !== repo.flows.get(fid).hash) out.push({ id: fid, kind: '修改' });
  }
  return out;
}

/**
 * 人写的业务描述在流程确认之后又被改过。
 * 判据只此一处:scanFlow 的 detail 与 `bp scan flow` 的标记共用它。
 */
export function productChanged(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  const lock = repo.lock.services?.[serviceId]?.flow;
  if (!svc?.product || !lock) return false;
  return svc.product.hash !== lock.product_hash;
}

/** 流程层按业务服务推进。detail 为空即这个服务的流程已定稿。 */
function scanFlow(repo) {
  const out = [];
  for (const id of [...repo.services.keys()].sort()) {
    const svc = repo.services.get(id);
    if (!svc.product) continue; // stray,孤儿告警里报

    const lock = repo.lock.services?.[id]?.flow;
    const dirty = dirtyFlows(repo, id);
    const note = reviewNote(svc.flows.map((fid) => repo.flows.get(fid)));

    if (!lock) {
      const detail = svc.flows.length ? `已有 ${svc.flows.length} 个流程待确认` : '尚未产出流程';
      out.push(row(id, detail + note));
      continue;
    }
    const reasons = [];
    if (productChanged(repo, id)) reasons.push('product 已变更');
    if (dirty.length) reasons.push(dirty.map((d) => `${d.kind} ${d.id.split('.').pop()}`).join(', '));
    // 没答复的澄清也算没走完:approve 会拒绝,不在这里放行,否则问题会被静默遗忘
    if (!reasons.length && !note) { out.push(row(id, '')); continue; }
    out.push(row(id, (reasons.join(';') || '有澄清待结清') + note));
  }
  return out;
}

// ---------------------------------------------------------------- activity

/** 单个活动相对上次确认的变化;没变返回 null。 */
export function activityChange(repo, id) {
  const act = repo.activities.get(id);
  if (!act) return null;
  const spec = repo.lock.activities?.[id]?.spec;
  if (!spec) return '新增';
  return spec.activity_hash === act.hash ? null : '修改';
}

/**
 * 本轮相对上次确认发生了变化的活动。approve 与 changes 清单共用这一份判据。
 * 与 dirtyFlows 同构,kind 的取值也一致。
 */
export function dirtyActivities(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  return svc.activities
    .map((aid) => ({ id: aid, kind: activityChange(repo, aid) }))
    .filter((d) => d.kind);
}

/**
 * 上游的流程在活动确认之后又变过。与 productChanged 同构:
 * 判据只此一处,scanActivity 的 detail 与 `bp scan activity` 的标记共用它。
 */
export function flowsChanged(repo, serviceId) {
  const lock = repo.lock.services?.[serviceId]?.activity;
  if (!lock) return false;
  return flowsHash(repo, serviceId) !== lock.flows_hash;
}

/**
 * 活动层按服务聚合:活动归属服务、被多个流程共用,
 * 一次确认覆盖服务下的全部活动,上游是本服务全部流程的组合哈希。
 */
function scanActivity(repo) {
  const out = [];
  const settled = new Set(scanFlow(repo).filter((r) => !r.detail).map((r) => r.id));
  for (const id of [...repo.services.keys()].sort()) {
    const svc = repo.services.get(id);
    if (!svc.flows.length) continue;
    // 上一层没过就不进本层:流程还会变时,它用到哪些活动也还会变
    if (!settled.has(id)) continue;

    const lock = repo.lock.services?.[id]?.activity;
    const note = reviewNote(svc.activities.map((aid) => repo.activities.get(aid)));
    const { onlyListed } = activityDirMismatch(repo, id);

    if (!lock) {
      const detail = onlyListed.length
        ? `活动文档缺失: ${onlyListed.join(', ')}`
        : (svc.activities.length ? `已有 ${svc.activities.length} 个活动待确认` : '尚未产出活动文档');
      out.push(row(id, detail + note));
      continue;
    }
    const reasons = [];
    if (onlyListed.length) reasons.push(`活动文档缺失: ${onlyListed.join(', ')}`);
    if (flowsChanged(repo, id)) reasons.push('流程已变更,活动需跟进');
    const dirty = dirtyActivities(repo, id);
    if (dirty.length) reasons.push(dirty.map((d) => `${d.kind} ${d.id.split('.').pop()}`).join(', '));
    if (!reasons.length && !note) { out.push(row(id, '')); continue; }
    out.push(row(id, (reasons.join(';') || '有澄清待结清') + note));
  }
  return out;
}

// ------------------------------------------------------------------ domain

/**
 * 领域模型相对上次确认的变化;没变返回 null。
 * 文档还不存在(被 uses 引用但没设计)同样算「新增」——那正是本层要做的事。
 */
export function domainChange(repo, id) {
  const dom = repo.domains.get(id);
  if (!dom) return '新增';
  const spec = repo.lock.domains?.[id]?.spec;
  if (!spec) return '新增';
  return spec.domain_hash === dom.hash ? null : '修改';
}

function scanDomain(repo) {
  const out = [];
  // 被 uses 引用但还没有文档的:activity 层识别出来的待设计能力
  for (const m of repo.missingDomains) {
    out.push(row(m.id, `尚未产出文档;引用方 ${m.usedBy.join(', ')}`));
  }
  for (const id of [...repo.domains.keys()].sort()) {
    const dom = repo.domains.get(id);
    if (!dom.usedBy.length) continue; // 孤儿告警里报
    const note = isClean(dom.review) ? '' : `;待澄清 ${stateLabel(dom.review)}`;
    // 引用方跟着每一行走:domain 层一次只推进一个模型,拿到 id 就该能直接去读它的引用方,
    // 不必为此把全项目的领域模型清单拉一遍
    const by = `;引用方 ${dom.usedBy.join(', ')}`;
    if (!repo.lock.domains?.[id]?.spec) { out.push(row(id, '文档已产出,待确认' + note + by)); continue; }
    if (domainChange(repo, id)) { out.push(row(id, '确认后又被修改,需重新确认' + note + by)); continue; }
    out.push(row(id, note ? '有澄清待结清' + by : ''));
  }
  return out;
}

// -------------------------------------------------------------------- code

/**
 * 能挡住这个对象的工单归属。三种写法都要认,认漏一种工单就等于没建:
 * migration 工单由 domain 层产出、归属领域模型,活动用到它同样开不了工;
 * manual 工单归属出问题的那个对象;`bp delete plan` 的整服务清理单归属服务。
 */
function todoKeys(repo, t) {
  const keys = new Set([t.id]);
  if (t.isDomain) {
    for (const service of servicesOfDomain(repo, t.obj)) keys.add(service);
  } else {
    keys.add(t.obj.service);
    for (const use of t.obj.uses || []) keys.add(use);
  }
  return keys;
}

/** 已过本层 approve、可以进入实现的对象。 */
function implTargets(repo) {
  const out = [];
  for (const [id, act] of repo.activities) {
    const spec = repo.lock.activities?.[id]?.spec;
    if (spec) out.push({ id, obj: act, spec, impl: repo.lock.activities?.[id]?.impl, isDomain: false });
  }
  for (const [id, dom] of repo.domains) {
    const spec = repo.lock.domains?.[id]?.spec;
    if (spec) out.push({ id, obj: dom, spec, impl: repo.lock.domains?.[id]?.impl, isDomain: true });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * code 层的两组行,动作方不同:
 *
 *   rows      AI 自己能推的(detail 为空即已实现)
 *   blocked   等人的——todo 工单没执行,或表结构还没跟上
 */
export function scanCode(repo, snap = null) {
  const snapshot = snap || loadSnapshot(repo.root);
  const rows = [];
  const blocked = [];
  for (const t of implTargets(repo)) {
    const keys = todoKeys(repo, t);
    const todos = repo.todos.filter((x) => x.owner && keys.has(x.owner));
    if (todos.length) {
      blocked.push(row(t.id, `待人执行 ${todos.map((x) => x.name).join(', ')}`));
      continue;
    }
    // snapshot 从没导出过时不判缺口:空 snapshot 只说明还没跑过 bp snapshot pull db,
    // 不代表库里没有这些表。少了这道守卫,声明了 tables 的项目会整层判成 blocked。
    // 判据与 bp validate 的表结构比对保持一致。
    const gaps = snapshot.exists ? gapsFor(snapshot, t.obj) : [];
    if (gaps.length) {
      blocked.push(row(t.id, `schema 缺 ${gaps.map(gapLabel).join(', ')}`));
      continue;
    }
    // uses 指向的契约还没产出时只在 detail 里标一句,不单开一组:
    // 那批 id 同时也是 domain 层的待办,而 domain 层排在 code 之前,
    // 全局判定走到 code 时它必然已经清空。单独跑 `bp scan code` 才看得到这句话。
    const missing = t.isDomain ? [] : (t.obj.uses || []).filter((u) => !repo.domains.has(u));
    const note = missing.length ? `(领域模型 ${missing.join(', ')} 尚无文档,等 domain 阶段)` : '';

    const key = t.isDomain ? 'domain_hash' : 'activity_hash';
    if (!t.impl) { rows.push(row(t.id, '尚未实现' + note)); continue; }
    if (t.impl[key] !== t.spec[key]) {
      rows.push(row(t.id, (t.isDomain ? '契约已变更,实现需跟进' : '活动文档已变更,实现需跟进') + note));
      continue;
    }
    rows.push(row(t.id, ''));
  }
  // 领域模型先于引用它的活动,同服务内被依赖的活动先于依赖方
  const order = new Map(sortImplQueue(repo, rows.map((r) => r.id)).map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { rows, blocked };
}

function gapLabel(g) {
  return g.kind === 'table' ? g.table : `${g.table}.${g.column}`;
}

/** 同服务内按 depends_on 拓扑排序,让被依赖的活动先实现。 */
function sortImplQueue(repo, ids) {
  const set = new Set(ids);
  const out = [];
  const state = new Map();
  const visit = (id) => {
    if (state.get(id)) return;
    state.set(id, 1);
    for (const dep of repo.activities.get(id)?.depends_on || []) {
      if (set.has(dep)) visit(dep);
    }
    out.push(id);
  };
  // 领域模型先于引用它的活动
  for (const id of [...set].sort((a, b) => {
    const da = a.startsWith('@') ? 0 : 1;
    const db = b.startsWith('@') ? 0 : 1;
    return da - db || a.localeCompare(b);
  })) visit(id);
  return out;
}

// ------------------------------------------------------------------ commit

/**
 * 待提交 = lock.json 有未提交变更,且 lock 里确实有内容。
 *
 * 判据落在 lock.json 而不是整个 blueprint/ 目录:lock 只在 approve 与 code done 时被写,
 * 它变了才说明这一轮真的盖过章。用整个目录判会把 init 刚生成的文件、
 * 人手写的 product 变更都误判成「有产出待提交」。
 */
function hasPendingCommit(root, lock) {
  const hasContent = Object.keys(lock.services || {}).length
    || Object.keys(lock.activities || {}).length
    || Object.keys(lock.domains || {}).length;
  if (!hasContent) return false;
  try {
    const raw = execFileSync('git', ['status', '--porcelain', '--', 'blueprint/lock.json'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.trim().length > 0;
  } catch {
    return false; // 不是 git 仓库,跳过 commit 阶段
  }
}

// -------------------------------------------------------------------- 全局

/**
 * 全项目当前的 stage:沿依赖链正向走,第一个有待办的层就是答案。
 *
 * 返回的 `warnings` 与 `blocked` 都不参与 stage 判定,只是附在输出里给人看:
 * 前者是引用断裂的残留物,后者是等人执行工单的对象。两者都不该拦住 AI 干活。
 */
export function globalStage(repo) {
  const snap = loadSnapshot(repo.root);
  const warnings = scanOrphans(repo);
  const { rows: codeRows, blocked } = scanCode(repo, snap);
  const base = { warnings, blocked };

  for (const [stage, rows] of [
    ['flow', scanFlow(repo)],
    ['activity', scanActivity(repo)],
    ['domain', scanDomain(repo)],
    ['code', codeRows],
  ]) {
    const open = openRows(rows);
    if (open.length) return { ...base, stage, rows: open };
  }

  if (hasPendingCommit(repo.root, repo.lock)) return { ...base, stage: 'commit', rows: [] };

  return { ...base, stage: 'none', rows: [] };
}

/** 按层名取该层的全部行,供 `bp scan <层>` 与各 skill 单独运行时使用。 */
export function scanLayer(repo, layer) {
  if (layer === 'flow') return scanFlow(repo);
  if (layer === 'activity') return scanActivity(repo);
  if (layer === 'domain') return scanDomain(repo);
  if (layer === 'code') return scanCode(repo).rows;
  throw new BpError(`未知的层: ${layer}(可选 ${LAYERS.join(' / ')})`);
}
