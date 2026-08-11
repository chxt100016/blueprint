// stage 判定。判定按顺序自上而下,首个命中即为该对象的 stage,不再往下判。
// 一个对象只有一个 stage,scan 的结果只由 lock 与文件系统的当前事实决定。
import { anchorOf, missingForService, serviceReviews } from './repo.mjs';
import { reviewState, humanItems, aiItems, STATE_AI, STATE_HUMAN } from './review.mjs';
import { loadSnapshot, gapsFor } from './db.mjs';

export const SERVICE_STAGES = [
  'orphaned', 'flow_review_ai', 'flow_review_human',
  'activity_review_ai', 'activity_review_human',
  'capability_pending', 'flow_pending', 'activity_pending', 'ready',
];
export const OBJECT_STAGES = ['orphaned', 'blocked', 'impl_pending', 'ready'];

function reviewDetail(entry) {
  const state = reviewState(entry.review);
  const items = state === STATE_AI ? aiItems(entry.review) : humanItems(entry.review);
  const label = entry.kind === 'flow' ? 'flow.review'
    : entry.kind === 'capability' ? entry.label
      : `${entry.label}.review`;
  const verb = state === STATE_AI ? '项待处理' : '项待答复';
  return `${label} ${items.length} ${verb}`;
}

export function serviceStage(repo, id) {
  const svc = repo.services.get(id);
  if (!svc) return { stage: 'orphaned', detail: '服务不存在' };
  const lock = repo.lock.services?.[id];

  // 1. orphaned
  if (svc.exists) {
    if (!svc.product) return { stage: 'orphaned', detail: 'flow.md 未声明 product 锚点' };
    if (!anchorOf(repo, svc.product)) {
      return { stage: 'orphaned', detail: `product 锚点 ${svc.product} 不存在` };
    }
  }

  const reviews = serviceReviews(repo, id);
  const flowReview = reviews.find((r) => r.kind === 'flow');
  const otherReviews = reviews.filter((r) => r.kind !== 'flow');

  // 2 / 3. flow review
  if (flowReview) {
    const state = reviewState(flowReview.review);
    if (state === STATE_AI) return { stage: 'flow_review_ai', detail: reviewDetail(flowReview) };
    if (state === STATE_HUMAN) return { stage: 'flow_review_human', detail: reviewDetail(flowReview) };
  }

  // 4 / 5. activity / capability review
  const aiOne = otherReviews.find((r) => reviewState(r.review) === STATE_AI);
  if (aiOne) return { stage: 'activity_review_ai', detail: reviewDetail(aiOne) };
  const humanOne = otherReviews.find((r) => reviewState(r.review) === STATE_HUMAN);
  if (humanOne) return { stage: 'activity_review_human', detail: reviewDetail(humanOne) };

  // 6. capability_pending
  const missing = missingForService(repo, id);
  if (missing.length) {
    return { stage: 'capability_pending', detail: `${missing.join(', ')} 未设计` };
  }

  // 7. flow_pending
  if (!svc.exists) return { stage: 'flow_pending', detail: '缺少 flow.md' };
  if (!lock || !lock.product_hash) return { stage: 'flow_pending', detail: '服务尚未确认过' };
  const anchor = anchorOf(repo, svc.product);
  if (anchor.anchor.hash !== lock.product_hash) {
    return { stage: 'flow_pending', detail: 'product 描述已变更' };
  }

  // 8. activity_pending
  if (!lock.flow_hash) return { stage: 'activity_pending', detail: '活动尚未确认过' };
  if (svc.hash !== lock.flow_hash) return { stage: 'activity_pending', detail: 'flow 已变更' };
  const listed = svc.activityList.map((i) => i.slug);
  const dirs = new Set(svc.activities.map((a) => a.split('.').pop()));
  const missingDirs = listed.filter((s) => !dirs.has(s));
  if (missingDirs.length) {
    return { stage: 'activity_pending', detail: `活动文档缺失: ${missingDirs.join(', ')}` };
  }
  for (const aid of svc.activities) {
    const act = repo.activities.get(aid);
    const spec = repo.lock.activities?.[aid]?.spec;
    if (!spec) return { stage: 'activity_pending', detail: `${act.slug} 尚未确认` };
    if (spec.activity_hash !== act.hash) return { stage: 'activity_pending', detail: `${act.slug} 已变更` };
  }
  for (const cap of capabilitiesOfService(repo, id)) {
    const spec = repo.lock.capabilities?.[cap.id]?.spec;
    if (!spec) return { stage: 'activity_pending', detail: `${cap.id} 尚未确认` };
    if (spec.capability_hash !== cap.hash) return { stage: 'activity_pending', detail: `${cap.id} 已变更` };
  }

  return { stage: 'ready', detail: '' };
}

function capabilitiesOfService(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  const ids = new Set();
  for (const aid of svc.activities) for (const u of repo.activities.get(aid)?.uses || []) ids.add(u);
  return [...ids].map((i) => repo.capabilities.get(i)).filter(Boolean);
}

function servicesOfCapability(repo, cap) {
  const set = new Set(cap.usedBy.map((a) => a.split('.').slice(0, 2).join('.')));
  const introduced = repo.lock.capabilities?.[cap.id]?.spec?.introduced_by;
  if (introduced) set.add(introduced);
  return [...set];
}

function todoFor(repo, serviceIds) {
  return repo.todos.filter((t) => t.service && serviceIds.includes(t.service));
}

