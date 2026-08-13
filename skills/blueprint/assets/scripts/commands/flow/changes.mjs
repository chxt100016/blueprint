import { findSection } from '../../lib/parse.mjs';
import { anchorOf, flowReviews, flowsOfActivity } from '../../lib/repo.mjs';
import { ACTIVITY_MARK } from '../../lib/config.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { flowOrDie } from '../../runtime/entities.mjs';
import { table } from '../../runtime/format.mjs';
import { printResolved } from '../../runtime/reviews.mjs';

export function run(cli, [flowId]) {
  const { repo } = ctx(cli);
  if (!flowId) fail('用法: bp flow changes <flow>');
  const flow = flowOrDie(repo, flowId);
  const lock = repo.lock.flows?.[flowId]?.flow;
  const anchor = anchorOf(repo, flow.product);
  if (!anchor) fail(`product 锚点 ${flow.product} 不存在`);

  const steps = (findSection(flow.sections, '流程')?.body || '')
    .split('\n').filter((line) => /^\d+\./.test(line.trim()));

  const entry = Object.entries(flow.entry || {}).map(([k, v]) => `${k} ${v}`).join('  ');
  out(`业务流程  ${flowId}   ${flow.fm.title || ''}`);
  out(`业务服务  ${flow.service}`);
  out(`商业能力  ${flow.product}`);
  out(`对外接口  ${entry || '(未声明)'}`);
  out('');
  out(`流程步骤  ${steps.length} 步${lock ? (flow.hash !== lock.flow_hash ? '(已变更)' : '') : '(首次确认)'}`);
  out('');
  for (const line of steps) out(`  ${line.trim()}`);
  out('');

  printResolved(flowReviews(repo, flowId));

  // 活动是服务级的,同一个活动可能已被本服务的其他流程编排过。
  // 三种状态要分开显示:人要知道自己确认的是「新写一份活动文档」还是「复用已有的」。
  const known = new Set(
    Object.keys(repo.lock.activities || {})
      .filter((activity) => activity.startsWith(`${flow.service}.${ACTIVITY_MARK}.`))
      .map((activity) => activity.split('.').pop())
  );
  out('活动编排');
  const rows = [];
  for (const item of flow.activityList) {
    const aid = `${flow.service}.${ACTIVITY_MARK}.${item.slug}`;
    const others = flowsOfActivity(repo, aid).filter((fid) => fid !== flowId);
    const state = known.has(item.slug) || others.length ? '复用' : '新增';
    const from = others.length ? `(也被 ${others.map((f) => f.split('.').pop()).join(', ')} 编排)` : '';
    rows.push([`  ${state}`, item.slug, `${item.summary || ''} ${from}`.trim()]);
  }
  table(rows);
}
