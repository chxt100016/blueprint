import {
  loadLock, missingForService, saveLock, activityReviews, flowsHash,
} from '../../lib/repo.mjs';
import { dirtyFlows } from '../../lib/stage.mjs';
import {
  activityDirMismatch, validateActivity, validateFlow, validateService,
} from '../../lib/schema.mjs';
import { errOut, fail, out } from '../../runtime/cli.mjs';
import { ctx, nowIso } from '../../runtime/context.mjs';
import { serviceOrDie } from '../../runtime/entities.mjs';
import { requireCleanReviews, settleReviews } from '../../runtime/reviews.mjs';
import { printErrors } from '../../runtime/validation.mjs';

export function run(cli, [serviceId]) {
  const { repo } = ctx(cli);
  if (!serviceId) fail('用法: bp activity approve <service>');
  const service = serviceOrDie(repo, serviceId);

  // 活动被本服务的多个流程共用,所以要求全部流程都已定稿才进活动层
  const pending = dirtyFlows(repo, serviceId);
  if (pending.length) {
    fail(`以下业务流程尚未通过 bp flow approve: ${pending.map((d) => `${d.id}(${d.kind})`).join(', ')}`);
  }
  const flowLock = repo.lock.services?.[serviceId]?.flow;
  if (!flowLock) fail(`${serviceId} 尚未通过 bp flow approve`);
  if (!service.product) fail(`${serviceId} 的业务描述 ${service.productRel} 不存在`);
  if (service.product.hash !== flowLock.product_hash) {
    fail(`${service.productRel} 在流程确认之后又被改过,流程需重新过一遍。先跑 bp stage`);
  }

  requireCleanReviews(activityReviews(repo, serviceId));

  // validateService 里的同一条检查只在活动层盖过章之后才跑,首次确认时轮不到它,
  // 所以这里无条件查一遍——判据共用 activityDirMismatch,不是两套实现
  const { onlyListed, onlyDirs } = activityDirMismatch(repo, serviceId);
  if (onlyListed.length || onlyDirs.length) {
    errOut('各流程「业务活动」与活动目录不一致:');
    for (const slug of onlyListed) errOut(`  编排中有但目录缺失: ${slug}`);
    for (const slug of onlyDirs) errOut(`  目录中有但不被任何流程编排: ${slug}`);
    process.exit(1);
  }

  const errors = [...validateService(repo, serviceId)];
  for (const flowId of service.flows) errors.push(...validateFlow(repo, flowId));
  for (const activityId of service.activities) errors.push(...validateActivity(repo, activityId));
  if (errors.length) { printErrors(errors); process.exit(1); }

  const lockData = loadLock(repo.root);
  const approvedAt = nowIso();
  for (const activityId of service.activities) {
    const activity = repo.activities.get(activityId);
    const previous = lockData.activities[activityId] || {};
    lockData.activities[activityId] = {
      ...previous,
      spec: { service: serviceId, activity_hash: activity.hash, approved_at: approvedAt },
    };
  }
  lockData.services[serviceId] = {
    ...(lockData.services[serviceId] || {}),
    activity: { flows_hash: flowsHash(repo, serviceId), approved_at: approvedAt },
  };
  saveLock(repo.root, lockData);

  const settled = settleReviews(activityReviews(repo, serviceId));
  const missing = missingForService(repo, serviceId);
  out(`已确认 ${serviceId} 的 ${service.activities.length} 个业务活动(供 ${service.flows.length} 个流程编排)`);
  if (settled) out(`${settled} 条澄清已存档到各活动澄清记录的「已确认」`);
  if (missing.length) out(`其中登记了 ${missing.length} 个待设计的领域模型:${missing.join(', ')}`);
}
