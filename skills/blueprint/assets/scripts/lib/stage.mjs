// stage 判定。整个项目在任一时刻只有一个 stage,它回答的问题只有一个:
// 现在该调哪个 skill。
//
// 取件顺序按依赖链正向推进,新锚点排在最后:
//
//   orphaned → blocked → flow → activity → domain → code → commit → 新锚点 → ready
//
// 「新锚点排最后」是并行开发的替代品:人中途往 product 里加了新服务,
// 它不会打断当前这一波,而是自动等到整条链清空。
//
// 每层内部的对象状态只有四种,skill 靠它决定这一轮做什么:
//
//   todo     文档还没产出,或上游变了需要跟进
//   review   有澄清没答复,或答复了没说落点
//   approve  文档就绪,等人确认盖章
//   done     已盖章,跳过
//
// 「上游变了但本层还没跟进」与「本层已跟进等确认」的区分,靠比对本层文档自身的哈希:
// 上游哈希对不上而本层文档也变了,说明 skill 已经动过手,进入 approve;
// 本层文档没变,说明还没开始,是 todo。
import { execFileSync } from 'node:child_process';
import { anchorOf, relatedDomains, missingForService, servicesOfDomain } from './repo.mjs';
import { isClean, stateLabel } from './review.mjs';
import { loadSnapshot, gapsFor } from './db.mjs';

export const STAGES = ['orphaned', 'blocked', 'flow', 'activity', 'domain', 'code', 'commit', 'ready'];
export const LAYERS = ['flow', 'activity', 'domain', 'code'];

/** 每个 stage 对应的动作,pipeline 直接照着执行。 */
export const STAGE_ACTION = {
  orphaned: { by: 'human', text: '停,交人确认清理清单(bp delete plan <id> 生成)' },
  blocked: { by: 'human', text: '停,交人执行 blueprint/todo/ 下的工单' },
  flow: { by: 'skill', skill: 'flow', text: '调用 flow skill' },
  activity: { by: 'skill', skill: 'activity', text: '调用 activity skill' },
  domain: { by: 'skill', skill: 'domain', text: '调用 domain skill' },
  code: { by: 'skill', skill: 'code', text: '调用 code skill' },
  commit: { by: 'skill', skill: 'commit', text: '调用 commit skill' },
  ready: { by: 'none', text: '没有待办' },
};

const row = (id, state, detail = '') => ({ id, state, detail });

// ---------------------------------------------------------------- orphaned

/** 引用关系断裂的对象。多半是重命名造成的,一律交人确认,脚本不自动清理。 */
export function scanOrphans(repo) {
  const out = [];
  for (const id of [...repo.services.keys()].sort()) {
    const svc = repo.services.get(id);
    if (!svc.exists) continue;
    if (!svc.product) { out.push(row(id, 'orphaned', 'flow.md 未声明 product 锚点')); continue; }
    if (!anchorOf(repo, svc.product)) {
      out.push(row(id, 'orphaned', `product 锚点 ${svc.product} 不存在`));
    }
  }
  for (const id of [...repo.activities.keys()].sort()) {
    const act = repo.activities.get(id);
    const svc = repo.services.get(act.service);
    if (svc?.exists && !svc.activityList.some((i) => i.slug === act.slug)) {
      out.push(row(id, 'orphaned', `不在 ${act.service} 的「活动划分」中`));
    }
  }
  for (const id of [...repo.domains.keys()].sort()) {
    if (!repo.domains.get(id).usedBy.length) {
      out.push(row(id, 'orphaned', '无任何活动 uses 引用'));
    }
  }
  for (const id of Object.keys(repo.lock.activities || {})) {
    if (!repo.activities.has(id)) out.push(row(id, 'orphaned', 'lock 中有记录但文档不存在'));
  }
  for (const id of Object.keys(repo.lock.domains || {})) {
    if (!repo.domains.has(id)) out.push(row(id, 'orphaned', 'lock 中有记录但文档不存在'));
  }
  return out;
}

// -------------------------------------------------------------------- flow

/** 未被任何 flow.md 认领的 product 锚点:还没开始的业务服务。 */
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

