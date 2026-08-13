// 待人确认的流程变更。按业务服务打印,因为流程层是按服务一轮一轮走的:
// 人一次看到的应该是「这一轮动了哪几个接口」,不是某一个接口的孤立视图。
import { findSection } from '../../lib/parse.mjs';
import { flowReviews, flowsOfActivity } from '../../lib/repo.mjs';
import { dirtyFlows } from '../../lib/stage.mjs';
import { ACTIVITY_MARK, idKind } from '../../lib/config.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { clip, table } from '../../runtime/format.mjs';
import { printResolved } from '../../runtime/reviews.mjs';

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  if (!id) fail('用法: bp flow changes <service>|<flow>');

  const kind = idKind(id);
  const serviceId = kind === 'flow' ? repo.flows.get(id)?.service : id;
  const service = repo.services.get(serviceId);
  if (!service) fail(`找不到业务服务 ${id}`);
  if (!service.product) fail(`${serviceId} 的业务描述 ${service.productRel} 不存在`);

  // 展开哪几个流程可以按参数缩,但末尾给出的 approve 命令永远按整个服务算:
  // 准出闸门比对的是服务级的变更集合,照着一个残缺的命令去敲必然被拒
  const allDirty = dirtyFlows(repo, serviceId);
  const dirty = allDirty.filter((d) => kind !== 'flow' || d.id === id);
  const lock = repo.lock.services?.[serviceId]?.flow;

  out(`业务服务  ${serviceId}`);
  out(`业务描述  ${service.productRel}${lock && service.product.hash !== lock.product_hash ? '   (已变更)' : ''}`);
  out(`流程总数  ${service.flows.length}`);
  out('');

  if (!allDirty.length) {
    out('本轮没有任何流程文件发生变更。');
    out(`确认「读过新的业务描述、结论是流程不用改」用: bp flow approve ${serviceId}`);
    return;
  }
  if (!dirty.length) {
    out(`${id} 与上次确认时一致,本轮未改动。`);
    out(`本服务本轮实际改动的是: ${allDirty.map((d) => d.id).join(', ')}`);
    return;
  }

  for (const { id: fid, kind: change } of dirty) {
    const flow = repo.flows.get(fid);
    const steps = (findSection(flow.sections, '流程')?.body || '')
      .split('\n').filter((line) => /^\d+\./.test(line.trim()));
    const entry = Object.entries(flow.entry || {}).map(([k, v]) => `${k} ${v}`).join('  ');

    out(`${change}  ${fid}`);
    out(`  概要      ${clip(flow.summary, 44) || '(未写)'}`);
    out(`  对外接口  ${entry || '(未声明)'}`);
    out(`  流程步骤  ${steps.length} 步`);
    out('');
    for (const line of steps) out(`    ${line.trim()}`);
    out('');

    printResolved(flowReviews(repo, fid));

    // 活动是服务级的,同一个活动可能已被本服务的其他流程编排过。
    // 三种状态要分开显示:人要知道自己确认的是「新写一份活动文档」还是「复用已有的」。
    const known = new Set(
      Object.keys(repo.lock.activities || {})
        .filter((activity) => activity.startsWith(`${serviceId}.${ACTIVITY_MARK}.`))
        .map((activity) => activity.split('.').pop())
    );
    out('  活动编排');
    const rows = [];
    for (const item of flow.activityList) {
      const aid = `${serviceId}.${ACTIVITY_MARK}.${item.slug}`;
      const others = flowsOfActivity(repo, aid).filter((other) => other !== fid);
      const state = known.has(item.slug) || others.length ? '复用' : '新增';
      const from = others.length ? `(也被 ${others.map((f) => f.split('.').pop()).join(', ')} 编排)` : '';
      rows.push([`    ${state}`, item.slug, `${item.summary || ''} ${from}`.trim()]);
    }
    table(rows);
    out('');
  }

  const untouched = service.flows.filter((fid) => !allDirty.some((d) => d.id === fid));
  if (untouched.length) {
    out(`本轮未改动  ${untouched.map((fid) => fid.split('.').pop()).join(', ')}`);
    out('');
  }
  out(`通过后执行: bp flow approve ${allDirty.map((d) => d.id).join(' ')}`);
}
