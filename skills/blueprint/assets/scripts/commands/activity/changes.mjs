import { missingForService, activityReviews, flowsOfActivity, relatedDomains } from '../../lib/repo.mjs';
import { dirtyActivities, dirtyFlows } from '../../lib/stage.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { serviceOrDie } from '../../runtime/entities.mjs';
import { clip, table } from '../../runtime/format.mjs';
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
  const pending = dirtyFlows(repo, serviceId);
  if (pending.length) {
    fail(`以下业务流程尚未通过 bp flow approve: ${pending.map((d) => `${d.id}(${d.kind})`).join(', ')}`);
  }

  const dirty = new Map(dirtyActivities(repo, serviceId).map((d) => [d.id, d.kind]));
  const grouped = new Map([['新增', []], ['修改', []], ['不受影响', []]]);
  for (const activityId of service.activities) {
    const activity = repo.activities.get(activityId);
    // 共用活动改一次会同时改变多个接口的行为,影响面必须摆在人眼前
    const row = [`  ${activity.slug}`, clip(activity.summary, 44) || '(未写概要)', usedBy(repo, activityId)];
    grouped.get(dirty.get(activityId) || '不受影响').push(row);
  }

  out(`业务服务  ${serviceId}`);
  out(`业务流程  ${service.flows.map((fid) => fid.split('.').pop()).join(', ')}`);
  out('');
  for (const [title, rows] of grouped) {
    if (!rows.length) continue;
    out(title);
    table(rows);
    out('');
  }

  const missing = missingForService(repo, serviceId);
  if (missing.length) {
    out('待设计的领域模型(activity 只登记引用,设计由 domain 阶段完成)');
    for (const domain of missing) out(`  ${domain}`);
    out('');
  }

  printResolved(activityReviews(repo, serviceId));

  // 工单归属服务或某个领域模型,两种都要列:migration 工单挂在领域上,它照样卡着本服务
  const owners = new Set([serviceId, ...relatedDomains(repo, serviceId).map((d) => d.id)]);
  const todos = repo.todos.filter((todo) => owners.has(todo.owner));
  if (todos.length) {
    out('数据库变更');
    for (const todo of todos) out(`  ${todo.rel}`);
    out('');
  }
}