export function scanFlow(repo) {
  const out = [];
  for (const id of [...repo.services.keys()].sort()) {
    const svc = repo.services.get(id);
    if (!svc.exists) { out.push(row(id, 'todo', '缺少 flow.md')); continue; }

    const lock = repo.lock.services?.[id]?.flow;
    const anchor = anchorOf(repo, svc.product);
    if (!anchor) continue; // orphaned,不在本层处理

    const productChanged = !lock || anchor.anchor.hash !== lock.product_hash;
    const flowChanged = !lock || svc.hash !== lock.flow_hash;

    if (productChanged && !flowChanged) {
      out.push(row(id, 'todo', lock ? 'product 描述已变更,流程需跟进' : '尚未整理流程'));
      continue;
    }
    if (productChanged || flowChanged) {
      if (!isClean(svc.review)) { out.push(row(id, 'review', stateLabel(svc.review))); continue; }
      out.push(row(id, 'approve', lock ? '流程已更新,等确认' : '首次确认'));
      continue;
    }
    out.push(row(id, 'done', ''));
  }
  for (const ref of unclaimedAnchors(repo)) {
    out.push({ ...row(ref, 'todo', 'product 锚点尚未认领'), unclaimed: true });
  }
  return out;
}

// ---------------------------------------------------------------- activity

export function scanActivity(repo) {
  const out = [];
  for (const id of [...repo.services.keys()].sort()) {
    const svc = repo.services.get(id);
    if (!svc.exists) continue;
    // 上一层没过就不进本层:flow 没定死时活动划分还会变
    if (!repo.lock.services?.[id]?.flow) continue;

    const lock = repo.lock.services?.[id]?.activity;
    const dirs = new Set(svc.activities.map((a) => a.split('.').pop()));
    const missingDirs = svc.activityList.map((i) => i.slug).filter((s) => !dirs.has(s));
    if (missingDirs.length) {
      out.push(row(id, 'todo', `活动文档缺失: ${missingDirs.join(', ')}`));
      continue;
    }

    const flowChanged = !lock || svc.hash !== lock.flow_hash;
    let changed = false;
    for (const aid of svc.activities) {
      const act = repo.activities.get(aid);
      const spec = repo.lock.activities?.[aid]?.spec;
      if (!spec || spec.activity_hash !== act.hash) { changed = true; break; }
    }

    if (flowChanged && !changed) {
      out.push(row(id, 'todo', lock ? 'flow 已变更,活动需跟进' : '尚未产出活动文档'));
      continue;
    }
    if (flowChanged || changed) {
      const dirty = svc.activities
        .map((aid) => repo.activities.get(aid))
        .filter((a) => a.review && !isClean(a.review));
      if (dirty.length) {
        out.push(row(id, 'review', dirty.map((a) => `${a.slug}: ${stateLabel(a.review)}`).join('; ')));
        continue;
      }
      out.push(row(id, 'approve', lock ? '活动已更新,等确认' : '首次确认'));
      continue;
    }
    out.push(row(id, 'done', ''));
  }
  return out;
}

// ------------------------------------------------------------------ domain

export function scanDomain(repo) {
  const out = [];
  // 被 uses 引用但还没有文档的:activity 层识别出来的待设计能力
  for (const m of repo.missingDomains) {
    out.push(row(m.id, 'todo', `未设计,引用方 ${m.usedBy.join(', ')}`));
  }
  for (const id of [...repo.domains.keys()].sort()) {
    const dom = repo.domains.get(id);
    if (!dom.usedBy.length) continue; // orphaned
    const spec = repo.lock.domains?.[id]?.spec;
    if (!spec || spec.domain_hash !== dom.hash) {
      if (!isClean(dom.review)) { out.push(row(id, 'review', stateLabel(dom.review))); continue; }
      out.push(row(id, 'approve', spec ? '契约已更新,等确认' : '首次确认'));
      continue;
    }
    out.push(row(id, 'done', ''));
  }
  return out;
}

// -------------------------------------------------------------------- code

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