export function objectStage(repo, id, snap) {
  const isCap = String(id).startsWith('@');
  const obj = isCap ? repo.capabilities.get(id) : repo.activities.get(id);
  const lockEntry = isCap ? repo.lock.capabilities?.[id] : repo.lock.activities?.[id];

  // 1. orphaned
  if (!obj) {
    return lockEntry
      ? { stage: 'orphaned', detail: 'lock 中有记录但文档不存在' }
      : { stage: 'orphaned', detail: '对象不存在' };
  }
  if (isCap) {
    if (!obj.usedBy.length) return { stage: 'orphaned', detail: '无任何活动 uses 引用' };
  } else {
    const svc = repo.services.get(obj.service);
    if (svc && svc.exists && !svc.activityList.some((i) => i.slug === obj.slug)) {
      return { stage: 'orphaned', detail: `不在 ${obj.service} 的「活动划分」中` };
    }
  }

  const spec = lockEntry?.spec;
  // 尚未 approve 的对象不进入实现阶段的判定,由服务级的 activity_pending 承担
  if (!spec) return { stage: 'spec_pending', detail: '尚未确认', silent: true };

  // 2. blocked
  const services = isCap ? servicesOfCapability(repo, obj) : [obj.service];
  const todos = todoFor(repo, services);
  if (todos.length) return { stage: 'blocked', detail: `待人执行 ${todos.map((t) => t.name).join(', ')}` };
  const gaps = gapsFor(snap, obj);
  if (gaps.length) {
    return { stage: 'blocked', detail: `schema 缺 ${gaps.map(gapLabel).join(', ')}` };
  }

  // 3. impl_pending
  const impl = lockEntry?.impl;
  const hashKey = isCap ? 'capability_hash' : 'activity_hash';
  if (!impl) return { stage: 'impl_pending', detail: '尚未实现' };
  if (impl[hashKey] !== spec[hashKey]) {
    return { stage: 'impl_pending', detail: isCap ? 'capability 已更新' : 'activity 已更新' };
  }
  if (spec[hashKey] !== obj.hash) {
    return { stage: 'impl_pending', detail: '文档在确认后被改动,需重新确认' };
  }

  return { stage: 'ready', detail: '' };
}

function gapLabel(g) {
  return g.kind === 'table' ? g.table : `${g.table}.${g.column}`;
}

/** 未被任何 flow.md 引用的 product 锚点:尚未开始的服务。 */
export function unclaimedAnchors(repo) {
  const out = [];
  for (const product of repo.products.values()) {
    for (const title of product.anchors.keys()) {
      const ref = `${product.id}#${title}`;
      if (!(repo.anchorUsers.get(ref) || []).length) out.push(ref);
    }
  }
  return out;
}

export function scan(repo) {
  const snap = loadSnapshot(repo.root);
  const services = {};
  const activities = {};
  const capabilities = {};
  const summary = {};
  const bump = (s) => { summary[s] = (summary[s] || 0) + 1; };

  for (const id of [...repo.services.keys()].sort()) {
    const r = serviceStage(repo, id);
    services[id] = r;
    bump(r.stage);
  }
  const actIds = new Set([...repo.activities.keys(), ...Object.keys(repo.lock.activities || {})]);
  for (const id of [...actIds].sort()) {
    const r = objectStage(repo, id, snap);
    if (r.silent) continue;
    activities[id] = { ...r, service: id.split('.').slice(0, 2).join('.') };
    bump(r.stage);
  }
  const capIds = new Set([...repo.capabilities.keys(), ...Object.keys(repo.lock.capabilities || {})]);
  for (const id of [...capIds].sort()) {
    const r = objectStage(repo, id, snap);
    if (r.silent) continue;
    capabilities[id] = r;
    bump(r.stage);
  }
  const unclaimed = unclaimedAnchors(repo);
  const missing = repo.missingCapabilities.map((m) => m.id);
  if (unclaimed.length) summary.unclaimed = unclaimed.length;

  return { services, activities, capabilities, unclaimed, missingCapabilities: missing, summary };
}

/** pipeline 的取件顺序:服务先于对象;impl 队列中能力先于引用它的活动。 */
export function nextTask(result, repo) {
  for (const [id, r] of Object.entries(result.services)) {
    if (r.stage !== 'ready') return { kind: 'service', id, ...r };
  }
  for (const ref of result.unclaimed) {
    return { kind: 'anchor', id: ref, stage: 'unclaimed', detail: '锚点尚无对应服务' };
  }
  const caps = Object.entries(result.capabilities).filter(([, r]) => r.stage !== 'ready');
  const acts = Object.entries(result.activities).filter(([, r]) => r.stage !== 'ready');
  const orphaned = [...caps, ...acts].find(([, r]) => r.stage === 'orphaned');
  if (orphaned) return { kind: 'object', id: orphaned[0], ...orphaned[1] };
  const blocked = [...acts, ...caps].find(([, r]) => r.stage === 'blocked');
  if (blocked) return { kind: 'object', id: blocked[0], ...blocked[1] };
  if (caps.length) return { kind: 'object', id: caps[0][0], ...caps[0][1] };
  if (acts.length) {
    const ids = acts.map(([id]) => id);
    const sorted = sortImplQueue(repo, ids);
    const pick = sorted[0];
    return { kind: 'object', id: pick, ...result.activities[pick] };
  }
  return null;
}

export function sortImplQueue(repo, ids) {
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
  for (const id of [...set].sort()) visit(id);
  return out;
}
