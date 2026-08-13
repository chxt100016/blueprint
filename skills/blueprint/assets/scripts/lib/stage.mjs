// stage 判定。整个项目在任一时刻只有一个 stage,它回答的问题只有一个:
// 现在该调哪个 skill。
//
// 取件顺序按依赖链正向推进,新服务排在最后:
//
//   orphaned → blocked → flow → activity → domain → code → commit → 新服务 → ready
//
// 「新服务排最后」是并行开发的替代品:人中途在 product/ 下新写了一个服务,
// 它不会打断当前这一波,而是自动等到整条链清空。
//
// 每层内部的对象状态只有四种,skill 靠它决定这一轮做什么:
//
//   new           文档还没产出,或上游变了需要跟进
//   wait_review   有澄清没答复,或答复了没说落点
//   wait_approve  文档就绪,等人确认盖章
//   complete      已盖章,跳过
//
// 「上游变了但本层还没跟进」与「本层已跟进等确认」的区分,靠比对本层文档自身的哈希:
// 上游哈希对不上而本层文档也变了,说明 skill 已经动过手,进入 wait_approve;
// 本层文档没变,说明还没开始,是 new。
//
// **flow 层是例外,它只有 new / updated 两种状态,粒度是业务服务不是流程。**
// 流程层做过一版逐个流程的四态判定,结果是:同一个服务的几个接口本就要一起想,
// 而状态机把它们拆成互不相干的四条支线,skill 得在支线之间来回跳。
// 现在改成:一个服务一轮,从头走一遍(读 product → 定改哪几个流程 → 改 → 澄清 → 确认),
// 「这个流程到底改没改」由 approve 的准出闸门兜底,不需要在 scan 阶段就分类。
import { execFileSync } from 'node:child_process';
import { servicesOfDomain, flowsHash } from './repo.mjs';
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
  // 服务由 product 文档定义。spec 目录还在而文档没了,多半是人改了 product 里的文件名
  for (const id of [...repo.strayServices].sort()) {
    const svc = repo.services.get(id);
    out.push(row(id, 'error', `${svc.productRel} 不存在,但 ${svc.rel}/ 下已有产出`));
  }
  // 活动归属服务,由流程编排。不被任何流程编排的活动是孤儿
  const stray = new Set(repo.strayServices);
  for (const id of [...repo.activities.keys()].sort()) {
    const act = repo.activities.get(id);
    if (stray.has(act.service)) continue; // 整个服务已在上面报出,不重复刷屏
    const svc = repo.services.get(act.service);
    if (svc?.flows.length && !svc.activityList.some((i) => i.slug === act.slug)) {
      out.push(row(id, 'error', `不被 ${act.service} 的任何流程编排`));
    }
  }
  for (const id of [...repo.domains.keys()].sort()) {
    if (!repo.domains.get(id).usedBy.length) {
      out.push(row(id, 'error', '无任何活动 uses 引用'));
    }
  }
  for (const id of Object.keys(repo.lock.flows || {})) {
    if (!repo.flows.has(id)) out.push(row(id, 'error', 'lock 中有记录但文档不存在'));
  }
  for (const id of Object.keys(repo.lock.activities || {})) {
    if (!repo.activities.has(id)) out.push(row(id, 'error', 'lock 中有记录但文档不存在'));
  }
  for (const id of Object.keys(repo.lock.domains || {})) {
    if (!repo.domains.has(id)) out.push(row(id, 'error', 'lock 中有记录但文档不存在'));
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
 * 流程层按业务服务推进,状态只有两种:
 *
 *   new       这个服务还没在流程层盖过章
 *   updated   盖过章,但 product 描述或某个流程文件之后又变了
 *
 * 不再有 wait_review / wait_approve:澄清没结清时 `bp flow approve` 会自己拒绝,
 * 用不着在 scan 里再表达一次;而「哪个流程该改」是每轮重新判断的业务问题,
 * 记在状态里只会让 skill 以为可以跳过前面的步骤。
 */
export function scanFlow(repo) {
  const out = [];
  for (const id of [...repo.services.keys()].sort()) {
    const svc = repo.services.get(id);
    if (!svc.product) continue; // stray,orphaned 层处理

    const lock = repo.lock.services?.[id]?.flow;
    const dirty = dirtyFlows(repo, id);
    const pending = svc.flows
      .map((fid) => repo.flows.get(fid))
      .filter((f) => f.review && !isClean(f.review));
    const note = pending.length
      ? `;待澄清 ${pending.map((f) => `${f.slug}(${stateLabel(f.review)})`).join(', ')}`
      : '';

    if (!lock) {
      const detail = svc.flows.length ? `已有 ${svc.flows.length} 个流程待确认` : '尚未产出流程';
      // 从没开始过的服务排到下一波,理由见 globalStage
      out.push({ ...row(id, 'new', detail + note), fresh: !svc.flows.length });
      continue;
    }
    const reasons = [];
    if (svc.product.hash !== lock.product_hash) reasons.push('product 已变更');
    if (dirty.length) reasons.push(dirty.map((d) => `${d.kind} ${d.id.split('.').pop()}`).join(', '));
    // 没答复的澄清也算没走完:approve 会拒绝,不在这里放行,否则问题会被静默遗忘
    if (!reasons.length && !pending.length) { out.push(row(id, 'complete', '')); continue; }
    out.push(row(id, 'updated', (reasons.join(';') || '有澄清待结清') + note));
  }
  return out;
}

/** 流程层是否已对该服务盖章且此后无变动。活动层拿它当准入条件。 */
export function flowSettled(repo, serviceId) {
  const hit = scanFlow(repo).find((r) => r.id === serviceId);
  return !!hit && hit.state === 'complete';
}

// ---------------------------------------------------------------- activity

/**
 * 活动层按服务聚合:活动归属服务、被多个流程共用,
 * 一次确认覆盖服务下的全部活动,上游是本服务全部流程的组合哈希。
 */
export function scanActivity(repo) {
  const out = [];
  const settled = new Set(scanFlow(repo).filter((r) => r.state === 'complete').map((r) => r.id));
  for (const id of [...repo.services.keys()].sort()) {
    const svc = repo.services.get(id);
    if (!svc.flows.length) continue;
    // 上一层没过就不进本层:流程还会变时,活动编排也还会变
    if (!settled.has(id)) continue;

    const lock = repo.lock.services?.[id]?.activity;
    const dirs = new Set(svc.activities.map((a) => a.split('.').pop()));
    const missingDirs = svc.activityList.map((i) => i.slug).filter((s) => !dirs.has(s));
    if (missingDirs.length) {
      out.push(row(id, 'new', `活动文档缺失: ${missingDirs.join(', ')}`));
      continue;
    }

    const flowChanged = !lock || flowsHash(repo, id) !== lock.flows_hash;
    let changed = false;
    for (const aid of svc.activities) {
      const act = repo.activities.get(aid);
      const spec = repo.lock.activities?.[aid]?.spec;
      if (!spec || spec.activity_hash !== act.hash) { changed = true; break; }
    }

    if (flowChanged && !changed) {
      out.push(row(id, 'new', lock ? '流程已变更,活动需跟进' : '尚未产出活动文档'));
      continue;
    }
    if (flowChanged || changed) {
      const dirty = svc.activities
        .map((aid) => repo.activities.get(aid))
        .filter((a) => a.review && !isClean(a.review));
      if (dirty.length) {
        out.push(row(id, 'wait_review', dirty.map((a) => `${a.slug}: ${stateLabel(a.review)}`).join('; ')));
        continue;
      }
      out.push(row(id, 'wait_approve', lock ? '活动已更新,等确认' : '首次确认'));
      continue;
    }
    out.push(row(id, 'complete', ''));
  }
  return out;
}

// ------------------------------------------------------------------ domain

export function scanDomain(repo) {
  const out = [];
  // 被 uses 引用但还没有文档的:activity 层识别出来的待设计能力
  for (const m of repo.missingDomains) {
    out.push(row(m.id, 'new', `未设计,引用方 ${m.usedBy.join(', ')}`));
  }
  for (const id of [...repo.domains.keys()].sort()) {
    const dom = repo.domains.get(id);
    if (!dom.usedBy.length) continue; // error
    const spec = repo.lock.domains?.[id]?.spec;
    if (!spec || spec.domain_hash !== dom.hash) {
      if (!isClean(dom.review)) { out.push(row(id, 'wait_review', stateLabel(dom.review))); continue; }
      out.push(row(id, 'wait_approve', spec ? '契约已更新,等确认' : '首次确认'));
      continue;
    }
    out.push(row(id, 'complete', ''));
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
    if (!t.impl) { out.push(row(t.id, 'new', '尚未实现')); continue; }
    if (t.impl[key] !== t.spec[key]) {
      out.push(row(t.id, 'new', t.isDomain ? '契约已更新' : '活动文档已更新'));
      continue;
    }
    out.push(row(t.id, 'complete', ''));
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
 * 全项目当前的 stage。每层取「非 complete」的行,首个非空的层即当前 stage。
 * 全新的业务服务(fresh)从 flow 层里摘出来单独排到最后,保证不打断当前这一波。
 */
export function globalStage(repo) {
  const snap = loadSnapshot(repo.root);

  const orphans = scanOrphans(repo);
  if (orphans.length) return { stage: 'orphaned', rows: orphans };

  const code = scanCode(repo, snap);
  const blocked = code.filter((r) => r.state === 'blocked');
  if (blocked.length) return { stage: 'blocked', rows: blocked };

  // 人中途新写的 product 文档排在下一波:本波还有待办时不列出,免得人记下的新需求
  // 被卷进当前这一波的澄清——flow skill 拿到的清单永远就是「这一波该做的全部」。
  // 想看全部服务的进度用 `bp scan product`。
  const flowAll = scanFlow(repo);
  const flow = flowAll.filter((r) => r.state !== 'complete' && !r.fresh);
  if (flow.length) return { stage: 'flow', rows: flow };

  const activity = scanActivity(repo).filter((r) => r.state !== 'complete');
  if (activity.length) return { stage: 'activity', rows: activity };

  const domain = scanDomain(repo).filter((r) => r.state !== 'complete');
  if (domain.length) return { stage: 'domain', rows: domain };

  // waiting 排除在外:它等的是 domain 层,而 domain 层此刻已经清空,
  // 剩下的 waiting 只可能是 uses 指向了一个谁也没登记的 id,交由 validate 报错
  const codeOpen = code.filter((r) => r.state !== 'complete' && r.state !== 'waiting');
  if (codeOpen.length) return { stage: 'code', rows: codeOpen };

  if (hasPendingCommit(repo.root, repo.lock)) return { stage: 'commit', rows: [] };

  const fresh = flowAll.filter((r) => r.fresh);
  if (fresh.length) return { stage: 'flow', rows: fresh };

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
