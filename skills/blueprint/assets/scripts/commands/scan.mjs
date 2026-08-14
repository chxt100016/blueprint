// 各层的待办清单。flow 与 activity 两层是两级结构(业务服务 → 流程 / 活动),
// 因为那两层本来就按服务一轮一轮地推进:skill 拿到一个服务就该拿到它的全部上下文,
// 不该再为「这个服务有哪些流程」「活动池里有什么」多跑几条命令。
import {
  scanLayer, scanCode, openRows, dirtyFlows, dirtyActivities,
  productChanged, flowsChanged, LAYERS,
} from '../lib/stage.mjs';
import { activityPool } from '../lib/repo.mjs';
import { isClean, stateLabel } from '../lib/review.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { clip, pad, table } from '../runtime/format.mjs';

/** 已结清的澄清不占位置:清单只报还等着人的那些。 */
const openReview = (review) => (review && !isClean(review) ? stateLabel(review) : null);

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
    product: svc.productRel,
    product_changed: productChanged(repo, row.id),
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
    // 概要与文件路径要给全:flow skill 判断「这个活动能不能复用」只认这份活动池,
    // 缺了概要它只能凭 slug 猜,缺了路径它得自己去翻目录,两者都越出本层的范围。
    activity_pool: activityPool(repo, row.id).map((item) => ({
      slug: item.slug,
      file: repo.activities.get(item.id)?.rel || null,
      summary: clip(item.summary, 44) || null,
      used_by: item.usedBy,
    })),
  };
}

function printFlow(item) {
  out(item.id);
  out(`  业务描述  ${item.product}${item.product_changed ? '   已变更' : ''}`);
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
      out(`    ${act.slug}`);
      out(`      概要  ${act.summary || '(未写)'}`);
      out(`      文件  ${act.file || '(未产出)'}`);
      out(`      编排  ${act.used_by.join('  ') || '(无)'}`);
    }
  }
  out('');
}

// ---------------------------------------------------------------- activity

/** activity 层的两级清单:业务服务 → 活动池 + 上游的全部流程,形状与 flowDetail 一致。 */
function activityDetail(repo, row) {
  const svc = repo.services.get(row.id);
  // 「新增 / 修改」与 flow 层同名同义,判据也是同一个函数
  const dirty = new Map(dirtyActivities(repo, row.id).map((d) => [d.id, d.kind]));
  return {
    id: row.id,
    service_doc: svc.hasServiceDoc ? svc.serviceRel : null,
    flows_changed: flowsChanged(repo, row.id),
    flows: svc.flows.map((fid) => ({ id: fid, file: repo.flows.get(fid).rel })),
    activities: activityPool(repo, row.id).map((item) => {
      const act = repo.activities.get(item.id);
      return {
        id: item.id,
        slug: item.slug,
        file: act ? act.rel : null,
        summary: clip(item.summary, 44) || null,
        changed: dirty.get(item.id) || null,
        used_by: item.usedBy,
        uses: act ? act.uses : [],
        review: openReview(act?.review),
      };
    }),
  };
}

function printActivity(item) {
  out(item.id);
  out(`  上游流程  ${item.flows.map((f) => f.file).join('  ') || '(无)'}${item.flows_changed ? '   已变更' : ''}`);
  out('  活动');
  for (const act of item.activities) {
    const marks = [act.changed, act.review].filter(Boolean).join('  ');
    out(`    ${act.slug}${marks ? `   ${marks}` : ''}`);
    out(`      概要  ${act.summary || '(未写)'}`);
    out(`      文件  ${act.file || '(未产出)'}`);
    out(`      编排  ${act.used_by.join('  ') || '(无)'}`);
    if (act.uses.length) out(`      引用  ${act.uses.join('  ')}`);
  }
  out('');
}

export function run(cli, [layer]) {
  const { repo } = ctx(cli);
  if (!layer) fail(`用法: bp scan <${LAYERS.join('|')}>(全局进度看 bp stage)`);
  if (!LAYERS.includes(layer)) fail(`未知的层: ${layer}(可选 ${LAYERS.join(' / ')})`);

  // code 层的「等人」那组单独列在末尾:它们的动作方是人,skill 对它们什么也做不了
  const blocked = layer === 'code' ? scanCode(repo).blocked : [];
  const open = openRows(scanLayer(repo, layer));

  if (layer === 'flow' || layer === 'activity') {
    const items = open.map((row) => (layer === 'flow' ? flowDetail : activityDetail)(repo, row));
    if (!items.length) { out(`${layer} 层全部就绪`); return; }
    for (const item of items) (layer === 'flow' ? printFlow : printActivity)(item);
    return;
  }

  if (!open.length && !blocked.length) { out(`${layer} 层全部就绪`); return; }
  if (open.length) table(open.map((row) => [row.id, row.detail]));
  else out(`${layer} 层没有可做的对象`);
  if (blocked.length) {
    out('');
    out(`等人处理(跳过,不阻断本层完成):`);
    table(blocked.map((row) => [`  ${row.id}`, row.detail]));
  }
}
