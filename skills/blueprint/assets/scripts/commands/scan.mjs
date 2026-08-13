// 各层的待办清单。flow 与 activity 两层是两级结构(业务服务 → 流程 / 活动),
// 因为那两层本来就按服务一轮一轮地推进:skill 拿到一个服务就该拿到它的全部上下文,
// 不该再为「这个服务有哪些流程」「活动池里有什么」多跑几条命令——
// 那正是原先 `bp status` 的活,合并进来之后它就没有存在的理由了。
import { globalStage, scanLayer, dirtyFlows, STAGE_ACTION, LAYERS } from '../lib/stage.mjs';
import { activityPool, byCapability } from '../lib/repo.mjs';
import { isClean, stateLabel } from '../lib/review.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { clip, pad, table } from '../runtime/format.mjs';

/** 已结清的澄清不占位置:清单只报还等着人的那些。 */
const openReview = (review) => (review && !isClean(review) ? stateLabel(review) : null);

// ----------------------------------------------------------------- product

/** 全部业务服务及其流程层状态,按商业能力分组。看全局进度用它。 */
function scanProduct(repo) {
  const state = new Map(scanLayer(repo, 'flow').map((row) => [row.id, row]));
  let count = 0;
  for (const [capability, ids] of byCapability(repo)) {
    out(`${capability}/`);
    for (const id of ids) {
      const svc = repo.services.get(id);
      const hit = state.get(id);
      count++;
      out(`  ${pad(svc.slug, 26)}${pad(hit ? hit.state : 'error', 10)}${svc.flows.length} 个流程   ${hit?.detail || (svc.product ? '' : svc.productRel + ' 不存在')}`);
      for (const fid of svc.flows) {
        const flow = repo.flows.get(fid);
        out(`    ${pad(flow.slug, 24)}${pad(entryText(flow.entry), 26)}${clip(flow.summary, 44)}`);
      }
    }
  }
  if (!count) out('blueprint/product/ 下还没有业务服务(路径形如 product/<商业能力>/<业务服务>.md)');
}

// -------------------------------------------------------------------- flow

/** 骨架期 entry.api 可以是空值,别把它渲染成字面的 null。 */
const entryText = (entry) => Object.entries(entry || {})
  .map(([k, v]) => `${k} ${v === null || v === undefined || v === '' ? '(未填)' : v}`)
  .join('  ') || '(未声明)';

/**
 * flow 层的两级清单:业务服务 → 该服务的全部流程 + 活动池。
 *
 * 列的是**全部**流程而不只是变更过的:这一层每轮都要重新判断「该改哪几个」,
 * 只给变更过的等于替 skill 做了那个判断,而它做那个判断的依据正是这份全景。
 */
function flowDetail(repo, row) {
  const svc = repo.services.get(row.id);
  const dirty = new Map(dirtyFlows(repo, row.id).map((d) => [d.id, d.kind]));
  return {
    id: row.id,
    state: row.state,
    detail: row.detail,
    product: svc.productRel,
    service_doc: svc.hasServiceDoc ? svc.serviceRel : null,
    flows: svc.flows.map((fid) => {
      const flow = repo.flows.get(fid);
      return {
        id: fid,
        file: flow.rel,
        summary: clip(flow.summary, 44) || null,
        entry: flow.entry || {},
        changed: dirty.get(fid) || null,
        review: openReview(flow.review),
        activities: flow.activityList.map((item) => ({ slug: item.slug, summary: item.summary })),
      };
    }),
    activity_pool: activityPool(repo, row.id).map((item) => ({
      slug: item.slug,
      has_doc: item.hasDoc,
      used_by: item.usedBy.map((fid) => fid.split('.').pop()),
    })),
  };
}

