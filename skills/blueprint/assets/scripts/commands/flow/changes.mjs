// 待人确认的流程变更。按业务服务打印,因为流程层是按服务一轮一轮走的:
// 人一次看到的应该是「这一轮动了哪几个接口」,不是某一个接口的孤立视图。
//
// 只报动了哪几个流程,不展开流程内容:内容都在 md 里,报出路径让人自己去读。
// 在这里再抄一遍,人要么不看要么看两遍,而两处措辞迟早漂移。
// 活动的新增与复用同理,那是 bp activity changes 的事。
import { flowReviews } from '../../lib/repo.mjs';
import { dirtyFlows } from '../../lib/stage.mjs';
import { idKind } from '../../lib/config.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { clip } from '../../runtime/format.mjs';
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
    const entry = [flow.fm.type, flow.fm.facade].filter(Boolean).join('  ');

    out(`${change}  ${fid}`);
    out(`  概要      ${clip(flow.summary, 44) || '(未写)'}`);
    out(`  对外接口  ${entry || '(未声明)'}`);
    out(`  文档      ${flow.rel}`);
    out('');

    printResolved(flowReviews(repo, fid));
  }

  const untouched = service.flows.filter((fid) => !allDirty.some((d) => d.id === fid));
  if (untouched.length) {
    out(`本轮未改动  ${untouched.map((fid) => fid.split('.').pop()).join(', ')}`);
    out('');
  }
  out(`通过后执行: bp flow approve ${allDirty.map((d) => d.id).join(' ')}`);
}
