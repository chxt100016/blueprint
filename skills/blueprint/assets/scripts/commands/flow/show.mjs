// `bp flow <id>`:flow 层按 id 取上下文。scan 只给「有哪些待办」,这里给「这一条是什么」。
//
// 服务 id 给的是 flow skill 干一轮活所需的全部事实:人写的业务描述、本层已产出的 service.md、
// 已有流程清单、活动池。散在四条命令里等于让 skill 自己拼上下文,而它拼错的代价是漏读。
import fs from 'node:fs';

import { idKind, ACTIVITY_MARK } from '../../lib/config.mjs';
import { activityPool } from '../../lib/repo.mjs';
import { isClean, stateLabel } from '../../lib/review.mjs';
import { dirtyFlows, productChanged } from '../../lib/stage.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';

const USAGE = '用法: bp flow <serviceId>|<flowId>(子命令见 bp flow changes|approve)';

/** 段落之间要有强分隔:段内嵌的是 md 全文,标题层级会和正文的 ## 混在一起。 */
const band = (title, note) => out(`\n── ${title} ──${note ? `  ${note}` : ''}\n`);

const openReview = (review) => (review && !isClean(review) ? stateLabel(review) : null);

export function run(cli, [id]) {
  if (!id) fail(USAGE);
  const { repo } = ctx(cli);
  const kind = idKind(id);
  if (kind === 'service') return showService(repo, id);
  if (kind === 'flow') return showFlow(repo, id);
  fail(`${id} 不是业务服务或业务流程的 id\n${USAGE}`);
}

function showService(repo, id) {
  const svc = repo.services.get(id);
  if (!svc) fail(`找不到业务服务 ${id}`);
  out(id);

  band('业务描述', svc.productRel + (productChanged(repo, id) ? '   已变更' : ''));
  if (!svc.product) fail(`业务描述 ${svc.productRel} 不存在`);
  out(svc.product.raw.trimEnd());

  band('服务文档', svc.serviceRel);
  out(svc.hasServiceDoc ? fs.readFileSync(svc.servicePath, 'utf8').trimEnd() : '(还没创建)');

  const dirty = new Map(dirtyFlows(repo, id).map((d) => [d.id, d.kind]));
  band('流程', svc.flows.length ? '' : '(无)');
  for (const fid of svc.flows) {
    const flow = repo.flows.get(fid);
    const marks = [dirty.get(fid), openReview(flow.review)].filter(Boolean).join('  ');
    out(`${fid}${marks ? `   ${marks}` : '   已确认'}`);
    out(`  概要  ${flow.summary.split('\n')[0].trim() || '(未写)'}`);
    // 编排给 id 而不是 slug:下一步要拿它去 bp activity / bp new,给 slug 等于让 skill 自己拼
    const orchestrated = flow.activityList.map((a) => `${id}.${ACTIVITY_MARK}.${a.slug}`);
    out(`  编排  ${orchestrated.join('  ') || '(未编排)'}`);
  }

  const pool = activityPool(repo, id);
  band('活动池', pool.length ? '' : '(无)');
  for (const act of pool) {
    out(act.id);
    out(`  概要  ${act.summary.split('\n')[0].trim() || '(未写)'}`);
    out(`  编排  ${act.usedBy.join('  ') || '(无)'}`);
  }
}

function showFlow(repo, id) {
  const flow = repo.flows.get(id);
  if (!flow) fail(`找不到业务流程 ${id}`);
  band('流程文档', flow.rel);
  out(flow.raw);
}