function printFlow(item) {
  out(`${pad(item.id, 30)}${pad(item.state, 10)}${item.detail || ''}`);
  out(`  业务描述  ${item.product}`);
  out(`  服务文档  ${item.service_doc || '(未建 service.md)'}`);
  if (!item.flows.length) {
    out('  流程      (无)');
  } else {
    out('  流程');
    for (const flow of item.flows) {
      const marks = [flow.changed, flow.review].filter(Boolean).join('  ');
      out(`    ${pad(flow.id.split('.').pop(), 22)}${pad(entryText(flow.entry), 26)}${marks || '已确认'}`);
      out(`      概要  ${clip(flow.summary, 44) || '(未写)'}`);
      out(`      文件  ${flow.file}`);
      if (flow.activities.length) {
        out(`      编排  ${flow.activities.map((a) => a.slug).join(', ')}`);
      }
    }
  }
  if (item.activity_pool.length) {
    out('  活动池');
    for (const act of item.activity_pool) {
      out(`    ${pad(act.slug, 22)}${pad(act.has_doc ? '有文档' : '缺文档', 10)}${act.used_by.join(', ')}`);
    }
  }
  out('');
}

// ---------------------------------------------------------------- activity

/** activity 层的两级清单:业务服务 → 活动池 + 上游的全部流程。 */
function activityDetail(repo, row) {
  const svc = repo.services.get(row.id);
  return {
    id: row.id,
    state: row.state,
    detail: row.detail,
    service_doc: svc.hasServiceDoc ? svc.serviceRel : null,
    flows: svc.flows.map((fid) => ({ id: fid, file: repo.flows.get(fid).rel })),
    activities: activityPool(repo, row.id).map((item) => {
      const act = repo.activities.get(item.id);
      const spec = repo.lock.activities?.[item.id]?.spec;
      return {
        id: item.id,
        slug: item.slug,
        file: act ? act.rel : null,
        summary: clip(item.summary, 44),
        state: !act ? '待产出' : (!spec ? '未确认' : (spec.activity_hash === act.hash ? '已确认' : '已变更')),
        used_by: item.usedBy.map((fid) => fid.split('.').pop()),
        uses: act ? act.uses : [],
        review: openReview(act?.review),
      };
    }),
  };
}

function printActivity(item) {
  out(`${pad(item.id, 30)}${pad(item.state, 12)}${item.detail || ''}`);
  out(`  上游流程  ${item.flows.map((f) => f.file).join('  ') || '(无)'}`);
  out('  活动');
  for (const act of item.activities) {
    out(`    ${pad(act.slug, 22)}${pad(act.state, 10)}${act.used_by.join(', ')}${act.review ? '   ' + act.review : ''}`);
    if (act.summary) out(`      ${clip(act.summary, 44)}`);
  }
  out('');
}

// -------------------------------------------------------------------- 总览

function scanOverview(repo) {
  const result = globalStage(repo);
  const rows = [];
  for (const layer of LAYERS) {
    const all = scanLayer(repo, layer);
    const open = all.filter((row) => row.state !== 'complete');
    const by = {};
    for (const row of open) by[row.state] = (by[row.state] || 0) + 1;
    const detail = Object.entries(by).map(([key, count]) => `${key} ${count}`).join('  ') || '全部就绪';
    rows.push([layer, `${all.length - open.length}/${all.length} complete`, detail]);
  }
  table(rows);
  out('');
  out(`当前 stage  ${result.stage}   ${STAGE_ACTION[result.stage].text}`);
}

export function run(cli, [layer]) {
  const { repo } = ctx(cli);
  if (!layer) return scanOverview(repo);
  if (layer === 'product') return scanProduct(repo);
  if (!LAYERS.includes(layer)) fail(`未知的层: ${layer}(可选 product / ${LAYERS.join(' / ')})`);

  const rows = scanLayer(repo, layer);
  const open = cli.flag('all') ? rows : rows.filter((row) => row.state !== 'complete');

  if (layer === 'flow' || layer === 'activity') {
    const detail = layer === 'flow' ? flowDetail : activityDetail;
    const items = open.map((row) => detail(repo, row));
    if (cli.flag('json')) { out(JSON.stringify(items, null, 2)); return; }
    if (!items.length) { out(`${layer} 层全部就绪`); return; }
    for (const item of items) (layer === 'flow' ? printFlow : printActivity)(item);
    return;
  }

  if (cli.flag('json')) { out(JSON.stringify(open, null, 2)); return; }
  if (!open.length) { out(`${layer} 层全部就绪`); return; }
  table(open.map((row) => [row.id, row.state, row.detail || '']));
}
