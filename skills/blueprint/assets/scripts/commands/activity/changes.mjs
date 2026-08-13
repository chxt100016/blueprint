import { missingForService, activityReviews, flowsOfActivity } from '../../lib/repo.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { serviceOrDie } from '../../runtime/entities.mjs';
import { table } from '../../runtime/format.mjs';
import { printResolved } from '../../runtime/reviews.mjs';

/** 编排该活动的流程名,共用活动的影响面靠它显示。 */
function usedBy(repo, activityId) {
  const flows = flowsOfActivity(repo, activityId).map((fid) => fid.split('.').pop());
  return flows.length > 1 ? `${flows.length} 个流程: ${flows.join(', ')}` : (flows[0] || '(无)');
}

export function run(cli, [serviceId]) {
  const { repo } = ctx(cli);
  if (!serviceId) fail('用法: bp activity changes <service>');
  const service = serviceOrDie(repo, serviceId);
  const pending = service.flows.filter((fid) => !repo.lock.flows?.[fid]?.flow);
  if (pending.length) fail(`以下业务流程尚未通过 bp flow approve: ${pending.join(', ')}`);

  const added = [];
  const modified = [];
  const unaffected = [];
  for (const activityId of service.activities) {
    const activity = repo.activities.get(activityId);
    const spec = repo.lock.activities?.[activityId]?.spec;
    // 共用活动改一次会同时改变多个接口的行为,影响面必须摆在人眼前
    const row = [`  ${activity.slug}`, activity.summary || activity.fm.title || '', usedBy(repo, activityId)];
    if (!spec) added.push(row);
    else if (spec.activity_hash !== activity.hash) modified.push(row);
    else unaffected.push(row);
  }

  out(`业务服务  ${serviceId}`);
  out(`业务流程  ${service.flows.map((fid) => fid.split('.').pop()).join(', ')}`);
  out('');
  for (const [title, rows] of [['新增', added], ['修改', modified], ['不受影响', unaffected]]) {
    if (!rows.length) continue;
    out(title);
    table(rows);
    out('');
  }

  const missing = missingForService(repo, serviceId);
  if (missing.length) {
    out('待设计的领域能力(activity 只登记引用,设计由 domain 阶段完成)');
    for (const domain of missing) out(`  ${domain}`);
    out('');
  }

  printResolved(activityReviews(repo, serviceId));

  const todos = repo.todos.filter((todo) => todo.service === serviceId);
  if (todos.length) {
    out('数据库变更');
    for (const todo of todos) out(`  ${todo.rel}`);
    out('');
  }
}
