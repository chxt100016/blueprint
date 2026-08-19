// 流程层盖章。两种用法:
//
//   bp flow approve <flow> [<flow>...]   确认这一轮改动的流程,必须**恰好**列全
//   bp flow approve <service>            确认「读过新的业务描述,结论是流程不用改」
//
// 准出闸门:实际发生变更的流程集合必须与命令行给出的集合完全相等。
//
// 这条闸门是流程层唯一的兜底。人在确认门上看到的是 `bp flow changes` 列出的
// 那几个流程,他点「通过」是对那几个流程点的;要是文件里其实还改了别的,盖章就把没人看过的
// 改动一起放行了。多出来的报错好理解;少了也报错——skill 说改了 B 而 B 与上次确认时一字不差,
// 说明它把改动写到了别处,那比多改更危险。
import { loadLock, saveLock, flowReviews } from '../../lib/repo.mjs';
import { dirtyFlows } from '../../lib/stage.mjs';
import { idKind, serviceOf } from '../../lib/config.mjs';
import { validateFlow, validateService } from '../../lib/schema.mjs';
import { errOut, fail, out } from '../../runtime/cli.mjs';
import { ctx, nowIso } from '../../runtime/context.mjs';
import { requireCleanReviews, settleReviews } from '../../runtime/reviews.mjs';
import { printErrors } from '../../runtime/validation.mjs';

const USAGE = `用法: bp flow approve <flow> [<flow>...]   确认本轮改动的流程(要列全)
      bp flow approve <service>            本轮无流程变更,只确认已读过新的业务描述`;

export function run(cli, ids) {
  const { repo } = ctx(cli);
  if (!ids.length) fail(USAGE);

  const kinds = new Set(ids.map(idKind));
  if (kinds.size > 1) fail(`不能把业务服务和业务流程混在一起。\n\n${USAGE}`);

  let serviceId;
  let selected = [];
  if (kinds.has('service')) {
    if (ids.length > 1) fail(`一次只能确认一个业务服务。\n\n${USAGE}`);
    serviceId = ids[0];
  } else if (kinds.has('flow')) {
    selected = [...new Set(ids)];
    const services = new Set(selected.map(serviceOf));
    if (services.size > 1) fail(`一次只能确认同一个业务服务下的流程: ${[...services].join(', ')}`);
    serviceId = [...services][0];
    for (const fid of selected) {
      if (!repo.flows.has(fid)) fail(`找不到业务流程 ${fid}`);
    }
  } else {
    fail(`无法识别 ${ids[0]}。\n\n${USAGE}`);
  }

  const service = repo.services.get(serviceId);
  if (!service) fail(`找不到业务服务 ${serviceId}`);
  if (!service.product) fail(`${serviceId} 的业务描述 ${service.productRel} 不存在,先让人补上或把 spec 目录改名`);
  if (!service.flows.length) fail(`${serviceId} 下还没有任何业务流程文件,先用 bp new ${serviceId}.flow.<name> 建骨架`);

  // 准出:改了的与选中的必须一一对应
  const dirty = dirtyFlows(repo, serviceId);
  const extra = dirty.filter((d) => !selected.includes(d.id));
  const stale = selected.filter((fid) => !dirty.some((d) => d.id === fid));
  if (extra.length || stale.length) {
    // 两条用法失败的出路正相反,提示必须分开写:
    // 服务级失败说明「你以为没改,其实改了」,出路是改用流程级并列全;
    // 流程级失败说明「列漏了或列多了」,出路是核对 changes 再列一次。
    // 共用一段文案时,服务级那条会建议再跑一遍刚刚失败的命令,AI 照做就是死循环。
    if (!selected.length) {
      errOut(`${serviceId} 本轮实际有流程变更,不能用「无流程变更」这条出口盖章:`);
      for (const d of extra) errOut(`  ${d.id}  ${d.kind}`);
      errOut('');
      errOut(`跑 bp flow changes ${serviceId} 核对这些改动,确认后改用:`);
      errOut(`  bp flow approve ${extra.map((d) => d.id).join(' ')}`);
      errOut('这些改动不该存在的话,先把文件改回去,再用本条命令。');
      process.exit(1);
    }
    errOut('本轮确认的流程与实际变更的流程对不上:');
    for (const d of extra) errOut(`  ${d.id}  ${d.kind},但没有列在这条命令里`);
    for (const fid of stale) errOut(`  ${fid}  列在命令里,但内容与上次确认时一致`);
    errOut('');
    errOut(`先跑 bp flow changes ${serviceId} 核对,把实际改动的流程列全再确认。`);
    if (!dirty.length) errOut(`本轮一个流程都没改的话,用 bp flow approve ${serviceId}。`);
    process.exit(1);
  }

  // 澄清按服务查、按服务结清:一轮的边界是服务,这一轮问出来的问题挂在哪个流程上都算这一轮的。
  // 只查选中的会漏掉「问题登记在没改动的流程上」那种情况,而那种问题一旦漏掉就再没人问起。
  const reviews = service.flows.flatMap((fid) => flowReviews(repo, fid));
  requireCleanReviews(reviews);

  // 服务级校验一并跑:「业务活动」与目录的对应关系是跨流程才成立的事实
  const errors = [...validateService(repo, serviceId)];
  for (const fid of service.flows) errors.push(...validateFlow(repo, fid));
  if (errors.length) { printErrors(errors); process.exit(1); }

  const lockData = loadLock(repo.root);
  const approvedAt = nowIso();
  for (const fid of selected) {
    lockData.flows[fid] = {
      ...(lockData.flows[fid] || {}),
      flow: { flow_hash: repo.flows.get(fid).hash, approved_at: approvedAt },
    };
  }
  // 上游哈希记在服务上:业务描述是一份文件一个服务,不按流程各记一份
  lockData.services[serviceId] = {
    ...(lockData.services[serviceId] || {}),
    flow: { product_hash: service.product.hash, approved_at: approvedAt },
  };
  saveLock(repo.root, lockData);

  const settled = settleReviews(reviews);
  if (selected.length) {
    out(`已确认 ${serviceId} 的 ${selected.length} 个业务流程:${selected.map((fid) => fid.split('.').pop()).join(', ')}`);
  } else {
    out(`已确认 ${serviceId}:读过 ${service.productRel} 的当前版本,本轮流程无需改动`);
  }
  if (settled) out(`${settled} 条澄清已存档到各流程澄清记录的「已确认」`);
}