export function scanCode(repo, snap = null) {
  const snapshot = snap || loadSnapshot(repo.root);
  const out = [];
  for (const t of implTargets(repo)) {
    const services = t.isDomain ? servicesOfDomain(repo, t.obj) : [t.obj.service];
    const todos = repo.todos.filter((x) => x.service && services.includes(x.service));
    if (todos.length) {
      out.push(row(t.id, 'blocked', `待人执行 ${todos.map((x) => x.name).join(', ')}`));
      continue;
    }
    const gaps = gapsFor(snapshot, t.obj);
    if (gaps.length) {
      out.push(row(t.id, 'blocked', `schema 缺 ${gaps.map(gapLabel).join(', ')}`));
      continue;
    }
    // 契约文档还没产出:这是 domain 层的活,不是 blocked。
    // 标成 blocked 会让全局判定卡在 blocked(它排在 domain 之前),
    // 而 blocked 只能由人解决,人却无事可做——domain 层才是出口。
    // waiting 不参与 stage 判定,只在单独运行 code skill 时提示「这个还不能实现」。
    if (!t.isDomain) {
      const missing = (t.obj.uses || []).filter((u) => !repo.domains.has(u));
      if (missing.length) {
        out.push(row(t.id, 'waiting', `领域能力 ${missing.join(', ')} 尚无文档,等 domain 阶段`));
        continue;
      }
    }
    const key = t.isDomain ? 'domain_hash' : 'activity_hash';
    if (!t.impl) { out.push(row(t.id, 'todo', '尚未实现')); continue; }
    if (t.impl[key] !== t.spec[key]) {
      out.push(row(t.id, 'todo', t.isDomain ? '契约已更新' : '活动文档已更新'));
      continue;
    }
    out.push(row(t.id, 'done', ''));
  }
  // 领域能力先于引用它的活动,同服务内被依赖的活动先于依赖方
  const order = new Map(sortImplQueue(repo, out.map((r) => r.id)).map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

function gapLabel(g) {
  return g.kind === 'table' ? g.table : `${g.table}.${g.column}`;
}

/** 同服务内按 depends_on 拓扑排序,让被依赖的活动先实现。 */
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
  // 领域能力先于引用它的活动
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
export function hasPendingCommit(root, lock) {
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
 * 全项目当前的 stage。每层取「非 done」的行,首个非空的层即当前 stage。
 * 新锚点(unclaimed)从 flow 层里摘出来单独排到最后,保证不打断当前这一波。
 */
export function globalStage(repo) {
  const snap = loadSnapshot(repo.root);

  const orphans = scanOrphans(repo);
  if (orphans.length) return { stage: 'orphaned', rows: orphans };

  const code = scanCode(repo, snap);
  const blocked = code.filter((r) => r.state === 'blocked');
  if (blocked.length) return { stage: 'blocked', rows: blocked };

  const flowAll = scanFlow(repo);
  const flow = flowAll.filter((r) => r.state !== 'done' && !r.unclaimed);
  if (flow.length) return { stage: 'flow', rows: flow };

  const activity = scanActivity(repo).filter((r) => r.state !== 'done');
  if (activity.length) return { stage: 'activity', rows: activity };

  const domain = scanDomain(repo).filter((r) => r.state !== 'done');
  if (domain.length) return { stage: 'domain', rows: domain };

  // waiting 排除在外:它等的是 domain 层,而 domain 层此刻已经清空,
  // 剩下的 waiting 只可能是 uses 指向了一个谁也没登记的 id,交由 validate 报错
  const codeTodo = code.filter((r) => r.state !== 'done' && r.state !== 'waiting');
  if (codeTodo.length) return { stage: 'code', rows: codeTodo };

  if (hasPendingCommit(repo.root, repo.lock)) return { stage: 'commit', rows: [] };

  const unclaimed = flowAll.filter((r) => r.unclaimed);
  if (unclaimed.length) return { stage: 'flow', rows: unclaimed };

  return { stage: 'ready', rows: [] };
}

/** 按层名取该层的全部行,供 `bp scan <层>` 与各 skill 单独运行时使用。 */
export function scanLayer(repo, layer) {
  if (layer === 'flow') return scanFlow(repo);
  if (layer === 'activity') return scanActivity(repo);
  if (layer === 'domain') return scanDomain(repo);
  if (layer === 'code') return scanCode(repo);
  throw new Error(`未知的层: ${layer}(可选 ${LAYERS.join(' / ')})`);
}

/** 单个对象在其所属层的状态,供 bp status 用。 */
export function objectState(repo, id) {
  for (const layer of LAYERS) {
    const hit = scanLayer(repo, layer).find((r) => r.id === id);
    if (hit) return { layer, ...hit };
  }
  const orphan = scanOrphans(repo).find((r) => r.id === id);
  if (orphan) return { layer: null, ...orphan };
  return null;
}
